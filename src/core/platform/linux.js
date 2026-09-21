import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SECRETS_SERVICE,
  STARTED_AT_LOGIN_FLAG,
  getHelperSourcePath,
  isPackagedExecutable,
  run,
  runStreaming,
  runSync,
  spawnProcess,
  whichSync,
} from './index.js';

const HELPER_PATH = '/usr/local/libexec/fortin-helper';
const SECRET_TOOL = 'secret-tool';
/** A stalled store must not hang the caller: it answers in milliseconds. */
const SECRETS_TIMEOUT_MS = 10000;
const AUTOSTART_FILE_NAME = 'fortin.desktop';
const PRODUCT_NAME = 'Fortin';

function secretTool() {
  return whichSync(SECRET_TOOL);
}

/**
 * freedesktop secret store through secret-tool (libsecret), filed under
 * SECRETS_SERVICE with the secret name as an attribute. The value reaches
 * secret-tool on stdin, never as a command line argument.
 *
 * The tool is not part of every distribution, so an absent secret-tool is a
 * normal case: the store reports itself as unavailable and the callers fall
 * back to the configuration file with a warning.
 */
const linuxSecrets = {
  info() {
    const available = Boolean(secretTool());
    return {
      id: 'secret-tool',
      label: 'the system secret store',
      available,
      reason: available ? '' : SECRET_TOOL + ' is not installed (package libsecret-tools)',
    };
  },

  /** Stored value, or an empty string when there is no item for that account. */
  get(account) {
    if (!secretTool()) return '';
    try {
      const output = runSync(
        SECRET_TOOL,
        ['lookup', 'service', SECRETS_SERVICE, 'account', account],
        { timeout: SECRETS_TIMEOUT_MS },
      );
      return output.replace(/\n$/, '');
    } catch (error) {
      // secret-tool exits with 1 when no item matches the attributes.
      if (error?.status === 1) return '';
      throw error;
    }
  },

  has(account) {
    return linuxSecrets.get(account) !== '';
  },

  /** Creates or updates the item. Throws when the store does not take it. */
  set(account, value) {
    const text = String(value);
    runSync(
      SECRET_TOOL,
      ['store', '--label', 'Fortin (' + account + ')', 'service', SECRETS_SERVICE, 'account', account],
      { input: text + '\n', timeout: SECRETS_TIMEOUT_MS },
    );
    if (linuxSecrets.get(account) !== text) {
      throw new Error('The secret store did not store the ' + account + ' item');
    }
  },

  remove(account) {
    if (!secretTool()) return;
    try {
      runSync(
        SECRET_TOOL,
        ['clear', 'service', SECRETS_SERVICE, 'account', account],
        { timeout: SECRETS_TIMEOUT_MS },
      );
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
  },
};

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/* --------------------------------------------------------------- login item */

function autostartFile(homeDir, { xdgConfigHome = process.env.XDG_CONFIG_HOME } = {}) {
  const configHome = String(xdgConfigHome ?? '').trim() || path.join(homeDir, '.config');
  return path.join(configHome, 'autostart', AUTOSTART_FILE_NAME);
}

/**
 * Executable the entry launches: the AppImage in use (it runs from a temporary
 * mount, so the file that starts the application is the AppImage itself), the
 * packaged binary of this process, or the installed one. A development run is
 * none of those and writes no entry.
 */
function loginItemExecutable({
  execPath = process.execPath,
  exists = fs.existsSync,
  appImage = process.env.APPIMAGE,
} = {}) {
  if (appImage && exists(appImage)) return appImage;
  if (isPackagedExecutable(execPath) && exists(execPath)) return execPath;

  for (const candidate of [
    path.join('/opt', PRODUCT_NAME, PRODUCT_NAME),
    path.join('/opt', PRODUCT_NAME, 'fortin'),
  ]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** JSON escaping of the backslash and the quote is what Exec wants inside quotes. */
function desktopQuote(value) {
  return JSON.stringify(String(value));
}

function autostartBody(executable) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${PRODUCT_NAME}`,
    `Comment=Start ${PRODUCT_NAME} when the user logs in`,
    'Exec=' + desktopQuote(executable) + ' ' + STARTED_AT_LOGIN_FLAG,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function loginItemStatus(env = {}) {
  const { homeDir = os.homedir() } = env;
  const file = autostartFile(homeDir, env);
  if (!fs.existsSync(file)) {
    return { ok: true, enabled: false, mechanism: 'autostart', message: '', reason: 'absent' };
  }

  let target;
  try {
    const body = fs.readFileSync(file, 'utf8');
    const match = /^Exec=(.*)$/m.exec(body);
    if (match) {
      // The entry writes Exec with a JSON quoted path, so a path with a space
      // comes back whole. The plain form, written by hand, splits on the first
      // space as it always did.
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(match[1]);
      if (quoted) {
        try {
          const parsed = JSON.parse(`"${quoted[1]}"`);
          if (typeof parsed === 'string') target = parsed;
        } catch {
          target = quoted[1];
        }
      } else {
        target = match[1].split(' ')[0];
      }
    }
  } catch {
    // A file this version did not write: it is there, which is what matters.
  }
  return { ok: true, enabled: true, mechanism: 'autostart', message: '', target };
}

function setLoginItem(enabled, env = {}) {
  const { homeDir = os.homedir() } = env;
  const file = autostartFile(homeDir, env);

  if (enabled !== true) {
    fs.rmSync(file, { force: true });
    const check = loginItemStatus({ homeDir, ...env });
    if (check.enabled === true) {
      return { ok: false, enabled: true, mechanism: 'autostart', message: 'The system did not apply the login item.' };
    }
    return { ok: true, enabled: false, mechanism: 'autostart', message: '' };
  }

  const executable = loginItemExecutable(env);
  if (!executable) {
    return { ok: true, enabled: false, mechanism: 'none', message: '', reason: 'no-application' };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, autostartBody(executable), { mode: 0o644 });

  const check = loginItemStatus({ homeDir, ...env });
  if (check.enabled !== true) {
    return { ok: false, enabled: false, mechanism: 'autostart', message: 'The system did not apply the login item.' };
  }
  return { ok: true, enabled: true, mechanism: 'autostart', message: '', target: executable };
}

function sudoBinary() {
  return whichSync('sudo') || '/usr/bin/sudo';
}

function pgrepBinary() {
  return whichSync('pgrep') || '/usr/bin/pgrep';
}

function clientVersion(binary) {
  try {
    const stdout = runSync(binary, ['--version']);
    return { ok: true, version: stdout.trim().split('\n')[0] || null, message: null };
  } catch (error) {
    return { ok: false, version: null, message: `Cannot run ${binary}: ${error.message}` };
  }
}

export const linuxProvider = {
  id: 'linux',
  helperPath: HELPER_PATH,
  secrets: linuxSecrets,
  loginItem: {
    supported: true,
    mechanism: 'autostart',
    executable: loginItemExecutable,
    file: autostartFile,
    status: loginItemStatus,
    set: setLoginItem,
  },

  async helperReady() {
    if (!fs.existsSync(HELPER_PATH)) return false;
    if (isRoot()) return true;
    try {
      await run(sudoBinary(), ['-n', HELPER_PATH, 'version']);
      return true;
    } catch {
      return false;
    }
  },

  // Instala el helper en /usr/local/libexec y la regla de /etc/sudoers.d.
  // El propio script se eleva con pkexec (diálogo gráfico) o con sudo en una
  // terminal cuando no hay pkexec.
  async installHelper({ onLog, useGui = true } = {}) {
    const script = getHelperSourcePath('linux', 'install-linux-helper.sh');
    if (!fs.existsSync(script)) {
      throw new Error(`Helper installer not found: ${script}`);
    }
    if (!isRoot() && !whichSync('pkexec')) {
      throw new Error(
        `No hay pkexec para pedir la elevación. Ejecuta en una terminal: sudo /bin/bash ${script}`,
      );
    }
    const args = [script];
    if (useGui) args.push('--gui');
    return runStreaming('/bin/bash', args, { onLog });
  },

  async ensureClient() {
    const onPath = whichSync('openfortivpn');
    if (onPath) return clientVersion(onPath);

    return {
      ok: false,
      version: null,
      message: 'openfortivpn is not installed. Install it with: sudo apt install openfortivpn',
    };
  },

  async connect({ server, port, cookie, trustedCert, realm, detached = true, onData, onExit, outputFile }) {
    const args = [
      ...(isRoot() ? [] : ['-n']),
      HELPER_PATH,
      'connect',
      String(server),
      String(port),
      String(cookie),
      trustedCert || 'any',
      realm || '',
    ];
    const child = spawnProcess(isRoot() ? HELPER_PATH : sudoBinary(), args, { detached, onData, onExit, outputFile });
    return { pid: child.pid };
  },

  async stop() {
    try {
      if (isRoot()) {
        await run(HELPER_PATH, ['stop']);
      } else {
        await run(sudoBinary(), ['-n', HELPER_PATH, 'stop']);
      }
      return true;
    } catch {
      return false;
    }
  },

  async isVpnRunning() {
    try {
      await run(pgrepBinary(), ['-x', 'openfortivpn']);
      return true;
    } catch {
      return false;
    }
  },

  /** The link, not the process: openfortivpn can outlive its interface. */
  async isTunnelUp() {
    try {
      const ip = whichSync('ip');
      if (ip) {
        const { stdout } = await run(ip, ['-o', 'link', 'show']);
        return /\bppp\d+/.test(stdout);
      }

      const ifconfig = whichSync('ifconfig');
      if (ifconfig) {
        const { stdout } = await run(ifconfig, []);
        return /^ppp\d+/m.test(stdout);
      }

      return await this.isVpnRunning();
    } catch {
      return false;
    }
  },

  /** Blocks idle and sleep through systemd-inhibit while the tunnel is up. */
  startKeepAwake() {
    const inhibit = whichSync('systemd-inhibit');
    if (!inhibit) return null;

    const child = spawn(
      inhibit,
      ['--what=idle:sleep', '--why=VPN tunnel active', '--mode=block', 'sleep', 'infinity'],
      { stdio: 'ignore' },
    );
    child.on('error', () => {});
    child.unref();

    return {
      stop() {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      },
    };
  },
};
