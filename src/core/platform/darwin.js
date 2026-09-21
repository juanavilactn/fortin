import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  SECRETS_SERVICE,
  STARTED_AT_LOGIN_FLAG,
  bundleOf,
  getHelperSourcePath,
  isPackagedExecutable,
  run,
  runStreaming,
  runSync,
  spawnProcess,
  whichSync,
} from './index.js';

const SUDO = '/usr/bin/sudo';
const PGREP = '/usr/bin/pgrep';
const IFCONFIG = '/sbin/ifconfig';
const CAFFEINATE = '/usr/bin/caffeinate';
const HELPER_PATH = '/usr/local/libexec/fortin-helper';
const BUNDLED_OPENFORTIVPN = '/usr/local/libexec/fortin/openfortivpn';
const SECURITY_BINARY = '/usr/bin/security';
const LAUNCHCTL = '/bin/launchctl';
/** Label of the login item, the same the application bundle identifies itself with. */
const LOGIN_ITEM_LABEL = 'com.juanavilactn.fortin';
const APP_BUNDLE_NAME = 'Fortin.app';
/** A stalled keychain must not hang the caller: the store answers in milliseconds. */
const SECRETS_TIMEOUT_MS = 10000;
const SECRETS_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs the security tool and returns both output streams. The password travels
 * on stdin when it is written, and it is read from stderr with -g, so no secret
 * ever appears in a command line. Throws when the tool fails, with the exit code
 * and the message the callers inspect.
 */
function security(args, input) {
  const result = spawnSync(SECURITY_BINARY, args, {
    encoding: 'utf8',
    input,
    timeout: SECRETS_TIMEOUT_MS,
    maxBuffer: SECRETS_MAX_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (String(result.stderr ?? '').trim() || 'The security tool failed');
    const error = new Error(detail);
    if (result.status !== null && result.status !== 0) error.status = result.status;
    error.stderr = result.stderr ?? '';
    throw error;
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * The tool cannot print every password as it is: a value that holds anything
 * but printable ASCII, quotes and backslashes included, comes out as 0x
 * followed by the hex of its bytes. The -g form marks which representation it
 * used (the plain one is quoted), so the exact value comes back; -w alone
 * cannot tell a password that looks like hex from hex output.
 */
function decodePasswordField(field) {
  if (typeof field !== 'string') return null;
  const hexForm = /^0x([0-9a-f]+)/i.exec(field);
  if (hexForm) return Buffer.from(hexForm[1], 'hex').toString('utf8');
  const quotedForm = /^"([\s\S]*)"$/.exec(field);
  if (quotedForm) return quotedForm[1];
  return null;
}

/** The password line the tool writes on stderr with -g, decoded. */
function passwordFromSecurityOutput(stderr) {
  const line = /^password: (.*)$/m.exec(String(stderr ?? ''));
  return line ? decodePasswordField(line[1]) : null;
}

/**
 * Quotes a value for the command language of the security tool. The tool drops
 * a backslash that precedes anything but a backslash or a quote, so only those
 * two are escaped.
 */
function securityQuote(value) {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** The security tool reports a missing item with errSecItemNotFound (44). */
function securityItemMissing(error) {
  return error?.status === 44 || /could not be found in the keychain/i.test(String(error?.stderr ?? ''));
}

/**
 * macOS Keychain store: generic passwords filed under SECRETS_SERVICE, one
 * account per secret name.
 *
 * The items are created without -A, so their access control list names the tool
 * that created them (/usr/bin/security, Apple-signed) as the one that reads
 * them without asking. Every read and write of the application and of the CLI
 * goes through that same binary, so an ad-hoc signature that changes on each
 * rebuild never invalidates the item and never raises an authorization dialog.
 * -A would remove that check and let any local process read the password
 * silently.
 *
 * The secret never travels as a command line argument: the write sends the
 * whole command to the interactive mode on stdin, because an argument is
 * visible to every process of the machine through ps.
 */
const darwinSecrets = {
  info() {
    const available = fs.existsSync(SECURITY_BINARY);
    return {
      id: 'macos-keychain',
      label: 'the macOS Keychain',
      available,
      reason: available ? '' : SECURITY_BINARY + ' is not available',
    };
  },

  /** Stored value, or an empty string when there is no item for that account. */
  get(account) {
    try {
      const { stderr } = security(['find-generic-password', '-s', SECRETS_SERVICE, '-a', account, '-g']);
      const decoded = passwordFromSecurityOutput(stderr);
      if (decoded !== null) return decoded;
      // An output shape this version of the tool does not produce: ask for the
      // plain form, which is faithful for a printable value.
      const plain = security(['find-generic-password', '-s', SECRETS_SERVICE, '-a', account, '-w']);
      return plain.stdout.replace(/\n$/, '');
    } catch (error) {
      if (securityItemMissing(error)) return '';
      throw error;
    }
  },

  has(account) {
    try {
      security(['find-generic-password', '-s', SECRETS_SERVICE, '-a', account]);
      return true;
    } catch (error) {
      if (securityItemMissing(error)) return false;
      throw error;
    }
  },

  /**
   * Creates or updates the item. Throws when the keychain does not take it.
   *
   * The write goes through the interactive mode with the whole command on
   * stdin: its plain -w form asks for the value twice and copies only the first
   * 128 characters, which would store a truncated password or cookie without
   * complaining.
   */
  set(account, value) {
    const text = String(value);
    // A control character cannot travel through the command language: refusing
    // it is honest, storing a mangled value is not.
    if (/[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error('The keychain cannot store a ' + account + ' item with control characters');
    }
    const command = 'add-generic-password -U -s ' + securityQuote(SECRETS_SERVICE)
      + ' -a ' + securityQuote(account) + ' -w ' + securityQuote(text) + '\n';
    security(['-i'], command);
    // The tool reports most refusals with a non-zero exit, but the write is only
    // real when the exact value comes back.
    if (darwinSecrets.get(account) !== text) {
      throw new Error('The keychain did not store the ' + account + ' item');
    }
  },

  remove(account) {
    try {
      security(['delete-generic-password', '-s', SECRETS_SERVICE, '-a', account]);
    } catch (error) {
      if (!securityItemMissing(error)) throw error;
    }
  },
};

function clientVersion(binary) {
  try {
    const stdout = runSync(binary, ['--version']);
    return { ok: true, version: stdout.trim().split('\n')[0] || null, message: null };
  } catch (error) {
    return { ok: false, version: null, message: `Cannot run ${binary}: ${error.message}` };
  }
}

/* --------------------------------------------------------------- login item */

/** File launchd reads at login. */
function launchAgentFile(homeDir) {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${LOGIN_ITEM_LABEL}.plist`);
}

/**
 * Executable the entry launches: the application this process is, when it is a
 * packaged build, and otherwise the application installed on the machine. A
 * development run (`electron .`, `node src/cli.js`) is neither, and then there
 * is nothing to launch, so no entry is written.
 */
function loginItemExecutable({ execPath = process.execPath, homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  if (bundleOf(execPath) && isPackagedExecutable(execPath) && exists(execPath)) return execPath;

  const bundle = APP_BUNDLE_NAME.replace(/\.app$/, '');
  const candidates = [
    path.join('/Applications', APP_BUNDLE_NAME, 'Contents', 'MacOS', bundle),
    path.join(homeDir, 'Applications', APP_BUNDLE_NAME, 'Contents', 'MacOS', bundle),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * A LaunchAgent with RunAtLoad runs the application when the user logs in, and
 * the argument it passes marks the start as a login one, exactly as the entry
 * Electron used to write did. KeepAlive is false on purpose: quitting the
 * application must not bring it back.
 */
function launchAgentBody(executable) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(LOGIN_ITEM_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(executable)}</string>`,
    `    <string>${xmlEscape(STARTED_AT_LOGIN_FLAG)}</string>`,
    '  </array>',
    '  <key>AssociatedBundleIdentifiers</key>',
    '  <array>',
    `    <string>${xmlEscape(LOGIN_ITEM_LABEL)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>LimitLoadToSessionType</key>',
    '  <string>Aqua</string>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** First ProgramArguments string of the plist, which is the executable. */
function launchAgentTarget(file) {
  try {
    const body = fs.readFileSync(file, 'utf8');
    const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(body);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** True while launchd holds the job of this session. Never throws. */
function launchAgentLoaded({ homeDir = os.homedir(), uid = null, run = null } = {}) {
  if (!fs.existsSync(launchAgentFile(homeDir))) return false;
  const identifier = uid === null ? '' : `gui/${uid}/`;
  const call = run ?? ((command, args) => runSync(command, args));
  try {
    call(LAUNCHCTL, ['print', `${identifier}${LOGIN_ITEM_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The LaunchAgent is the login item of macOS here. It is a file under
 * ~/Library/LaunchAgents, so the CLI and the window register it with the same
 * rights, and it appears in System Settings, General, Login Items under
 * "Allow in the background" (see README).
 */
function loginItemStatus({ homeDir = os.homedir(), ...env } = {}) {
  const file = launchAgentFile(homeDir);
  if (!fs.existsSync(file)) {
    return { ok: true, enabled: false, mechanism: 'launch-agent', message: '', reason: 'absent' };
  }
  return {
    ok: true,
    enabled: true,
    mechanism: 'launch-agent',
    message: '',
    target: launchAgentTarget(file) ?? undefined,
    loaded: launchAgentLoaded({ homeDir, ...env }),
  };
}

function setLoginItem(enabled, env = {}) {
  const { homeDir = os.homedir() } = env;
  const file = launchAgentFile(homeDir);

  if (enabled !== true) {
    // The loaded job of this session is left alone: booting it out kills the
    // application it started. Removing the file is enough, because launchd
    // reads the folder at login.
    fs.rmSync(file, { force: true });
    const check = loginItemStatus({ homeDir, ...env });
    if (check.enabled === true) {
      return { ok: false, enabled: true, mechanism: 'launch-agent', message: 'The system did not apply the login item.' };
    }
    return { ok: true, enabled: false, mechanism: 'launch-agent', message: '' };
  }

  const executable = loginItemExecutable(env);
  if (!executable) {
    return { ok: true, enabled: false, mechanism: 'none', message: '', reason: 'no-application' };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, launchAgentBody(executable), { mode: 0o644 });

  const check = loginItemStatus({ homeDir, ...env });
  if (check.enabled !== true) {
    return { ok: false, enabled: false, mechanism: 'launch-agent', message: 'The system did not apply the login item.' };
  }
  return { ok: true, enabled: true, mechanism: 'launch-agent', message: '', target: executable };
}

export const darwinProvider = {
  id: 'darwin',
  helperPath: HELPER_PATH,
  secrets: darwinSecrets,
  loginItem: {
    supported: true,
    mechanism: 'launch-agent',
    executable: loginItemExecutable,
    file: launchAgentFile,
    status: loginItemStatus,
    set: setLoginItem,
  },

  // El helper esta instalado y la regla de sudoers permite invocarlo sin contraseña.
  async helperReady() {
    if (!fs.existsSync(HELPER_PATH)) return false;
    try {
      await run(SUDO, ['-n', HELPER_PATH, 'version']);
      return true;
    } catch {
      return false;
    }
  },

  // Instalador oficial del helper: copia openfortivpn a /usr/local/libexec y
  // escribe /etc/sudoers.d/fortin. Con useGui pide la contraseña con
  // el diálogo de administrador de macOS (osascript).
  async installHelper({ onLog, useGui = true } = {}) {
    const script = getHelperSourcePath('darwin', 'install-autonomous.sh');
    if (!fs.existsSync(script)) {
      throw new Error(`Helper installer not found: ${script}`);
    }
    const args = [script];
    if (useGui) args.push('--gui');
    return runStreaming('/bin/bash', args, { onLog });
  },

  async ensureClient() {
    if (fs.existsSync(BUNDLED_OPENFORTIVPN)) {
      const bundled = clientVersion(BUNDLED_OPENFORTIVPN);
      if (bundled.ok) return bundled;
    }

    const onPath = whichSync('openfortivpn');
    if (onPath) return clientVersion(onPath);

    return {
      ok: false,
      version: null,
      message: 'openfortivpn is not installed. Install it with Homebrew: brew install openfortivpn',
    };
  },

  async connect({ server, port, cookie, trustedCert, realm, detached = true, onData, onExit, outputFile }) {
    const args = [
      '-n',
      HELPER_PATH,
      'connect',
      String(server),
      String(port),
      String(cookie),
      trustedCert || 'any',
      realm || '',
    ];
    const child = spawnProcess(SUDO, args, { detached, onData, onExit, outputFile });
    return { pid: child.pid };
  },

  async stop() {
    try {
      await run(SUDO, ['-n', HELPER_PATH, 'stop']);
      return true;
    } catch {
      return false;
    }
  },

  async isVpnRunning() {
    try {
      await run(PGREP, ['-x', 'openfortivpn']);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * The process survives a sleep even when the link does not, so the health of
   * the tunnel is the point-to-point interface, not the process.
   */
  async isTunnelUp() {
    try {
      const { stdout } = await run(IFCONFIG, []);
      return /^ppp\d+/m.test(stdout);
    } catch {
      return false;
    }
  },

  /**
   * caffeinate holds an idle-sleep assertion while it runs. With -w it lives
   * exactly as long as the tunnel process, so a crash releases it by itself.
   */
  startKeepAwake({ tunnelPid } = {}) {
    const args = ['-i', '-s'];
    if (tunnelPid) args.push('-w', String(tunnelPid));

    const child = spawn(CAFFEINATE, args, { stdio: 'ignore' });
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
