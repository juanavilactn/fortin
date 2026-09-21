import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  STARTED_AT_LOGIN_FLAG,
  getHelperSourcePath,
  isPackagedExecutable,
  run,
  runStreaming,
  runSync,
  whichSync,
} from './index.js';

const PROGRAM_DATA = process.env.ProgramData || 'C:\\ProgramData';
const INSTALLED_CLIENT = path.join(PROGRAM_DATA, 'fortin', 'openfortivpn.exe');
const PRODUCT_NAME = 'Fortin';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = PRODUCT_NAME;

/**
 * Windows has no built-in tool that stores a secret (cmdkey records a
 * credential but takes no password), so this store reports itself as
 * unavailable. Secrets stay in the configuration file with mode 0600, with the
 * warning the callers write to the log and to the window.
 */
const win32Secrets = {
  info() {
    return {
      id: 'none',
      label: 'the configuration file',
      available: false,
      reason: 'the Windows Credential Manager is not wired yet',
    };
  },

  get() {
    return '';
  },

  has() {
    return false;
  },

  set() {
    throw new Error('This platform has no secret store');
  },

  remove() {},
};

function systemRoot() {
  return process.env.SystemRoot || 'C:\\Windows';
}

/* --------------------------------------------------------------- login item */

/**
 * Executable the entry launches: the packaged binary of this process, or the
 * installed application. A development run (`electron .`, `node src/cli.js`)
 * is neither, so it writes no entry.
 */
function loginItemExecutable({
  execPath = process.execPath,
  exists = fs.existsSync,
  localAppData = process.env.LOCALAPPDATA,
  programFiles = process.env['ProgramFiles'],
} = {}) {
  if (/\.exe$/i.test(execPath) && isPackagedExecutable(execPath) && exists(execPath)) return execPath;

  const candidates = [];
  if (localAppData) candidates.push(path.join(localAppData, 'Programs', PRODUCT_NAME, `${PRODUCT_NAME}.exe`));
  if (programFiles) candidates.push(path.join(programFiles, PRODUCT_NAME, `${PRODUCT_NAME}.exe`));
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The Run value of the user is the login item of Windows here: `reg query`
 * reads it, `reg add` writes it and `reg delete` removes it, all without the
 * Credential Manager and without Electron. The value carries the executable in
 * quotes and the argument the application recognises as a login start.
 */
function loginItemStatus(env = {}) {
  const call = env.run ?? ((command, args) => runSync(command, args));
  try {
    const stdout = call('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE]);
    const match = /REG_SZ\s+(.*)$/m.exec(String(stdout ?? ''));
    if (!match) return { ok: true, enabled: false, mechanism: 'run-key', message: '', reason: 'absent' };
    const value = match[1].trim();
    const quoted = /^"([^"]+)"/.exec(value);
    return {
      ok: true,
      enabled: true,
      mechanism: 'run-key',
      message: '',
      target: quoted ? quoted[1] : value.split(' ')[0],
    };
  } catch {
    // reg query exits with a non-zero code when the value does not exist.
    return { ok: true, enabled: false, mechanism: 'run-key', message: '', reason: 'absent' };
  }
}

function setLoginItem(enabled, env = {}) {
  const call = env.run ?? ((command, args) => runSync(command, args));

  if (enabled !== true) {
    try {
      call('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    } catch {
      // Nothing to remove.
    }
    const check = loginItemStatus(env);
    if (check.enabled === true) {
      return { ok: false, enabled: true, mechanism: 'run-key', message: 'The system did not apply the login item.' };
    }
    return { ok: true, enabled: false, mechanism: 'run-key', message: '' };
  }

  const executable = loginItemExecutable(env);
  if (!executable) {
    return { ok: true, enabled: false, mechanism: 'none', message: '', reason: 'no-application' };
  }

  call('reg.exe', [
    'add',
    RUN_KEY,
    '/v', RUN_VALUE,
    '/t', 'REG_SZ',
    '/d', `"${executable}" ${STARTED_AT_LOGIN_FLAG}`,
    '/f',
  ]);

  const check = loginItemStatus(env);
  if (check.enabled !== true) {
    return { ok: false, enabled: false, mechanism: 'run-key', message: 'The system did not apply the login item.' };
  }
  return { ok: true, enabled: true, mechanism: 'run-key', message: '', target: executable };
}

function powershellBinary() {
  return whichSync('powershell.exe') || path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function tasklistBinary() {
  return path.join(systemRoot(), 'System32', 'tasklist.exe');
}

// openfortivpn.exe bundled next to the scripts, installed under ProgramData, or on PATH.
export function resolveClientPath() {
  const candidates = [
    path.join(getHelperSourcePath('win32'), 'openfortivpn.exe'),
    INSTALLED_CLIENT,
    whichSync('openfortivpn.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function clientVersion(binary) {
  try {
    const stdout = runSync(binary, ['--version']);
    return { ok: true, version: stdout.trim().split('\n')[0] || null, message: null };
  } catch (error) {
    return { ok: false, version: null, message: `Cannot run ${binary}: ${error.message}` };
  }
}

/**
 * A failed start rejects with the whole command line, cookie included, and that
 * message reaches the log and the window. Keep the secret out of it.
 */
function maskCookie(message, cookie) {
  const secret = String(cookie ?? '');
  if (secret === '') return message;
  return String(message).split(secret).join('***');
}

export const win32Provider = {
  id: 'win32',
  helperPath: getHelperSourcePath('win32'),
  secrets: win32Secrets,
  loginItem: {
    supported: true,
    mechanism: 'run-key',
    executable: loginItemExecutable,
    status: loginItemStatus,
    set: setLoginItem,
  },

  // En Windows no hay equivalente a sudoers: connect.ps1 lanza openfortivpn con
  // el diálogo de UAC (Start-Process -Verb RunAs) en cada conexión. El helper
  // está "listo" cuando el cliente está disponible.
  async helperReady() {
    return Boolean(resolveClientPath());
  },

  async installHelper({ onLog } = {}) {
    const script = getHelperSourcePath('win32', 'install-win.ps1');
    if (!fs.existsSync(script)) {
      throw new Error(`Helper installer not found: ${script}`);
    }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
    return runStreaming(powershellBinary(), args, { onLog });
  },

  async ensureClient() {
    const client = resolveClientPath();
    if (client) {
      const version = clientVersion(client);
      if (version.ok) return version;
    }

    return {
      ok: false,
      version: null,
      message: 'openfortivpn.exe is not installed. Windows needs the TAP driver and the openfortivpn.exe binary',
    };
  },

  async connect({ server, port, cookie, trustedCert, realm, onData }) {
    const script = getHelperSourcePath('win32', 'connect.ps1');
    if (!fs.existsSync(script)) {
      throw new Error(`Connect script not found: ${script}`);
    }

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Server',
      String(server),
      '-Port',
      String(port),
      '-Cookie',
      String(cookie),
      '-TrustedCert',
      trustedCert || 'any',
      '-Realm',
      realm || '',
    ];

    let result;
    try {
      result = await run(powershellBinary(), args);
    } catch (error) {
      throw new Error(maskCookie(error?.message ?? String(error), cookie));
    }

    const { stdout, stderr } = result;
    if (onData) {
      for (const chunk of [stdout, stderr]) {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim() !== '') onData(line);
        }
      }
    }

    const match = stdout.match(/PID=(\d+)/);
    if (!match) {
      const detail = stderr.trim() || stdout.trim() || 'connect.ps1 produced no output';
      throw new Error(`Could not start openfortivpn with elevated privileges: ${detail}`);
    }
    return { pid: Number(match[1]) };
  },

  async stop() {
    const script = getHelperSourcePath('win32', 'stop.ps1');
    if (!fs.existsSync(script)) return false;
    try {
      await run(powershellBinary(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]);
      return true;
    } catch {
      return false;
    }
  },

  async isVpnRunning() {
    try {
      const { stdout } = await run(tasklistBinary(), ['/FI', 'IMAGENAME eq openfortivpn.exe', '/NH']);
      return /openfortivpn\.exe/i.test(stdout);
    } catch {
      return false;
    }
  },

  /**
   * Windows has no point-to-point interface name to check: openfortivpn drives a
   * TAP adapter, so the process is the best signal available here.
   */
  async isTunnelUp() {
    return this.isVpnRunning();
  },

  /** Holds an execution-state assertion through a helper process. */
  startKeepAwake() {
    const script = getHelperSourcePath('win32', 'keep-awake.ps1');
    if (!fs.existsSync(script)) return null;

    const child = spawn(
      powershellBinary(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { stdio: 'ignore' },
    );
    child.on('error', () => {});

    return {
      stop() {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      },
    };
  },
};
