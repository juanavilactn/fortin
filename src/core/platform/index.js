import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { darwinProvider } from './darwin.js';
import { linuxProvider } from './linux.js';
import { win32Provider } from './win32.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Service every secret is filed under in the store of the operating system.
 * The account is the secret name, so the same value is a different item per
 * field and the CLI finds what the application wrote.
 */
export const SECRETS_SERVICE = 'fortin';

/**
 * Argument the login entries pass, so a login start is recognisable everywhere.
 * It lives here, next to the providers that write the entries, because the
 * providers and src/core/login-item.js both need it and a cycle between them
 * would be worse than this constant being a little out of its module.
 */
export const STARTED_AT_LOGIN_FLAG = '--started-at-login';

// Funcion y no constante: los proveedores importan este modulo y lo usan al
// evaluarse, mientras el ciclo de importacion todavia no ha inicializado las
// constantes.
function packageRoot() {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

/**
 * Directorio con los scripts privilegiados.
 *
 * La app empaquetada los copia a process.resourcesPath/helper (ver
 * electron-builder.yml, extraResources). Desde un checkout sin empaquetar se
 * usan los del repositorio, de forma que src/cli.js funciona igual.
 */
export function getHelperSourceDir() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'helper'));
  }
  candidates.push(path.join(packageRoot(), 'resources', 'helper'));

  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

export function getHelperSourcePath(...segments) {
  return path.join(getHelperSourceDir(), ...segments);
}

export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isExecutableFile(target) {
  if (!target) return false;
  try {
    const stats = fs.statSync(target);
    if (!stats.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the path names the executable of a packaged build, and never a
 * development binary: the Electron of node_modules (`electron .`), a bare
 * interpreter (`node src/cli.js`) or anything else a checkout runs.
 *
 * The login item uses it for the same reason the desktop application used
 * `app.isPackaged`: an entry that launches a development binary starts nothing
 * useful when the user logs in.
 */
export function isPackagedExecutable(execPath = process.execPath) {
  if (typeof execPath !== 'string' || execPath === '') return false;
  if (/[\\/]node_modules[\\/]/.test(execPath)) return false;
  const base = path.basename(execPath).toLowerCase();
  return !['electron', 'electron.exe', 'node', 'node.exe'].includes(base);
}

/** Application bundle that owns an executable on macOS, or null. */
export function bundleOf(execPath) {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath ?? ''));
  return match ? match[1] : null;
}

export function whichSync(name) {
  const pathValue = process.env.PATH || '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const names = path.extname(name) ? [name] : extensions.map((extension) => `${name}${extension}`);
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export async function run(command, args, { env, timeout = 0, cwd } = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

export function runSync(command, args, { env, cwd, input, timeout } = {}) {
  const stdout = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: MAX_OUTPUT_BYTES,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    timeout,
  });
  return stdout ?? '';
}

/**
 * Ejecuta un proceso transmitiendo su salida linea a linea por onLog.
 * Rechaza cuando el proceso termina con un codigo distinto de cero.
 */
export function runStreaming(command, args, { onLog, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });

    const output = [];
    const emit = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      if (onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() !== '') onLog(line);
        }
      }
    };

    child.stdout.on('data', emit);
    child.stderr.on('data', emit);

    child.on('error', (error) => {
      reject(new Error(`Cannot run ${command}: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      const tail = output.join('').trim();
      if (code === 0) {
        resolve({ code, output: tail });
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      reject(new Error(tail ? `${command} exited with ${reason}: ${tail}` : `${command} exited with ${reason}`));
    });
  });
}

/**
 * Lanza un proceso en segundo plano. Los procesos detached van sin tuberias
 * para que sigan vivos (el tunel) cuando la app se cierra.
 */
export function spawnProcess(command, args, { detached = false, onData, onExit, env, cwd, outputFile } = {}) {
  // A detached tunnel keeps running when the app closes, so its output cannot
  // go to a pipe. Send it to a file instead: without it a failed tunnel start
  // fails silently.
  let stdio = detached ? 'ignore' : ['ignore', 'pipe', 'pipe'];
  let outputDescriptor = null;
  if (detached && outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    outputDescriptor = fs.openSync(outputFile, 'a');
    stdio = ['ignore', outputDescriptor, outputDescriptor];
  }

  const child = spawn(command, args, {
    detached,
    cwd,
    stdio,
    env: env ? { ...process.env, ...env } : process.env,
  });

  if (outputDescriptor !== null) {
    child.once('spawn', () => {
      try {
        fs.closeSync(outputDescriptor);
      } catch {
        // The child already owns the descriptor.
      }
    });
  }

  if (!detached && onData) {
    const push = (chunk) => onData(chunk.toString());
    child.stdout.on('data', push);
    child.stderr.on('data', push);
  }
  if (onExit) {
    child.on('exit', (code, signal) => onExit(code, signal));
  }
  if (detached) {
    child.unref();
  }

  return child;
}

/**
 * Interfaz Provider:
 *   id, helperPath,
 *   helperReady() -> boolean,
 *   installHelper({onLog, useGui}) -> void,
 *   ensureClient() -> {ok, version, message},
 *   connect({server, port, cookie, trustedCert, realm, detached, onData, onExit}) -> {pid},
 *   stop() -> boolean,
 *   isVpnRunning() -> boolean
 *   secrets -> {info, get, has, set, remove} (almacen de secretos del sistema)
 *   loginItem -> {supported, mechanism, status(env), set(enabled, env)} o null
 *
 * onExit solo se invoca en los sistemas donde el proceso del tunel es hijo
 * directo de la app (darwin y linux en modo primer plano).
 *
 * loginItem es el mecanismo con el que el sistema arranca la aplicacion al
 * iniciar sesion. Vive en el proveedor porque es distinto en cada plataforma:
 * un LaunchAgent en macOS, el fichero XDG de autostart en Linux y un valor de
 * `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` en Windows. Las tres
 * implementaciones reciben el mismo `env` ({execPath, homeDir, uid, exists, run})
 * para que una prueba pueda apuntarlas a un HOME temporal y a un `launchctl`
 * falso, y devuelven {ok, enabled, mechanism, message} sin lanzar nunca.
 */
/**
 * Funcion y no constante: los proveedores importan este modulo, asi que el mapa
 * se lee despues de que los tres modulos hayan terminado de evaluarse, nunca
 * mientras el ciclo de importacion todavia esta a medias.
 */
function providers() {
  return {
    darwin: darwinProvider,
    linux: linuxProvider,
    win32: win32Provider,
  };
}

export function getProvider(platform = process.platform) {
  const provider = providers()[platform];
  if (!provider) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return provider;
}
