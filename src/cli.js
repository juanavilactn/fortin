#!/usr/bin/env node
/**
 * Terminal adapter.
 *
 * Every command is a thin translation of one operation of the shared session
 * (src/core/session.js): the same code the window runs, with the terminal as the
 * only difference. The commands and flags that existed before keep working the
 * same way; the rest of the table is in src/core/api.js and in README.md.
 *
 * Output rules:
 *   - human readable on `stdout` by default;
 *   - `--json` prints one JSON object on `stdout` and nothing else, so a script
 *     can read it: `{ok, command, result}` when it worked and
 *     `{ok:false, command, error:{message, code?}}` when it did not, always with
 *     exit code 0 or 1. Everything else, log lines included, goes to `stderr`.
 *
 * Credentials never come from the command line: `secrets set` reads the value
 * from the terminal (hidden when there is a terminal) and the password prompt of
 * a connection does the same. No command prints a secret.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { CONFIG_FIELDS, getPaths, loadConfig, setConfigLog } from './core/config.js';
import { Logger } from './core/logger.js';
import { bundleOf, getProvider, isPackagedExecutable } from './core/platform/index.js';
import { SECRET_NAMES } from './core/secrets.js';
import { VpnSession } from './core/session.js';
import { clearPid, isProcessRunning, readPid } from './core/state.js';

const HELP_TEXT = `
Fortin CLI - Auto-Connect (Microsoft OAuth + TOTP)

Usage: fortin <command> [options]

Connection:
  start                     Connect to VPN (default, runs in background)
  stop                      Disconnect from VPN
  status                    Show VPN connection status
  watch                     Follow the state in the foreground until Ctrl-C

Configuration:
  config get                Configuration, secret store and paths
  config set <key> <value>  Change configuration values (<key> <value> pairs)
  secrets status            Which secrets exist, where they live
  secrets set <name>        Store a secret, read from the terminal (never from
                            the command line): password, totpSecret, svpnCookie
  secrets delete <name>     Remove a secret from the store and from the file
  login-item status         What the system holds for start at login
  login-item enable|disable Turn start at login on or off
  logs [-n N]               Last N lines of the current log file (default 200)

Helper and diagnostics:
  helper status             Privileged helper and openfortivpn client
  helper install            Install the privileged helper (one-time admin approval)
  setup                     Alias of "helper install"
  setup status              Where the initial setup stands
  setup complete            Mark the initial setup as completed
  setup skip                Postpone it: the app stops asking
  setup reset               Forget the decision, so the app asks again
  cli status                Where the command line tool is, and which copy runs
  cli install [--dir DIR]   Link the tool into a directory of the PATH
                            (--force replaces what is already there)
  cli uninstall             Remove that link
  info                      Version, platform, paths, provider and secret store
  version                   Version only
  doctor                    Aggregated state, read only, nothing is changed
  help                      Show this help message

Options for 'start':
  -f, --foreground         Run in foreground (default: background)
  --push                   Use push notification auth (default, approve on phone)
  --totp                   Use TOTP code auth (requires totpSecret)
  --no-headless            Show browser window
  --headless               Hide the browser window (default)
  --debug-screenshots      Save screenshots during auth for debugging
  -s, --server SERVER      VPN server
  -u, --username USER      Microsoft username (email)
  -P, --password PASS      Password
  -t, --totp-secret SECRET TOTP secret key
  -r, --realm REALM        VPN realm

Options for 'watch':
  --interval SECONDS       How often the state is checked (default 15)

Global options:
  --json                   One JSON object on stdout, nothing else
  -h, --help               Show this help message

Exit codes: 0 when the command worked, 1 when it did not.

Examples:
  fortin setup                    # One-time privileged helper installation
  fortin start                    # Connect with push notification (default)
  fortin start --totp             # Connect with TOTP code
  fortin status --json            # Machine readable status
  fortin config set vpnPort 8443  # Change one value
  fortin secrets set password     # Store the password, read from stdin
  fortin login-item enable        # Start the application at login
  fortin cli install              # Use the tool from any terminal
  fortin watch                    # Follow the state in the foreground

Config file: ~/.fortin/config.json
Secrets:     the system store (macOS Keychain, secret-tool), or that file on a machine without one

Environment variables:
  VPN_SERVER, VPN_PORT, VPN_REALM, VPN_USERNAME, VPN_PASSWORD,
  VPN_TOTP_SECRET, VPN_AUTH_METHOD, VPN_HEADLESS, VPN_TRUSTED_CERT
`;

/** Set by --json. While it is on, the standard output carries the JSON document only. */
let jsonMode = false;

/* ------------------------------------------------------------------- output */

/** Human readable line. Silent in --json mode, where stdout is the JSON document. */
function say(...parts) {
  if (jsonMode) return;
  process.stdout.write(`${parts.join(' ')}\n`);
}

function warn(...parts) {
  process.stderr.write(`${parts.join(' ')}\n`);
}

function emitResult(command, result) {
  if (!jsonMode) return;
  process.stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`);
}

function emitError(command, error) {
  const message = error?.message ?? String(error);
  if (jsonMode) {
    const body = { ok: false, command, error: { message } };
    if (error?.code) body.error.code = error.code;
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    warn(`Error: ${message}`);
  }
  process.exitCode = 1;
}

/* --------------------------------------------------------------- secret input */

/**
 * First line of a stream: what arrives before the first newline, or the whole
 * input when the writer closes it without one. `printf %s "$VALUE"` is the
 * natural way to send a secret down a pipe, so an input without a trailing
 * newline carries a value like any other. A reader that only resolved on a
 * newline dropped that value and left the command silent.
 */
function readFirstLine(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      resolve(value);
    };

    const onData = (chunk) => {
      data += String(chunk);
      const index = data.indexOf('\n');
      if (index !== -1) finish(data.slice(0, index).replace(/\r$/, ''));
    };

    // The writer closed the input: what arrived is the whole value.
    const onEnd = () => finish(data.replace(/\r$/, ''));

    const onError = (error) => {
      if (settled) return;
      settled = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      reject(error);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume?.();
  });
}

/**
 * Reads a secret without echoing it: hidden when stdin is a terminal, first line
 * of the input when it is a pipe (`echo -n value | fortin secrets set ...`).
 */
async function promptSecret(promptText) {
  if (!process.stdin.isTTY) return readFirstLine(process.stdin);

  return new Promise((resolve) => {
    process.stdout.write(promptText);

    const mutedStdout = new Writable({
      write: (chunk, encoding, callback) => callback(),
    });
    const rl = readline.createInterface({ input: process.stdin, output: mutedStdout, terminal: true });

    rl.question('', (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Answers the credential requests of the session with a terminal prompt. The
 * window answers the same event with its modal.
 */
function attachCredentialPrompt(session) {
  session.on('credentials:request', async (request) => {
    const promptText = request.kind === 'totp'
      ? '   Code: '
      : (request.message === 'incorrect' ? '   Password: ' : 'Enter password: ');
    try {
      const value = await promptSecret(promptText);
      session.answerCredentials(request.id, { value });
    } catch {
      session.answerCredentials(request.id, { cancel: true });
    }
  });
}

/* -------------------------------------------------------------------- session */

/**
 * Builds the session of a command. The terminal owns no tunnel by default: a
 * `start` in the background leaves the tunnel running when the process ends, and
 * `watch` never takes it down.
 */
function createSession({ toFile = false, owner = 'detached', mirror = null } = {}) {
  const paths = getPaths();
  const logger = new Logger({
    logDir: paths.logsDir,
    toFile,
    mirror: mirror ?? (jsonMode ? 'stderr' : 'stdout'),
  });
  const provider = getProvider();
  const session = new VpnSession({
    config: loadConfig(),
    logger,
    provider,
    paths,
    owner,
    // The terminal waits for the prompt as long as the user needs it.
    credentialsTimeoutMs: 0,
    // The entry always launches a packaged application; the provider decides
    // whether this machine has one. The window applies its own rule
    // (app.isPackaged) and a command never rewrites the system by itself.
    allowLoginItemWrite: true,
    syncLoginItem: false,
  });
  return { session, logger, provider, paths };
}

function formatState(snapshot) {
  const label = { disconnected: 'Disconnected', connecting: 'Connecting', connected: 'Connected', disconnecting: 'Disconnecting', error: 'Error' }[snapshot.state] ?? snapshot.state;
  // The message of a settled state repeats its name: show it only when it adds something.
  return snapshot.message && snapshot.message !== label ? `${label} - ${snapshot.message}` : label;
}

/** Pads a label to the width the human output uses before its value. */
function field(label, value) {
  return `${(label + ':').padEnd(13)}${value}`;
}

/* ------------------------------------------------------------------- commands */

async function stopCommand() {
  const { session, logger, provider } = createSession({ toFile: true });
  await session.start({ poll: false });

  logger.log('Stopping VPN...');
  // Reconcile first: the tunnel may have been opened by another process, and
  // then this fresh session still believes it is disconnected.
  await session.refreshStatus();
  const result = await session.disconnect({ wait: true });

  if (result.accepted === true && result.stopped === false) {
    const message = 'Could not stop the VPN without prompting for a password';
    if (jsonMode) emitError('stop', new Error(message));
    else {
      warn(message);
      warn('Run "fortin setup" to repair autonomous mode.');
    }
    process.exitCode = 1;
    logger.dispose();
    return;
  }

  if (result.accepted === false && result.reason !== 'already-disconnected') {
    emitError('stop', new Error(`The VPN is ${result.reason}, try again in a moment`));
    logger.dispose();
    return;
  }

  // A process left behind by an older background start is reported and reaped
  // exactly as before, even when the helper already took the tunnel down.
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      logger.log(`Stopped background process (PID: ${pid})`);
    } catch {
      // El proceso ya habia terminado.
    }
  }
  clearPid();

  const snapshot = session.snapshot();
  const running = await provider.isVpnRunning().catch(() => false);
  logger.log('VPN disconnected');
  emitResult('stop', { ...snapshot, running });
  process.exitCode = 0;
  logger.dispose();
}

async function statusCommand() {
  const { session, logger, paths } = createSession();
  await session.start({ poll: false });

  const snapshot = await session.refreshStatus();
  const pid = readPid();
  const backgroundRunning = Boolean(pid) && isProcessRunning(pid);
  const logFile = session.logFilePath();

  if (snapshot.state === 'connected') {
    say('VPN Status: Connected');
    if (snapshot.message) say(`  ${snapshot.message}`);
    if (backgroundRunning) say(`Background process PID: ${pid}`);
    say(`\nLogs: ${logFile}`);
    say('\nTo disconnect: fortin stop');
  } else {
    say(`VPN Status: ${formatState(snapshot)}`);
    if (backgroundRunning) say(`Note: Background process still running (PID: ${pid})`);
  }

  emitResult('status', { ...snapshot, logFile, backgroundPid: backgroundRunning ? pid : null });
  process.exitCode = 0;
  logger.dispose();
}

async function watchCommand(args) {
  let intervalMs = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval') {
      const seconds = Number(args[++i]);
      if (Number.isFinite(seconds) && seconds > 0) intervalMs = Math.round(seconds * 1000);
    }
  }

  const { session, logger } = createSession({ owner: 'detached' });
  attachCredentialPrompt(session);
  if (intervalMs) session.pollIntervalMs = intervalMs;
  await session.start({ poll: true });

  say('Watching the VPN state. Ctrl-C stops watching; the tunnel is left as it is.');
  say(`State: ${formatState(session.snapshot())}`);

  session.on('state', (payload) => say(`State: ${formatState(payload)}`));
  session.on('progress', (payload) => {
    if (payload?.message) say(`   ${payload.message}`);
  });

  // Nothing else holds the process: the poll timer is unref'd on purpose.
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
  const finish = () => {
    clearInterval(keepAlive);
    session.stop();
    say('\nStopped watching.');
    emitResult('watch', session.snapshot());
    logger.dispose();
    process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
}

async function setupCommand(args) {
  const { session, logger, provider } = createSession({ toFile: true });
  await session.start({ poll: false });

  say(`Installing the privileged helper (${provider.id})...`);
  // En una terminal el instalador puede pedir la contrasena el mismo; fuera de
  // ella (app de escritorio) se usa el dialogo de administrador del sistema.
  const status = await session.helperInstall({ useGui: !process.stdout.isTTY });

  if (status.ok !== true) {
    emitError('helper install', new Error(status.message || 'The helper could not be installed'));
    logger.dispose();
    return;
  }

  say('');
  say('Autonomous mode is ready. Use: fortin start');
  emitResult('helper install', status);
  process.exitCode = 0;
  logger.dispose();
}

/* ------------------------------------------------------------------- setup */

/** The answer of the initial setup, in one line, read from its flags. */
function describeSetupFlags(flags) {
  if (flags?.completed === true) return `completed (version ${flags.version})`;
  if (flags?.skipped === true) return `postponed (version ${flags.version})`;
  return 'not finished';
}

/** Why the assistant is due, in words. */
const SETUP_REASON_TEXT = {
  'no-config-file': 'no configuration file',
  'no-server': 'no VPN server',
  'helper-not-ready': 'the privileged helper is not ready',
};

function describeSetupReasons(reasons) {
  return (Array.isArray(reasons) ? reasons : []).map((reason) => SETUP_REASON_TEXT[reason] ?? reason).join(', ');
}

async function setupStatusCommand() {
  const { session, logger } = createSession();
  await session.start({ poll: false });
  const status = await session.setupStatus();

  say(field('Setup', describeSetupFlags(status.flags)));
  say(field('Assistant', status.due ? 'due, this machine is not ready to connect' : (status.configured ? 'not due, the machine is configured' : 'not due')));
  if (status.reasons.length > 0) say(field('Missing', describeSetupReasons(status.reasons)));

  emitResult('setup status', status);
  process.exitCode = 0;
  logger.dispose();
}

async function setupCompleteCommand(args, { command }) {
  const { session, logger } = createSession({ toFile: true });
  await session.start({ poll: false });
  const status = await session.setupComplete();

  say(`Initial setup marked as completed (version ${status.version}).`);
  emitResult(command, status);
  process.exitCode = 0;
  logger.dispose();
}

async function setupSkipCommand(args, { command }) {
  const { session, logger } = createSession({ toFile: true });
  await session.start({ poll: false });
  const status = await session.setupSkip();

  say('Initial setup postponed. The window says what is still missing, and the assistant is in the tray menu.');
  emitResult(command, status);
  process.exitCode = 0;
  logger.dispose();
}

async function setupResetCommand(args, { command }) {
  const { session, logger } = createSession({ toFile: true });
  await session.start({ poll: false });
  const status = await session.setupReset();

  say(status.due
    ? 'Initial setup decision cleared. The assistant appears again at the next start.'
    : 'Initial setup decision cleared. This machine is configured, so the assistant stays out of the way until it is asked for.');
  emitResult(command, status);
  process.exitCode = 0;
  logger.dispose();
}

async function helperStatusCommand() {
  const { session, logger } = createSession();
  await session.start({ poll: false });
  const status = await session.helperStatus();

  say(`Provider:  ${status.id}`);
  say(`Helper:    ${status.ready ? 'ready' : 'not ready'} ${status.helperPath}`);
  if (status.readyError) say(`           ${status.readyError}`);
  say(`Client:    ${status.client.ok ? (status.client.version || 'available') : 'missing'}`);
  if (!status.client.ok && status.client.message) say(`           ${status.client.message}`);

  emitResult('helper status', status);
  process.exitCode = status.ready && status.client.ok ? 0 : 1;
  logger.dispose();
}

async function logsCommand(args) {
  let lines = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' || args[i] === '--lines') lines = Number(args[++i]) || null;
  }

  const { session, logger } = createSession();
  await session.start({ poll: false });
  const payload = session.logsRecent({ lines });

  if (!payload.ok) {
    emitError('logs', new Error(payload.message));
    logger.dispose();
    return;
  }

  if (!jsonMode) {
    say(`Log file: ${payload.path} (${payload.lines.length} of ${payload.total} lines)`);
    for (const line of payload.lines) process.stdout.write(`${line}\n`);
  }

  emitResult('logs', payload);
  process.exitCode = 0;
  logger.dispose();
}

async function infoCommand() {
  const { session, logger } = createSession();
  await session.start({ poll: false });
  const info = session.appInfo();
  const store = session.secretsStatus().store;

  say(field('Name', `${info.productName} (${info.name}) ${info.version}`));
  say(field('Platform', `${info.platform} ${info.arch}`));
  say(field('Node', info.node));
  say(field('Provider', `${info.provider.id} (helper: ${info.provider.helperPath})`));
  say(field('Config dir', info.configDir));
  say(field('Config', info.configFile));
  say(field('Logs', info.logsDir));
  say(field('Screenshots', info.screenshotsDir));
  say(field('Secrets', store.available ? store.label : `${store.label} (${store.reason})`));

  emitResult('info', { ...info, secretsStore: store });
  process.exitCode = 0;
  logger.dispose();
}

async function versionCommand() {
  const { session, logger } = createSession();
  const info = session.appInfo();
  say(info.version);
  emitResult('version', { name: info.name, productName: info.productName, version: info.version });
  process.exitCode = 0;
  logger.dispose();
}

async function doctorCommand() {
  const { session, logger } = createSession();
  await session.start({ poll: false });
  const report = await session.doctor();

  say(`Application: ${report.app.productName} ${report.app.version} on ${report.app.platform} ${report.app.arch}`);
  say(`Provider:    ${report.app.provider.id}, helper ${report.app.provider.helperPath}`);
  say(`Config:      ${report.config.file} ${report.config.exists ? `(keys: ${report.config.savedKeys.join(', ') || 'none'})` : '(missing)'}`);
  if (report.config.envOverrides.length > 0) say(`Environment: ${report.config.envOverrides.join(', ')}`);
  say(`Secrets:     ${report.secrets.store.available ? report.secrets.store.label : `${report.secrets.store.label} (${report.secrets.store.reason})`}`);
  for (const item of report.secrets.items) say(`             ${item.label}: ${item.present ? `present (${item.where})` : 'absent'}`);
  say(`Login item:  ${report.loginItem.enabled ? `enabled (${report.loginItem.mechanism}${report.loginItem.target ? `, ${report.loginItem.target}` : ''})` : 'disabled'}${report.loginItem.reason ? ` [${report.loginItem.reason}]` : ''}${report.loginItem.ok ? '' : ` ${report.loginItem.message}`}`);
  say(`Setup:       ${describeSetupFlags(report.setup.flags)}${report.setup.due ? ' (the assistant is due)' : ''}${report.setup.reasons.length > 0 ? ` [missing: ${describeSetupReasons(report.setup.reasons)}]` : ''}`);
  say(`Helper:      ${report.helper.ready ? 'ready' : 'not ready'}`);
  say(`Client:      ${report.helper.client.ok ? (report.helper.client.version || 'available') : `missing (${report.helper.client.message})`}`);
  say(`Tunnel:      ${formatState(report.tunnel)}${report.tunnel.running ? ` (pid ${report.tunnel.pid ?? 'unknown'})` : ''}`);
  say(`Owner:       ${report.tunnel.owner}`);
  say(`Logs:        ${report.logs.file}`);

  emitResult('doctor', report);
  process.exitCode = 0;
  logger.dispose();
}

/* -------------------------------------------------------------- configuration */

async function configGetCommand() {
  const { session, logger } = createSession();
  await session.start({ poll: false });
  const payload = session.configGet();
  const store = payload.secretsStore;

  for (const field of CONFIG_FIELDS) {
    if (field.secret) continue;
    const value = payload.config[field.key];
    say(`${field.key.padEnd(18)} ${value === '' || value === undefined ? '(empty)' : String(value)}`);
  }
  say(`password            ${payload.hasPassword ? '(saved)' : '(empty)'}`);
  say(`totpSecret          ${payload.hasTotpSecret ? '(saved)' : '(empty)'}`);
  say(`secrets store        ${store.available ? store.label : `${store.label} (${store.reason})`}`);
  say(`${'setup'.padEnd(18)}${describeSetupFlags(payload.setup)}`);
  if (payload.envOverrides.length > 0) say(`environment          ${payload.envOverrides.join(', ')}`);
  say(`config file          ${payload.paths.configFile}`);

  emitResult('config get', payload);
  process.exitCode = 0;
  logger.dispose();
}

const BOOLEAN_KEYS = new Set(CONFIG_FIELDS.filter((field) => field.type === 'boolean').map((field) => field.key));
const KNOWN_KEYS = new Set(CONFIG_FIELDS.map((field) => field.key));

function coerceValue(key, raw) {
  if (!BOOLEAN_KEYS.has(key)) return raw;
  const value = String(raw).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`The value of ${key} has to be true or false`);
}

async function configSetCommand(args, { command }) {
  const pairs = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('-')) continue;
    if (token.includes('=') && !KNOWN_KEYS.has(token)) {
      const index = token.indexOf('=');
      pairs.push([token.slice(0, index), token.slice(index + 1)]);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      emitError(command, new Error(`The value of ${token} is missing`));
      return;
    }
    pairs.push([token, next]);
    i += 1;
  }

  if (pairs.length === 0) {
    emitError(command, new Error('Usage: fortin config set <key> <value> [<key> <value> ...]'));
    return;
  }

  const patch = {};
  for (const [key, raw] of pairs) {
    if (key === 'password' || key === 'totpSecret') {
      emitError(command, new Error(`The ${key} is a secret: use "fortin secrets set ${key}", which reads it from the terminal`));
      return;
    }
    if (!KNOWN_KEYS.has(key)) {
      emitError(command, new Error(`Unknown configuration key: ${key}`));
      return;
    }
    try {
      patch[key] = coerceValue(key, raw);
    } catch (error) {
      emitError(command, error);
      return;
    }
  }

  const { session, logger } = createSession({ toFile: true });
  await session.start({ poll: false });
  const result = session.configSave(patch);

  if (result.ok !== true) {
    emitError(command, new Error(result.message));
    logger.dispose();
    return;
  }

  // "Configuration saved" is already written by the configuration module into
  // the log; here only the login item note, when there is one, is added.
  const loginItem = result.loginItem;
  if (loginItem?.ok === false) warn(`Saved, but the login item failed: ${loginItem.message}`);
  else if (loginItem?.message) say(`Saved. ${loginItem.message}`);

  emitResult(command, result);
  process.exitCode = 0;
  logger.dispose();
}

/* ------------------------------------------------------------------- secrets */

function secretNameOf(raw) {
  const aliases = { password: 'password', totpsecret: 'totpSecret', totp: 'totpSecret', cookie: 'svpnCookie', svpncookie: 'svpnCookie' };
  return aliases[String(raw ?? '').toLowerCase()] ?? null;
}

async function secretsStatusCommand() {
  const { session, logger } = createSession();
  await session.start({ poll: false });
  const status = session.secretsStatus();

  say(`Store: ${status.store.available ? status.store.label : `${status.store.label} (${status.store.reason})`}`);
  for (const item of status.items) {
    say(`${item.name.padEnd(12)} ${item.present ? `present (${item.where})` : 'absent'}`);
  }

  emitResult('secrets status', status);
  process.exitCode = 0;
  logger.dispose();
}

async function secretsSetCommand(args, { command }) {
  const name = secretNameOf(args[0]);
  if (!name) {
    emitError(command, new Error(`Usage: fortin secrets set <${Object.values(SECRET_NAMES).join('|')}>, value read from stdin`));
    return;
  }

  const { session, logger } = createSession({ toFile: true });
  await session.start({ poll: false });

  const value = await promptSecret(`Value for ${name} (hidden): `);
  const result = session.secretSet(name, value);
  if (result.ok !== true) {
    emitError(command, new Error(result.message));
    logger.dispose();
    return;
  }

  const where = result.items.find((item) => item.name === name)?.where ?? 'store';
  logger.log(`${result.label} stored in ${where === 'store' ? result.store.label : 'the configuration file (mode 0600, not protected by the system)'}`);

  emitResult(command, result);
  process.exitCode = 0;
  logger.dispose();
}

async function secretsDeleteCommand(args, { command }) {
  const name = secretNameOf(args[0]);
  if (!name) {
    emitError(command, new Error(`Usage: fortin secrets delete <${Object.values(SECRET_NAMES).join('|')}>`));
    return;
  }

  const { session, logger } = createSession({ toFile: true });
  await session.start({ poll: false });
  const result = session.secretDelete(name);

  if (result.ok !== true) {
    emitError(command, new Error(result.message));
    logger.dispose();
    return;
  }

  logger.log(result.deleted ? `${result.label} deleted` : `${result.label} was not stored`);
  emitResult(command, result);
  process.exitCode = 0;
  logger.dispose();
}

/* ---------------------------------------------------------------- login item */

function loginItemLines(result, write = say) {
  if (result.enabled) {
    write(`Start at login: enabled (${result.mechanism}${result.target ? `, ${result.target}` : ''})`);
  } else if (result.reason === 'no-application') {
    write('Start at login: not registered. No packaged application was found to start at login.');
  } else if (result.reason === 'not-authorized') {
    write('Start at login: not registered. This run cannot write the login item.');
  } else if (result.reason === 'unsupported') {
    write('Start at login: not available on this platform.');
  } else {
    write('Start at login: disabled');
  }
  if (result.ok === false && result.message) warn(result.message);
}

async function loginItemStatusCommand() {
  const { session, logger } = createSession();
  await session.start({ poll: false });
  const status = session.loginItemStatus();

  loginItemLines(status);
  if (typeof status.loaded === 'boolean' && status.enabled) {
    say(`  launchd: ${status.loaded ? 'loaded in this session' : 'not loaded in this session'}`);
  }

  emitResult('login-item status', status);
  process.exitCode = status.ok ? 0 : 1;
  logger.dispose();
}

async function loginItemSetCommand(enabled, { command }) {
  const { session, logger } = createSession({ toFile: true });
  await session.start({ poll: false });
  const result = session.loginItemSet(enabled);

  loginItemLines(result, (line) => logger.log(line));
  emitResult(command, result);
  process.exitCode = result.ok ? 0 : 1;
  logger.dispose();
}

/* ---------------------------------------------------------------------- start */

// Espera a que el tunel se cierre: el CLI en primer plano acompana al proceso.
function waitForTunnelEnd(session, provider) {
  return new Promise((resolve) => {
    const finish = () => {
      clearInterval(timer);
      session.off('state', onState);
      resolve();
    };
    const onState = (payload) => {
      if (payload.state === 'disconnected' || payload.state === 'error') finish();
    };
    const timer = setInterval(async () => {
      if (!await provider.isVpnRunning()) finish();
    }, 2000);
    session.on('state', onState);
  });
}

async function startCommand(args) {
  const provider = getProvider();

  if (!await provider.helperReady()) {
    emitError('start', new Error('autonomous privileged helper is not installed or is not authorized. Run once: fortin setup'));
    return;
  }

  if (await provider.isVpnRunning()) {
    if (jsonMode) emitError('start', new Error('VPN is already connected, use "fortin stop" to disconnect first'));
    else {
      say('VPN is already connected');
      say('Use "fortin stop" to disconnect first');
    }
    process.exitCode = 1;
    return;
  }

  let foregroundMode = false;
  const overrides = { debugScreenshots: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-s': case '--server': overrides.vpnServer = args[++i]; break;
      case '-p': case '--port': overrides.vpnPort = args[++i]; break;
      case '-u': case '--username': overrides.username = args[++i]; break;
      case '-P': case '--password': overrides.password = args[++i]; break;
      case '-t': case '--totp-secret': overrides.totpSecret = args[++i]; break;
      case '-r': case '--realm': overrides.vpnRealm = args[++i]; break;
      case '--no-headless': overrides.headless = false; break;
      case '--headless': overrides.headless = true; break;
      case '-f': case '--foreground': foregroundMode = true; break;
      case '--push': overrides.authMethod = 'push'; break;
      case '--totp': overrides.authMethod = 'totp'; break;
      case '--debug-screenshots': overrides.debugScreenshots = true; break;
      default: break;
    }
  }

  const backgroundMode = !foregroundMode;
  const { session, logger } = createSession({ toFile: true, owner: 'detached' });

  // The migration and the fresh read of the configuration happen first, so what
  // this command was told on the command line is not overwritten by the file.
  await session.start({ poll: false });

  // The environment wins over the store and the store over the file; a flag of
  // this command wins over all three, exactly as it always did.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) continue;
    session.config[key] = value;
  }

  // Limpia la URL del servidor (protocolo y rutas).
  if (session.config.vpnServer) {
    session.config.vpnServer = session.config.vpnServer
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .trim();
  }

  attachCredentialPrompt(session);

  let interrupting = false;
  const onSignal = async () => {
    if (interrupting) return;
    interrupting = true;
    say(backgroundMode ? '\nCancelling...' : '\nDisconnecting...');
    const cancelled = await session.cancel({ wait: true });
    if (cancelled.accepted !== true) await session.disconnect({ wait: true });
    session.quit();
    logger.dispose();
    process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const result = await session.connect({
      authMethod: session.config.authMethod,
      foreground: foregroundMode,
      wait: true,
    });
    if (result.accepted !== true) {
      throw new Error(result.message ?? `The connection was refused (${result.reason})`);
    }

    if (backgroundMode) {
      if (!jsonMode) {
        say('\nTo check status: fortin status');
        say('To disconnect:   fortin stop');
        say('');
      }
      emitResult('start', session.snapshot());
      // The tunnel stays up on purpose: it is detached from this process.
      session.quit();
      logger.dispose();
      process.exitCode = 0;
      return;
    }

    await waitForTunnelEnd(session, provider);
    emitResult('start', session.snapshot());
    session.quit();
    logger.dispose();
    process.exitCode = 0;
  } catch (error) {
    if (error.code === 'ALREADY_CONNECTED') {
      if (jsonMode) emitError('start', error);
      else {
        say('VPN is already connected');
        say('Use "fortin stop" to disconnect first');
      }
      process.exitCode = 1;
    } else if (error.code === 'HELPER_NOT_READY') {
      emitError('start', new Error('autonomous privileged helper is not installed or is not authorized. Run once: fortin setup'));
    } else if (error.code === 'CLIENT_MISSING' && provider.id !== 'darwin') {
      emitError('start', new Error('openfortivpn not installed'));
    } else {
      emitError('start', error);
    }
    await session.cancel().catch(() => {});
    session.quit();
    logger.dispose();
  }
}

/* ------------------------------------------------------------ command line */

/**
 * The command line tool of the installed application.
 *
 * The build ships a launcher inside the bundle (resources/cli, wired in
 * electron-builder.yml) that runs this file with the Electron binary of the
 * application and ELECTRON_RUN_AS_NODE=1. Installing the application never
 * touches the PATH, so that launcher is the only copy of this CLI on the
 * machine: "cli install" links it into a directory of the PATH, "cli status"
 * says which copy a new terminal runs and "cli uninstall" takes the link away.
 */

/** Name of the command the build ships. */
const LAUNCHER_NAME = 'fortin';

/** What a directory of the PATH holds: the launcher itself, or its .cmd copy on Windows. */
const COMMAND_FILE = process.platform === 'win32' ? LAUNCHER_NAME + '.cmd' : LAUNCHER_NAME;

/** Second line of the shim, so the tool recognizes a file it wrote itself. */
const SHIM_MARKER = '@rem ' + LAUNCHER_NAME + ' shim for ';

/**
 * Launcher of this build, whether or not the file is there.
 *
 * FORTIN_LAUNCHER names it directly. A checkout uses that variable to
 * exercise the linking of the command without an installed application; the
 * rest of the time the launcher lives next to the app.asar of the bundle.
 */
function launcherPath() {
  const override = String(process.env.FORTIN_LAUNCHER ?? '').trim();
  if (override) return path.resolve(override);
  if (!isPackagedExecutable()) return null;
  if (process.platform === 'darwin') {
    const bundle = bundleOf(process.execPath);
    return bundle ? path.join(bundle, 'Contents', 'Resources', 'cli', LAUNCHER_NAME) : null;
  }
  return path.join(path.dirname(process.execPath), 'resources', 'cli', COMMAND_FILE);
}

/** Directories of the PATH, resolved, in the order a shell searches them. */
function pathDirectories() {
  return String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.resolve(directory));
}

/** True when a shell searches this directory. */
function inPath(directory) {
  const wanted = path.resolve(directory);
  return pathDirectories().some((entry) => entry === wanted);
}

/** True when the directory is there and takes new files. */
function writable(directory) {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the command can land in the directory: it accepts files, or it is
 * not there yet and the closest directory above it accepts them, which is what
 * creating it needs.
 */
function usable(directory) {
  let current = path.resolve(directory);
  for (;;) {
    const stats = fileStats(current);
    if (stats) return stats.isDirectory() && writable(current);
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** True when the file can be run. */
function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Directory the --dir flag names, or null when the flag is not there. */
function commandDirectory(args) {
  const index = args.indexOf('--dir');
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error('--dir needs a directory');
  const expanded = value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(expanded);
}

/** First directory of the PATH that takes the command without administrator rights. */
function defaultCommandDirectory() {
  const candidates = process.platform === 'win32'
    ? [path.join(os.homedir(), 'bin')]
    : [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin'];
  return candidates.find((directory) => inPath(directory) && usable(directory))
    ?? candidates.find((directory) => usable(directory))
    ?? null;
}

/** lstat of a file, or null when the file is not there. */
function fileStats(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/** True when a link, or a shim, calls the launcher of this build. */
function callsTarget(target, launcher) {
  return Boolean(target) && Boolean(launcher) && path.resolve(target) === path.resolve(launcher);
}

/** Launcher a shim calls, or null when the file is not a shim of this tool. */
function shimTarget(file) {
  try {
    const line = String(fs.readFileSync(file, 'utf8')).split(os.EOL)[1]?.trim() ?? '';
    return line.startsWith(SHIM_MARKER) ? line.slice(SHIM_MARKER.length).trim() : null;
  } catch {
    return null;
  }
}

/**
 * What a directory holds under the name of the command:
 *   missing  nothing
 *   ours     a link, or a shim, of this application
 *   link     a link to another program
 *   file     a file that is not a shim of this tool
 *   other    something else, a directory for example
 */
function commandState(directory, launcher) {
  const entry = path.join(directory, COMMAND_FILE);
  const stats = fileStats(entry);
  if (!stats) return { dir: directory, path: entry, state: 'missing', target: null };
  if (stats.isSymbolicLink()) {
    const target = path.resolve(path.dirname(entry), fs.readlinkSync(entry));
    return { dir: directory, path: entry, state: callsTarget(target, launcher) ? 'ours' : 'link', target };
  }
  if (stats.isFile()) {
    const target = shimTarget(entry);
    return { dir: directory, path: entry, state: callsTarget(target, launcher) ? 'ours' : 'file', target };
  }
  return { dir: directory, path: entry, state: 'other', target: null };
}

/** The copy of the command a new terminal runs, or null when the PATH holds none. */
function pathCommand(launcher) {
  for (const directory of pathDirectories()) {
    const state = commandState(directory, launcher);
    if (state.state !== 'missing') return state;
  }
  return null;
}

/** What a state means, in the messages of the three commands. */
function describeCommand(state) {
  if (state.state === 'ours') return 'this tool (' + state.target + ')';
  if (state.state === 'link') return 'another program (' + state.target + ')';
  if (state.state === 'file') return 'a file that is not a link of this tool';
  if (state.state === 'other') return 'something that is not a file';
  return 'not installed';
}

/** Between double quotes, which is all the paths of this tool need. */
function quoted(value) {
  return '"' + String(value) + '"';
}

/** Name of a backup file, without the characters a file name should not carry. */
function stamp() {
  return new Date().toISOString().slice(0, 19).replaceAll(':', '-');
}

/** Writes the command of a directory: a link of the launcher, or the shim of Windows. */
function writeCommand(file, launcher) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'win32') {
    const lines = ['@echo off', SHIM_MARKER + launcher, '"' + launcher + '" %*', 'exit /b %ERRORLEVEL%'];
    fs.writeFileSync(file, lines.join(os.EOL));
    return;
  }
  fs.symlinkSync(launcher, file);
}

/** Everything the three commands answer, and everything they print. */
function commandLineState({ dir = null, launcher = null } = {}) {
  const file = launcher ?? launcherPath();
  const present = Boolean(file) && fs.existsSync(file);
  const directory = dir ?? defaultCommandDirectory();
  const link = directory ? commandState(directory, file) : null;
  const runs = pathCommand(file);
  return {
    ok: present,
    launcher: file,
    packaged: isPackagedExecutable(),
    reason: present ? '' : (file ? 'launcher-missing' : 'no-application'),
    command: COMMAND_FILE,
    link: link ? { dir: link.dir, path: link.path, state: link.state, target: link.target } : null,
    onPath: Boolean(directory) && inPath(directory),
    runs: runs ? { path: runs.path, dir: runs.dir, target: runs.target, ours: runs.state === 'ours' } : null,
  };
}

/** True when the application runs from a place that will be gone later: a disk image. */
function temporaryApplication(launcher) {
  return launcher.startsWith('/Volumes/') || launcher.includes('/AppTranslocation/');
}

/** The command that puts this tool where a new terminal finds it first. */
function replaceHint(state) {
  if (!state.launcher || !state.runs || state.runs.ours) return null;
  return 'sudo ' + quoted(state.launcher) + ' cli install --dir ' + quoted(state.runs.dir) + ' --force';
}

/** Why this run cannot install the command, in one sentence. */
function noApplicationMessage() {
  return 'The command line tool ships with the installed application, and this run is not one of them.'
    + ' Install the application, then run "cli install" from the launcher of its bundle'
    + ' (Contents/Resources/cli/fortin on macOS, resources/cli on Linux).';
}


async function cliStatusCommand(args, { command }) {
  let dir = null;
  try {
    dir = commandDirectory(args);
  } catch (error) {
    emitError(command, error);
    return;
  }

  const state = commandLineState({ dir });
  say(state.ok ? 'Launcher: ' + state.launcher : 'Launcher: none');
  if (!state.ok) warn(noApplicationMessage());
  if (state.ok && temporaryApplication(state.launcher)) {
    warn('Warning: the application runs from a disk image or a temporary copy. Install it in /Applications first.');
  }
  if (state.link) {
    say('Command:  ' + state.link.path + ', ' + describeCommand(state.link));
    say('PATH:     ' + state.link.dir + (state.onPath ? ' is in the PATH' : ' is not in the PATH'));
  }
  if (state.runs) {
    say('Terminal: ' + state.runs.path + ', ' + (state.runs.ours ? 'this tool' : 'another program'));
    const hint = replaceHint(state);
    if (hint) warn('Warning: a new terminal runs that copy. Replace it with: ' + hint);
  }

  emitResult('cli status', state);
  process.exitCode = state.ok ? 0 : 1;
}

async function cliInstallCommand(args, { command }) {
  const force = args.includes('--force');
  let state = null;
  try {
    const launcher = launcherPath();
    state = commandLineState({ dir: commandDirectory(args) ?? defaultCommandDirectory(), launcher });
  } catch (error) {
    emitError(command, error);
    return;
  }

  if (!state.ok) {
    emitError(command, new Error(state.reason === 'no-application'
      ? noApplicationMessage()
      : 'The launcher of this application is not there: ' + state.launcher));
    return;
  }
  if (temporaryApplication(state.launcher) && !force) {
    emitError(command, new Error('The application runs from a disk image or a temporary copy, so the link would break.'
      + ' Move it to the Applications folder and run this again, or use --force.'));
    return;
  }
  if (!state.link) {
    emitError(command, new Error('No directory of the PATH takes new files without administrator rights. Name one with --dir.'));
    warn('  sudo ' + quoted(state.launcher) + ' cli install --dir /usr/local/bin');
    return;
  }
  if (!usable(state.link.dir)) {
    emitError(command, new Error('Cannot write in ' + state.link.dir + '. Run the same command with administrator rights.'));
    warn('  sudo ' + quoted(state.launcher) + ' cli install --dir ' + quoted(state.link.dir));
    return;
  }
  if (process.platform !== 'win32' && !executable(state.launcher)) {
    emitError(command, new Error('The launcher is not executable: ' + state.launcher));
    return;
  }

  const current = commandState(state.link.dir, state.launcher);
  const created = current.state === 'missing';
  let replaced = null;
  let backup = null;

  if (current.state === 'ours') {
    // The link is the one this build wants, so there is nothing to write.
  } else if (created) {
    writeCommand(current.path, state.launcher);
  } else if (!force) {
    emitError(command, new Error(current.path + ' is ' + describeCommand(current) + '. Use --force to replace it.'));
    return;
  } else if (current.state === 'link' || (current.state === 'file' && process.platform === 'win32')) {
    fs.unlinkSync(current.path);
    writeCommand(current.path, state.launcher);
    replaced = current.state;
  } else if (current.state === 'file') {
    backup = current.path + '.backup-' + stamp();
    fs.renameSync(current.path, backup);
    writeCommand(current.path, state.launcher);
    replaced = 'file';
  } else {
    emitError(command, new Error('Cannot replace ' + current.path + ': ' + describeCommand(current)));
    return;
  }

  const after = commandLineState({ dir: state.link.dir, launcher: state.launcher });
  say(created || replaced ? 'Installed: ' + current.path + ' -> ' + state.launcher : 'Already installed: ' + current.path + ' -> ' + state.launcher);
  if (backup) say('The file that was there is now ' + backup);
  if (!after.onPath) {
    warn('Warning: ' + state.link.dir + ' is not in the PATH, so the command has no name in a terminal yet.');
    warn('  Add that directory to the PATH of your shell, or install into one that already is:');
    warn('  sudo ' + quoted(state.launcher) + ' cli install --dir /usr/local/bin');
  }
  const hint = replaceHint(after);
  if (hint) warn('Warning: a new terminal runs ' + after.runs.path + ' instead. Replace it with: ' + hint);
  if (after.runs && after.runs.ours) say('Open a new terminal and run: ' + LAUNCHER_NAME + ' status');

  emitResult(command, { ...after, created, replaced, backup });
  process.exitCode = 0;
}

async function cliUninstallCommand(args, { command }) {
  const force = args.includes('--force');
  let launcher = null;
  let directory = null;
  try {
    launcher = launcherPath();
    directory = commandDirectory(args);
  } catch (error) {
    emitError(command, error);
    return;
  }

  if (!launcher || !fs.existsSync(launcher)) {
    emitError(command, new Error(launcher
      ? 'The launcher of this application is not there: ' + launcher
      : noApplicationMessage()));
    return;
  }

  if (!directory) {
    directory = defaultCommandDirectory();
    const runs = pathCommand(launcher);
    if (runs && (!directory || commandState(directory, launcher).state === 'missing')) directory = runs.dir;
  }
  if (!directory) {
    emitError(command, new Error('No directory of the PATH to look in. Name one with --dir.'));
    return;
  }

  const current = commandState(directory, launcher);
  let removed = false;
  let backup = null;

  if (current.state === 'ours') {
    fs.unlinkSync(current.path);
    removed = true;
  } else if (current.state === 'missing') {
    // There is nothing to take away.
  } else if (!force) {
    emitError(command, new Error(current.path + ' is ' + describeCommand(current) + '. Use --force to remove it.'));
    return;
  } else if (current.state === 'file' && process.platform !== 'win32') {
    backup = current.path + '.backup-' + stamp();
    fs.renameSync(current.path, backup);
    removed = true;
  } else if (current.state === 'link' || current.state === 'file') {
    fs.unlinkSync(current.path);
    removed = true;
  } else {
    emitError(command, new Error('Cannot remove ' + current.path + ': ' + describeCommand(current)));
    return;
  }

  say(removed ? 'Removed ' + current.path : 'Nothing to remove: ' + current.path + ' is not there');
  if (backup) say('The file that was there is now ' + backup);

  const after = commandLineState({ dir: directory, launcher });
  emitResult(command, { ...after, removed, backup });
  process.exitCode = 0;
}


/* ------------------------------------------------------------------- dispatch */

/**
 * Command table. src/core/api.js names the command that answers each core
 * operation, and test/parity.test.js checks that every name here matches.
 */
export const CLI_COMMANDS = {
  start: { summary: 'Connect to VPN (default, runs in background)', run: startCommand },
  stop: { summary: 'Disconnect from VPN', run: stopCommand },
  status: { summary: 'Show VPN connection status', run: statusCommand },
  watch: { summary: 'Follow the state in the foreground until Ctrl-C', run: watchCommand },
  setup: {
    // Without a subcommand it stays the alias it always was: `fortin
    // setup` installs the privileged helper.
    summary: 'Initial setup (alias of "helper install" without a subcommand)',
    run: setupCommand,
    subcommands: {
      status: { summary: 'Where the initial setup stands', run: setupStatusCommand },
      complete: { summary: 'Mark the initial setup as completed', run: setupCompleteCommand },
      skip: { summary: 'Postpone it: the app stops asking', run: setupSkipCommand },
      reset: { summary: 'Forget the decision, so the app asks again', run: setupResetCommand },
    },
  },
  helper: {
    summary: 'Privileged helper and VPN client',
    subcommands: {
      status: { summary: 'Helper and client status', run: helperStatusCommand },
      install: { summary: 'Install the privileged helper', run: setupCommand },
    },
  },
  config: {
    summary: 'Configuration file and secret store',
    subcommands: {
      get: { summary: 'Show the configuration', run: configGetCommand },
      set: { summary: 'Change configuration values', run: configSetCommand },
    },
  },
  secrets: {
    summary: 'Secrets of the system store',
    subcommands: {
      status: { summary: 'Which secrets exist and where they live', run: secretsStatusCommand },
      set: { summary: 'Store a secret, read from the terminal', run: secretsSetCommand },
      delete: { summary: 'Remove a secret', run: secretsDeleteCommand },
    },
  },
  'login-item': {
    summary: 'Start at login',
    subcommands: {
      status: { summary: 'What the system holds', run: loginItemStatusCommand },
      enable: { summary: 'Start the application at login', run: (args, ctx) => loginItemSetCommand(true, ctx) },
      disable: { summary: 'Do not start the application at login', run: (args, ctx) => loginItemSetCommand(false, ctx) },
    },
  },
  cli: {
    summary: 'Command line tool of the installed application',
    subcommands: {
      status: { summary: 'Where the tool is, and which copy a terminal runs', run: cliStatusCommand },
      install: { summary: 'Link the tool into a directory of the PATH', run: cliInstallCommand },
      uninstall: { summary: 'Remove that link', run: cliUninstallCommand },
    },
  },
  logs: { summary: 'Last lines of the current log file', run: logsCommand },
  info: { summary: 'Version, platform, paths and provider', run: infoCommand },
  version: { summary: 'Version only', run: versionCommand },
  doctor: { summary: 'Aggregated state, read only', run: doctorCommand },
  help: {
    summary: 'Show this help message',
    run: async () => {
      process.stdout.write(HELP_TEXT);
      process.exitCode = 0;
    },
  },
};

function parseArgv(argv) {
  const args = [...argv];
  const json = args.includes('--json');
  const help = args.includes('-h') || args.includes('--help');
  const rest = args.filter((argument) => argument !== '--json');

  let command = 'start';
  const commandIndex = rest.findIndex((argument) => !argument.startsWith('-'));
  if (commandIndex !== -1) {
    command = rest[commandIndex].toLowerCase();
    rest.splice(commandIndex, 1);
  }

  let subcommand = null;
  const entry = CLI_COMMANDS[command];
  if (entry?.subcommands && rest.length > 0 && !rest[0].startsWith('-')) {
    subcommand = rest.shift().toLowerCase();
  }

  return { command, subcommand, args: rest, json, help };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  jsonMode = parsed.json;

  // The line that names the configuration file is worth reading once per run,
  // never once per read, and in --json mode the standard output belongs to the
  // JSON document.
  let configLogged = false;
  setConfigLog((line) => {
    if (configLogged) return;
    configLogged = true;
    (jsonMode ? process.stderr : process.stdout).write(`${line}\n`);
  });

  const entry = CLI_COMMANDS[parsed.command];
  if (!entry) {
    emitError(parsed.command, new Error(`Unknown command: ${parsed.command}. Use "fortin help" for usage information`));
    return;
  }

  if (parsed.help && parsed.command !== 'help') {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 0;
    return;
  }

  // A group may answer a subcommand and, without one, keep the command it always
  // had: `setup` installs the privileged helper, `setup status` reports it.
  const run = entry.subcommands ? (entry.subcommands[parsed.subcommand]?.run ?? entry.run) : entry.run;
  if (!run) {
    const known = entry.subcommands ? Object.keys(entry.subcommands) : [];
    emitError(
      parsed.subcommand ? `${parsed.command} ${parsed.subcommand}` : parsed.command,
      new Error(`Usage: fortin ${parsed.command} <${known.join('|')}>`),
    );
    return;
  }

  const command = parsed.subcommand ? `${parsed.command} ${parsed.subcommand}` : parsed.command;
  try {
    await run(parsed.args, { command, json: jsonMode });
  } catch (error) {
    emitError(command, error);
  }
}

/** True when this file is the program that was started, symlinks included. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    process.stderr.write(`Fatal error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
