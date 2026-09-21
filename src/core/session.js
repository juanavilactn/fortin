/**
 * VpnSession: the session both front ends share.
 *
 * Everything that is not a window and not a terminal lives here. The desktop
 * application builds one session, keeps its window and its tray on top of it
 * and paints notifications; the CLI builds one session, prints what happens and
 * asks on the terminal when the core needs a password. Neither of them talks to
 * the tunnel, the configuration file, the secret store or the privileged helper
 * directly.
 *
 * The session owns:
 *   - the secret migration of an older version, the configuration file and the
 *     logger;
 *   - the VpnController: sign-in, tunnel, reconnect loop and keep-awake hold;
 *   - the periodic status check, which is what makes the state of a tunnel
 *     started from another process visible here too;
 *   - the privileged helper: status and installation;
 *   - the login item, through src/core/login-item.js and the platform provider;
 *   - the log file: where it is and its last lines.
 *
 * Events, the same names the window already subscribes to:
 *   'state'                {state, message, since, pid}
 *   'log'                  {level, message, time}
 *   'progress'             {step, message, kind}
 *   'credentials:request'  {id, kind, message, attempt, max}
 *   'helper:changed'       the helper status the installation left behind
 *
 * Credentials never cross this module as data: the session emits a request with
 * an id and waits. The adapter that knows how to ask (the window modal, the
 * terminal prompt) answers with answerCredentials(id, {value}). The value lives
 * only in the promise that the flow is waiting for.
 *
 * Owner policy of the tunnel, decided by the adapter:
 *   'app'       the tunnel belongs to the session. quit() takes it down, because
 *               a root-owned tunnel with no window to control it is worse than a
 *               dropped connection. The desktop application uses this.
 *   'detached'  the tunnel outlives the process on purpose. quit() leaves it and
 *               its keep-awake hold alone, so `fortin start` returns and
 *               the tunnel stays up. Stopping it is then a separate command.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { CANCELLED_CODE } from './auth.js';
import { commandLineStatus, installCommandLine } from './command-line.js';
import {
  CONFIG_FIELDS,
  deleteConfigKeys,
  getActiveConfigFile,
  getPaths,
  loadConfig,
  migrateSecretsToStore,
  saveConfig,
} from './config.js';
import { applyLoginItem, loginItemStatus as readLoginItemStatus } from './login-item.js';
import { Logger } from './logger.js';
import { getProvider } from './platform/index.js';
import { SECRET_NAMES, deleteSecret, hasSecret, setSecret, storeInfo } from './secrets.js';
import { SETUP_STEPS, SETUP_VERSION, readSetupFlags, setupDecision, writeSetupFlags } from './setup.js';
import { VpnController } from './vpn.js';

/** How often the tunnel state is re-checked, so every front end stays in sync. */
const STATUS_POLL_MS = 15000;
const LOGS_RECENT_DEFAULT = 200;
const LOGS_RECENT_MAX = 5000;

/** Environment variables that override config.json, in the order core reads them. */
const ENV_VARIABLES = [
  'VPN_SERVER',
  'VPN_PORT',
  'VPN_REALM',
  'VPN_USERNAME',
  'VPN_PASSWORD',
  'VPN_TOTP_SECRET',
  'VPN_AUTH_METHOD',
  'VPN_HEADLESS',
  'VPN_TRUSTED_CERT',
  'FORTIN_CONFIG',
];

/** Fields the window never receives in clear and must not send back empty. */
const SECRET_FIELDS = ['password', 'totpSecret'];

/** Names of the secrets as they are written in the log, never by value. */
const SECRET_LABELS = {
  [SECRET_NAMES.password]: 'password',
  [SECRET_NAMES.totpSecret]: 'TOTP secret',
  [SECRET_NAMES.cookie]: 'session cookie',
};

export class VpnSession extends EventEmitter {
  #controller;
  #pendingCredentials = new Map();
  #pollTimer = null;
  #installInFlight = null;
  #refreshInFlight = null;
  #lastState;
  #listeners = {};

  /**
   * @param {object} options
   * @param {object} options.config        configuration loaded by core/config.js
   * @param {Logger} options.logger        shared logger
   * @param {object} options.provider      platform provider
   * @param {object} options.paths         result of getPaths()
   * @param {'app'|'detached'} options.owner  tunnel policy on quit (see above)
   * @param {number} options.credentialsTimeoutMs  0 waits forever (terminal)
   * @param {boolean} options.allowLoginItemWrite  can this session write the
   *   login item at all: the desktop application passes app.isPackaged, the CLI
   *   leaves it true and the platform provider decides whether there is an
   *   application to launch
   * @param {boolean} options.syncLoginItem  keeps the system equal to the stored
   *   startAtLogin at startup and after every save: the application does, a
   *   one-shot command does not
   */
  constructor({
    config = {},
    logger = null,
    provider = null,
    paths = null,
    screenshotsDir = null,
    debugScreenshots = false,
    owner = 'app',
    pollIntervalMs = STATUS_POLL_MS,
    credentialsTimeoutMs = 0,
    allowLoginItemWrite = false,
    syncLoginItem = false,
    loginItemEnv = null,
    controller = null,
  } = {}) {
    super();
    this.logger = logger ?? new Logger({ toFile: false, mirror: 'none' });
    this.provider = provider ?? getProvider();
    this.paths = paths ?? getPaths();
    this.config = config;
    this.owner = owner === 'detached' ? 'detached' : 'app';
    this.pollIntervalMs = pollIntervalMs;
    this.credentialsTimeoutMs = credentialsTimeoutMs;
    this.allowLoginItemWrite = allowLoginItemWrite;
    this.syncLoginItem = syncLoginItem;
    this.loginItemEnv = loginItemEnv ?? {};

    this.#controller = controller ?? new VpnController({
      config: this.config,
      logger: this.logger,
      provider: this.provider,
      screenshotsDir: screenshotsDir ?? this.paths.screenshotsDir,
      debugScreenshots,
    });

    this.#lastState = { state: this.#controller.getState(), message: '', since: Date.now(), pid: null };
    this.#listeners = {
      state: (payload) => this.#handleState(payload),
      log: (line) => this.emit('log', line),
      progress: (payload) => this.emit('progress', payload ?? {}),
    };
    this.#controller.on('state', this.#listeners.state);
    this.#controller.on('log', this.#listeners.log);
    this.#controller.on('progress', this.#listeners.progress);
  }

  /** The controller in use, for the parts of an adapter that need its identity. */
  get controller() {
    return this.#controller;
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Startup sequence of a session, in the order the application always used:
   * move the plaintext secrets of an older version, read the configuration
   * again, make the system match the stored login item and start the periodic
   * status check.
   *
   * A one-shot command passes `poll: false` (it is about to exit) and leaves
   * `syncLoginItem` false (a command that only reads must not rewrite the system).
   */
  async start({ poll = true, syncLoginItem = this.syncLoginItem } = {}) {
    this.migrateSecrets();
    this.reloadConfig();
    if (syncLoginItem) this.syncStoredLoginItem();
    if (poll) this.startPolling();
    return this.snapshot();
  }

  /** One-time move of the plaintext secrets an older version left behind. */
  migrateSecrets() {
    return migrateSecretsToStore({ log: (line) => this.logger.log(line) });
  }

  /** Reads the configuration file again, in place: the controller holds this object. */
  reloadConfig() {
    Object.assign(this.config, loadConfig());
    return this.config;
  }

  /** Stops the timers and forgets the pending credential requests. Never touches the tunnel. */
  stop() {
    this.stopPolling();
    this.#controller.off('state', this.#listeners.state);
    this.#controller.off('log', this.#listeners.log);
    this.#controller.off('progress', this.#listeners.progress);
    this.cancelPendingCredentials('The session is closing');
  }

  /**
   * Ends the session and applies the owner policy on the tunnel. The tunnel of
   * a detached session is left running on purpose, together with its keep-awake
   * hold, so the process can exit without taking the connection down.
   */
  quit() {
    this.stop();
    if (this.owner === 'app') this.#controller.releaseForQuit();
    return { ok: true, owner: this.owner };
  }

  /* ----------------------------------------------------------------- state */

  getState() {
    return this.#controller.getState();
  }

  /** Last state the window and the CLI were told about. */
  snapshot() {
    return { ...this.#lastState };
  }

  isBusy() {
    const state = this.getState();
    return state === 'connecting' || state === 'disconnecting';
  }

  /** The machine is going to sleep. Only the desktop application can know. */
  handleSuspend() {
    this.#controller.handleSuspend();
  }

  /** Back from sleep: check the tunnel at once. Only the desktop can know. */
  async handleResume() {
    await this.#controller.handleResume();
    return this.snapshot();
  }

  /**
   * Re-checks the tunnel against the machine. The desktop calls it on a timer;
   * the terminal calls it from `status` and `watch`.
   */
  async refreshStatus() {
    if (this.#refreshInFlight) return this.#refreshInFlight;
    this.#refreshInFlight = (async () => {
      try {
        if (typeof this.#controller.refreshStatus === 'function') await this.#controller.refreshStatus();
        return this.snapshot();
      } catch (error) {
        this.logger.error(`Cannot refresh the VPN status: ${error?.message ?? error}`);
        return this.snapshot();
      } finally {
        this.#refreshInFlight = null;
      }
    })();
    return this.#refreshInFlight;
  }

  /**
   * Periodic status check. The timer is unref'd, so it never keeps a process
   * alive on its own.
   */
  startPolling({ intervalMs = this.pollIntervalMs } = {}) {
    if (this.#pollTimer) return this.#pollTimer;
    const poll = () => {
      this.refreshStatus().catch(() => {});
    };
    poll();
    this.#pollTimer = setInterval(poll, intervalMs);
    if (typeof this.#pollTimer.unref === 'function') this.#pollTimer.unref();
    return this.#pollTimer;
  }

  stopPolling() {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  /* --------------------------------------------------- connect / disconnect */

  /**
   * Starts a connection. With the default arguments it only reports whether the
   * attempt was accepted: the window watches the outcome through the events.
   * `wait: true` is for the terminal, which has an exit code to give and awaits
   * the whole attempt, error included.
   */
  async connect({ authMethod, foreground = false, wait = false } = {}) {
    const state = this.getState();
    if (state === 'connected') return { accepted: false, reason: 'already-connected', ...this.snapshot() };
    if (state === 'connecting' || state === 'disconnecting') {
      return { accepted: false, reason: state, ...this.snapshot() };
    }

    const method = this.#normaliseAuthMethod(authMethod);
    const inForeground = Boolean(foreground);

    let attempt;
    try {
      attempt = this.#startAttempt({ authMethod: method, foreground: inForeground });
    } catch (error) {
      this.logger.error(`Connect failed: ${error?.message ?? error}`);
      return { accepted: false, reason: 'error', message: error?.message ?? String(error), ...this.snapshot() };
    }

    if (wait) await attempt;
    return { accepted: true, authMethod: method, foreground: inForeground, ...this.snapshot() };
  }

  /**
   * Closes the tunnel. `wait: true` is for the terminal: it reports whether the
   * tunnel really went down instead of only that the request was accepted.
   */
  async disconnect({ wait = false } = {}) {
    const state = this.getState();
    if (state === 'disconnected') return { accepted: false, reason: 'already-disconnected', ...this.snapshot() };
    if (state === 'connecting' || state === 'disconnecting') {
      return { accepted: false, reason: state, ...this.snapshot() };
    }

    const attempt = this.#guard('Disconnect failed', this.#controller.disconnect());
    if (wait) {
      const stopped = await attempt;
      return { accepted: true, stopped: stopped === true, ...this.snapshot() };
    }
    return { accepted: true, ...this.snapshot() };
  }

  /**
   * Stops the attempt in flight. Only a sign-in that is running can be
   * cancelled; every other state is refused with the state that was found.
   */
  async cancel({ wait = false } = {}) {
    const state = this.getState();
    if (state !== 'connecting') return { accepted: false, reason: state, ...this.snapshot() };

    const attempt = this.#guard('Cancel failed', this.#controller.cancel());
    if (wait) await attempt;
    return { accepted: true, ...this.snapshot() };
  }

  /* --------------------------------------------------------------- config */

  /**
   * What the settings form shows: the configuration without secrets, which
   * secrets exist, where they live, the fields, the environment overrides and
   * the paths. The window and `config get` receive the same payload.
   */
  configGet() {
    const current = loadConfig();
    const visible = { ...current };
    for (const field of SECRET_FIELDS) visible[field] = '';

    // The store, not the file, is what the window reports: a value moved to the
    // store must keep the "(saved)" hint, and a deleted item must remove it.
    // The resolved value still counts, because the file holds the secret when
    // the machine has no store to hold it.
    const storedSecrets = {
      password: hasSecret(SECRET_NAMES.password) || Boolean(current.password),
      totpSecret: hasSecret(SECRET_NAMES.totpSecret) || Boolean(current.totpSecret),
    };

    return {
      ok: true,
      config: visible,
      fields: CONFIG_FIELDS,
      hasPassword: storedSecrets.password,
      hasTotpSecret: storedSecrets.totpSecret,
      secrets: storedSecrets,
      secretsStore: storeInfo(),
      // The answer of the initial setup, so `config get` in a terminal shows the
      // same thing the window reads from `setup:status`.
      setup: readSetupFlags(),
      envOverrides: ENV_VARIABLES.filter((name) => process.env[name] !== undefined),
      paths: {
        configDir: this.paths.dir,
        configFile: getActiveConfigFile(),
        logsDir: this.paths.logsDir,
        screenshotsDir: this.paths.screenshotsDir,
      },
    };
  }

  /**
   * Writes a configuration patch and answers the fresh configuration. An empty
   * secret keeps the stored one, and a save never writes a secret to the
   * configuration file while the system store is available.
   *
   * The login item follows the stored value only in a session that owns the
   * life of the application (`syncLoginItem`), which is the application. A
   * refusal of the system is reported and never fails the save.
   */
  configSave(payload) {
    const patch = payload && typeof payload === 'object' && payload.patch ? payload.patch : payload;
    if (!patch || typeof patch !== 'object') return { ok: false, message: 'No configuration received' };

    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      // The caller never receives secrets back, so an empty secret means "keep the stored one".
      if (SECRET_FIELDS.includes(key) && typeof value === 'string' && value.trim() === '') continue;
      if (key === 'authMethod' && value !== 'push' && value !== 'totp') continue;
      clean[key] = value;
    }

    try {
      saveConfig(clean, { log: (line) => this.logger.log(line) });
    } catch (error) {
      const message = `Cannot save the configuration: ${error?.message ?? error}`;
      this.logger.error(message);
      return { ok: false, message };
    }

    this.reloadConfig();

    const loginItem = this.syncLoginItem ? this.syncStoredLoginItem() : undefined;

    this.logger.log('Configuration saved');
    const answer = { ...this.configGet(), message: 'Configuration saved' };
    if (loginItem) answer.loginItem = loginItem;
    return answer;
  }

  /* -------------------------------------------------------------- secrets */

  /** Where the secrets live and which of them are present. Never a value. */
  secretsStatus() {
    const current = loadConfig();
    const store = storeInfo();
    const items = Object.values(SECRET_NAMES).map((name) => {
      const inStore = hasSecret(name);
      const inFile = this.#secretInFile(name, current);
      return {
        name,
        label: SECRET_LABELS[name] ?? name,
        present: inStore || inFile,
        where: inStore ? 'store' : (inFile ? 'file' : 'none'),
      };
    });
    return { ok: true, store, items };
  }

  /**
   * Stores one secret. With a system store it goes there; without one it goes to
   * the configuration file (mode 0600) and the logger says so. The value is
   * never returned and never logged.
   */
  secretSet(name, value) {
    const secret = resolveSecretName(name);
    if (!secret) return { ok: false, message: `Unknown secret: ${name}` };
    if (typeof value !== 'string' || value.trim() === '') return { ok: false, message: 'No value received' };

    try {
      if (secret === SECRET_NAMES.cookie) {
        // The session cookie has no place in the configuration file: it belongs
        // to the store, and the 0600 file is only read for compatibility.
        setSecret(secret, value);
        fs.rmSync(this.paths.cookieFile, { force: true });
      } else {
        saveConfig({ [secret]: value }, { log: (line) => this.logger.log(line) });
      }
    } catch (error) {
      return { ok: false, message: `Cannot store the ${SECRET_LABELS[secret] ?? secret}: ${error?.message ?? error}` };
    }

    this.reloadConfig();
    return { ok: true, name: secret, label: SECRET_LABELS[secret] ?? secret, ...this.secretsStatus() };
  }

  /**
   * Removes one secret from the store and from the configuration file, so a
   * value written by an older version cannot survive the delete. Deleting what
   * is not there is not a failure.
   */
  secretDelete(name) {
    const secret = resolveSecretName(name);
    if (!secret) return { ok: false, message: `Unknown secret: ${name}` };

    let deleted = false;
    try {
      if (hasSecret(secret)) {
        deleteSecret(secret);
        deleted = true;
      }
    } catch (error) {
      return { ok: false, message: `Cannot delete the ${SECRET_LABELS[secret] ?? secret}: ${error?.message ?? error}` };
    }

    try {
      const removedFromFile = deleteConfigKeys([secret]).removed;
      if (removedFromFile.length > 0) deleted = true;
      if (secret === SECRET_NAMES.cookie && fs.existsSync(this.paths.cookieFile)) {
        fs.rmSync(this.paths.cookieFile, { force: true });
        deleted = true;
      }
    } catch (error) {
      return { ok: false, message: `Cannot delete the ${SECRET_LABELS[secret] ?? secret}: ${error?.message ?? error}` };
    }

    this.reloadConfig();
    return { ok: true, name: secret, label: SECRET_LABELS[secret] ?? secret, deleted, ...this.secretsStatus() };
  }

  /* ---------------------------------------------------------------- setup */

  /**
   * Where the initial setup stands, and everything the window needs to walk
   * through it: the flags of the decision, the step list, the configuration the
   * settings form already reads, the helper and the login item. It never writes
   * and never prints a secret.
   */
  async setupStatus() {
    const configFile = getActiveConfigFile();
    const flags = readSetupFlags(configFile);
    const helper = await this.helperStatus();

    return {
      ok: true,
      ...setupDecision({
        config: loadConfig(),
        configFileExists: fs.existsSync(configFile),
        helperReady: helper.ready === true,
        flags,
      }),
      steps: SETUP_STEPS,
      config: this.configGet(),
      helper,
      loginItem: this.loginItemStatus(),
    };
  }

  /** The user walked through the whole assistant. */
  async setupComplete() {
    writeSetupFlags({ completed: true });
    this.reloadConfig();
    this.logger.log(`Initial setup completed (version ${SETUP_VERSION})`);
    return this.setupStatus();
  }

  /** The user chose "later". Nothing is lost, and the assistant stops asking. */
  async setupSkip() {
    writeSetupFlags({ skipped: true });
    this.reloadConfig();
    this.logger.log('Initial setup postponed');
    return this.setupStatus();
  }

  /** Forgets the answer, so the assistant shows up again at the next start. */
  async setupReset() {
    writeSetupFlags({ reset: true });
    this.reloadConfig();
    this.logger.log('Initial setup decision cleared');
    return this.setupStatus();
  }

  /* --------------------------------------------------------- command line */

  /** The command line tool of this build: the launcher, the link and the PATH. */
  async commandLineStatus() {
    return commandLineStatus();
  }

  /**
   * Links the command into the directory the tool picks, without administrator
   * rights and without replacing an entry of another program. A directory that
   * needs them is reported with the `sudo` command a terminal runs.
   */
  async commandLineInstall() {
    const result = await installCommandLine();
    this.logger.log(result.ok === true
      ? `Terminal command linked in ${result.directory ?? 'the PATH'}`
      : `The terminal command was not linked: ${result.message}`);
    return result;
  }

  /* --------------------------------------------------------------- helper */

  /** The privileged helper and the VPN client, as the helper banner shows them. */
  async helperStatus() {
    let ready = false;
    let readyError = '';
    try {
      ready = Boolean(await this.provider.helperReady());
    } catch (error) {
      readyError = error?.message ?? String(error);
    }

    let client = { ok: false, version: '', message: '' };
    try {
      if (typeof this.provider.ensureClient === 'function') client = await this.provider.ensureClient();
      else client = { ok: false, version: '', message: 'This provider cannot check the VPN client' };
    } catch (error) {
      client = { ok: false, version: '', message: error?.message ?? String(error) };
    }

    return {
      ok: true,
      id: this.provider.id,
      platform: process.platform,
      helperPath: this.provider.helperPath,
      ready,
      readyError,
      client: {
        ok: Boolean(client?.ok),
        version: client?.version ?? '',
        message: client?.message ?? '',
      },
    };
  }

  /** Installs the privileged helper once and reports the status it leaves behind. */
  async helperInstall({ useGui = true } = {}) {
    if (this.#installInFlight) return this.#installInFlight;

    this.#installInFlight = (async () => {
      try {
        if (typeof this.provider.installHelper !== 'function') {
          throw new Error('This provider cannot install the helper');
        }
        this.logger.log('Installing the privileged VPN helper...');
        await this.provider.installHelper({ onLog: (line) => this.emit('log', line), useGui });
        const status = await this.helperStatus();
        this.emit('helper:changed', status);
        this.logger.log(status.ready ? 'Helper ready' : 'Helper installed but not ready yet');
        return {
          ...status,
          ok: status.ready,
          message: status.ready ? 'Helper ready' : 'Helper installed but not ready yet',
        };
      } catch (error) {
        const message = error?.message ?? String(error);
        this.logger.error(`Helper installation failed: ${message}`);
        const status = await this.helperStatus();
        this.emit('helper:changed', status);
        return { ...status, ok: false, message };
      } finally {
        this.#installInFlight = null;
      }
    })();

    return this.#installInFlight;
  }

  /* ----------------------------------------------------------------- logs */

  /** The file the log panel follows: the target of latest.log, or the open stream. */
  logFilePath() {
    const latest = path.join(this.paths.logsDir, 'latest.log');
    try {
      return fs.realpathSync(latest);
    } catch {
      // No latest.log yet (or it is a copy on win32); fall back to the open stream.
    }
    if (this.logger.filePath && fs.existsSync(this.logger.filePath)) return this.logger.filePath;
    return latest;
  }

  /** Last lines of the current log file, as the activity panel reads them. */
  logsRecent({ lines } = {}) {
    const requested = Number(lines) || LOGS_RECENT_DEFAULT;
    const limit = Math.min(Math.max(requested, 1), LOGS_RECENT_MAX);
    const file = this.logFilePath();

    try {
      const all = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (all.length > 0 && all[all.length - 1] === '') all.pop();
      const tail = all.slice(-limit);
      return { ok: true, path: file, lines: tail, total: all.length, truncated: all.length > tail.length };
    } catch (error) {
      return {
        ok: false,
        path: file,
        lines: [],
        total: 0,
        truncated: false,
        message: `Cannot read the log file: ${error?.message ?? error}`,
      };
    }
  }

  /* ----------------------------------------------------------- login item */

  /** What the system holds right now for the login item. */
  loginItemStatus() {
    return readLoginItemStatus({ provider: this.provider, env: this.loginItemEnv });
  }

  /**
   * Makes the system match `enabled`. It is what the settings switch does when
   * it is saved and what `login-item enable|disable` does on the terminal.
   */
  loginItemSet(enabled) {
    return this.#applyLoginItem(enabled === true);
  }

  /** The system follows the stored value. Only a session that owns the application. */
  syncStoredLoginItem() {
    return this.#applyLoginItem(this.config.startAtLogin === true);
  }

  /* -------------------------------------------------------------- app info */

  /**
   * What the front end is and where it lives. The adapter adds what only it
   * knows (the Electron and Chrome versions, or whether the desktop application
   * runs packaged), so the window keeps receiving its own payload.
   */
  appInfo(extra = {}) {
    const pkg = packageInfo();
    return {
      name: pkg.name ?? 'fortin',
      productName: pkg.productName ?? pkg.name ?? 'fortin',
      version: pkg.version ?? '',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      configDir: this.paths.dir,
      configFile: getActiveConfigFile(),
      logsDir: this.paths.logsDir,
      screenshotsDir: this.paths.screenshotsDir,
      provider: { id: this.provider.id, helperPath: this.provider.helperPath },
      ...extra,
    };
  }

  /**
   * The aggregated state the window shows across its own screen, in one answer:
   * configuration file, paths, secret store, login item, helper, client, tunnel
   * and log file. Written for `doctor` on the terminal; it never connects, never
   * writes and never prints a secret.
   */
  async doctor() {
    const configFile = getActiveConfigFile();
    const status = await this.helperStatus();
    const setup = setupDecision({
      config: loadConfig(),
      configFileExists: fs.existsSync(configFile),
      helperReady: status.ready === true,
    });
    return {
      ok: true,
      app: this.appInfo(),
      config: {
        file: configFile,
        exists: fs.existsSync(configFile),
        envOverrides: ENV_VARIABLES.filter((name) => process.env[name] !== undefined),
        savedKeys: savedKeys(configFile),
      },
      tunnel: {
        ...this.snapshot(),
        owner: this.owner,
        running: await this.#isVpnRunning(),
      },
      helper: status,
      setup,
      secrets: this.secretsStatus(),
      loginItem: this.loginItemStatus(),
      logs: { file: this.logFilePath() },
      paths: {
        configDir: this.paths.dir,
        logsDir: this.paths.logsDir,
        screenshotsDir: this.paths.screenshotsDir,
        pidFile: this.paths.pidFile,
      },
    };
  }

  /* ------------------------------------------------------- credentials bridge */

  /**
   * Asks the adapter for a password. Emits 'credentials:request' and waits for
   * answerCredentials with the same id. Without a listener it rejects at once,
   * so a caller can tell "nobody can ask" from "the user said no".
   */
  requestCredentials(request = {}) {
    const options = typeof request === 'string' ? { reason: request } : request ?? {};
    const kind = options.kind === 'totp' ? 'totp' : 'password';
    const id = randomUUID();
    const payload = {
      id,
      kind,
      message: options.message ?? options.reason ?? (kind === 'totp' ? 'Enter the authentication code' : 'Enter your password'),
      attempt: Number(options.attempt) || 1,
      max: Number(options.max) || 3,
    };

    return new Promise((resolve, reject) => {
      if (this.listenerCount('credentials:request') === 0) {
        reject(new Error('No listener to request credentials'));
        return;
      }

      const timer = this.credentialsTimeoutMs > 0
        ? setTimeout(() => {
          this.#pendingCredentials.delete(id);
          reject(new Error('Timed out waiting for credentials'));
        }, this.credentialsTimeoutMs)
        : null;
      if (timer && typeof timer.unref === 'function') timer.unref();

      this.#pendingCredentials.set(id, { resolve, reject, timer });
      this.emit('credentials:request', payload);
    });
  }

  /**
   * Answers a request raised by requestCredentials. `cancel` is the user saying
   * no on purpose and rejects with the cancellation code, so the attempt ends as
   * a disconnection and never as a failure; `error` is the adapter telling it
   * could not ask (there is no window to show the modal in).
   */
  answerCredentials(id, { value, cancel, error } = {}) {
    const pending = this.#pendingCredentials.get(id);
    if (!pending) return { ok: false, message: 'No pending credential request with that id' };

    clearTimeout(pending.timer);
    this.#pendingCredentials.delete(id);

    if (error) {
      pending.reject(new Error(String(error)));
      return { ok: true };
    }
    if (cancel) {
      const failure = new Error('Cancelled by the user');
      failure.code = CANCELLED_CODE;
      pending.reject(failure);
      return { ok: true };
    }
    pending.resolve(typeof value === 'string' ? value : '');
    return { ok: true };
  }

  /** Fails every request in flight, as closing the session does. */
  cancelPendingCredentials(reason = 'Request cancelled') {
    for (const [id, pending] of [...this.#pendingCredentials.entries()]) {
      clearTimeout(pending.timer);
      this.#pendingCredentials.delete(id);
      pending.reject(new Error(reason));
    }
  }

  /* --------------------------------------------------------------- internals */

  #applyLoginItem(enabled) {
    return applyLoginItem({
      enabled,
      provider: this.provider,
      env: this.loginItemEnv,
      allow: this.allowLoginItemWrite,
      log: this.logger,
    });
  }

  #normaliseAuthMethod(requested) {
    if (requested === 'push' || requested === 'totp') return requested;
    return this.config.authMethod === 'totp' ? 'totp' : 'push';
  }

  /**
   * Starts the attempt and reports its failure through the logger, so an
   * adapter that does not wait (the window) never sees an unhandled rejection.
   * A caller that waits (the terminal) still gets the error.
   */
  #startAttempt({ authMethod, foreground }) {
    const pending = Promise.resolve(this.#controller.connect({
      authMethod,
      foreground,
      debugScreenshots: this.config.debugScreenshots === true,
      askPassword: (request) => this.requestCredentials(request),
    }));

    const attempt = pending.catch((error) => {
      // A cancel is not a failure: the controller settles the attempt as a
      // disconnection, so it is logged as a plain event.
      if (error?.code === CANCELLED_CODE) this.logger.log('Connection cancelled by the user');
      else this.logger.error(`Connect failed: ${error?.message ?? error}`);
      throw error;
    });
    attempt.catch(() => {});
    return attempt;
  }

  /** Wraps a controller promise so a failure is logged once and still propagates. */
  #guard(label, pending) {
    const attempt = Promise.resolve(pending).catch((error) => {
      this.logger.error(`${label}: ${error?.message ?? error}`);
      throw error;
    });
    attempt.catch(() => {});
    return attempt;
  }

  #handleState(payload = {}) {
    const next = {
      state: payload?.state ?? 'disconnected',
      message: payload?.message ?? '',
      since: payload?.since ?? Date.now(),
      pid: payload?.pid ?? null,
    };
    const changed =
      next.state !== this.#lastState.state || next.message !== this.#lastState.message || next.pid !== this.#lastState.pid;
    this.#lastState = next;
    if (changed) this.emit('state', next);
    return next;
  }

  #secretInFile(name, config) {
    if (name === SECRET_NAMES.cookie) return fs.existsSync(this.paths.cookieFile);
    return typeof config?.[name] === 'string' && config[name].trim() !== '';
  }

  async #isVpnRunning() {
    try {
      return await this.provider.isVpnRunning();
    } catch {
      return false;
    }
  }
}

/** Keys the configuration file holds, without the values. */
function savedKeys(configFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return Object.keys(parsed ?? {});
  } catch {
    return [];
  }
}

/**
 * The name of a secret as the store files it. Both spellings work: the key
 * ('cookie') and the name of the item ('svpnCookie'), because the terminal and
 * the window name the same secret differently.
 */
function resolveSecretName(name) {
  if (typeof name !== 'string') return null;
  if (Object.hasOwn(SECRET_NAMES, name)) return SECRET_NAMES[name];
  return Object.values(SECRET_NAMES).includes(name) ? name : null;
}

/** package.json, so the version of the front end lives in one place. */
function packageInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}
