import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { authenticate, CANCELLED_CODE } from './auth.js';
import { getPaths } from './config.js';
import { SECRET_NAMES, deleteSecret, getSecret, isStoreAvailable, setSecret } from './secrets.js';
import {
  clearPid,
  clearStopRequest,
  isProcessRunning,
  readPid,
  readStopRequest,
  requestStop,
  savePid,
} from './state.js';

const TUNNEL_READY_TIMEOUT_MS = 30000;
const TUNNEL_POLL_INTERVAL_MS = 1000;
const TUNNEL_LOG_NAME = 'tunnel.log';
const TUNNEL_LOG_TAIL_LINES = 20;

/** How often the tunnel is checked while the connection has to stay up. */
const HEALTH_CHECK_INTERVAL_MS = 15000;
/** Wait before each reconnect attempt, in order. Its length is the attempt cap. */
const RECONNECT_BACKOFF_MS = [5000, 10000, 20000, 30000, 60000, 60000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;
/** Attempts that reuse the last SVPNCOOKIE before going back to a full sign-in. */
const COOKIE_RECONNECT_ATTEMPTS = 1;

/** Waits, or gives up at once when the attempt in flight is cancelled. */
function wait(ms, signal = null) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function readTail(file, lines) {
  try {
    const content = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    return content.slice(-lines);
  } catch {
    return [];
  }
}

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * State and lifecycle of the tunnel.
 *
 * States: disconnected | connecting | connected | disconnecting | error.
 * Events: 'state' {state, message, since, pid}, 'log' (a Logger line) and
 * 'progress' {step, message, kind}.
 *
 * The tunnel has to stay up until the user disconnects. Two behaviours protect
 * that: the machine is held awake while connected, and a tunnel that drops on
 * its own is brought back without asking the user again.
 *
 * A sign-in in flight can be cancelled with cancel(): the attempt unwinds, the
 * tunnel it may have started is stopped and the state walks to disconnected,
 * never to error.
 */
export class VpnController extends EventEmitter {
  #state = 'disconnected';
  #message = '';
  #since = Date.now();
  #pid = null;
  #connecting = false;
  /** Abort handle of the session in flight: aborting it stops what is waiting. */
  #abort = null;
  /** Settles when the attempt started by connect() unwinds. */
  #attemptDone = null;
  /** Settles when the reconnect loop in flight unwinds. */
  #reconnectDone = null;
  /** The user cancelled, so the attempt must not report an error state. */
  #cancelled = false;
  /** Set when another process stopped this tunnel on purpose. */
  #stoppedOutside = false;
  #onLogLine = (line) => this.emit('log', line);

  /** What the user asked for, as opposed to what the tunnel is doing right now. */
  #intent = 'disconnected';
  #watchdog = null;
  #keepAwake = null;
  #reconnecting = false;
  #reconnectAttempts = 0;
  #nextAttemptAt = 0;
  #suspended = false;
  #lastCookie = null;
  /** Set when a reused cookie is refused, so later reconnects skip that dead end. */
  #cookieRejected = false;
  /** The fallback to the cookie file is reported once, not on every reconnect. */
  #cookieFileWarned = false;
  #foreground = false;
  #askPassword = null;
  #onProgress = null;

  constructor({ config, logger, provider, screenshotsDir, debugScreenshots = false, authenticator = authenticate }) {
    super();
    this.config = config;
    this.logger = logger ?? null;
    this.provider = provider;
    this.screenshotsDir = screenshotsDir ?? getPaths().screenshotsDir;
    this.debugScreenshots = Boolean(debugScreenshots);
    // The sign-in with Microsoft is the one step of a connection that a
    // provider double cannot replace, so a test injects it the same way it
    // injects the provider.
    this.authenticator = authenticator;
    this.#pid = readPid();
    // The session cookie outlives the process that stored it: a restart reuses
    // it, exactly like a reconnect inside the same run.
    this.#lastCookie = getSecret(SECRET_NAMES.cookie) || this.#readCookieFile();
    if (this.logger) this.logger.on('line', this.#onLogLine);
  }

  /** The 0600 file is where the cookie lives on a machine without a store. */
  #readCookieFile() {
    try {
      const cookie = fs.readFileSync(getPaths().cookieFile, 'utf8').trim();
      return cookie === '' ? null : cookie;
    } catch {
      return null;
    }
  }

  getState() {
    return this.#state;
  }

  getStateInfo() {
    return { state: this.#state, message: this.#message, since: this.#since, pid: this.#pid };
  }

  /** True while the user still wants the tunnel up, even if it is reconnecting. */
  isHolding() {
    return this.#intent === 'connected';
  }

  dispose() {
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    if (this.logger) this.logger.off('line', this.#onLogLine);
    this.removeAllListeners();
  }

  /**
   * The application is closing. The tunnel it opened belongs to it, so close it
   * too: a root-owned tunnel plus a wake assertion left behind with no window to
   * control them is worse than dropping the connection.
   */
  releaseForQuit() {
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    // An attempt in flight belongs to the window that is going away: cancel it
    // too, so no tunnel is left behind with no way to control it.
    this.#cancelled = true;
    this.#abort?.abort();
    if (this.#intent !== 'connected') return;
    this.#intent = 'disconnected';
    this.log('The application is closing, taking the tunnel down');
    Promise.resolve(this.provider.stop()).catch(() => {});
  }

  async connect({ authMethod, foreground = false, askPassword, onProgress, debugScreenshots } = {}) {
    if (this.#connecting) {
      throw new Error('A connection is already in progress');
    }
    if (await this.provider.isVpnRunning()) {
      throw coded('VPN is already connected', 'ALREADY_CONNECTED');
    }

    if (!await this.provider.helperReady()) {
      throw coded(
        'The privileged helper is not installed or not authorized. Run "fortin setup" once.',
        'HELPER_NOT_READY',
      );
    }

    const client = await this.provider.ensureClient();
    if (!client.ok) {
      throw coded(client.message || 'openfortivpn is not available', 'CLIENT_MISSING');
    }
    if (client.version) this.log(`openfortivpn: ${client.version}`);

    const config = { ...this.config, authMethod: authMethod || this.config.authMethod };
    const screenshots = debugScreenshots ?? this.debugScreenshots;

    const abort = new AbortController();
    let finishAttempt;
    const attemptDone = new Promise((resolve) => { finishAttempt = resolve; });
    this.#abort = abort;
    this.#attemptDone = attemptDone;
    this.#cancelled = false;
    this.#stoppedOutside = false;

    this.#connecting = true;
    this.#foreground = foreground;
    this.#askPassword = askPassword ?? null;
    this.#onProgress = onProgress ?? null;
    this.#setState('connecting', 'Signing in to Microsoft');

    try {
      const credentials = await this.#authenticate({
        config,
        askPassword,
        onProgress,
        screenshots,
        signal: abort.signal,
      });

      this.log('\n[SUCCESS] Authentication complete');
      this.#lastCookie = credentials.cookie;
      this.saveCookie(credentials.cookie);

      await this.#openTunnel({ config, cookie: credentials.cookie, foreground, signal: abort.signal });
      // The user may have cancelled while the tunnel was coming up: undo it and
      // let the cancel path own the ending.
      if (abort.signal.aborted) {
        await this.#dropTunnel();
        throw coded('The connection attempt was cancelled', CANCELLED_CODE);
      }
      this.#holdTunnel();
    } catch (error) {
      if (this.#isCancelled(error)) {
        // A cancelled credential prompt ends like the cancel channel. When
        // cancel() is the one that aborted the attempt, it owns the ending and
        // is already walking to disconnected, so leave it alone.
        if (!this.#cancelled && !this.#stoppedOutside) this.#settleCancelled();
      } else if (error.code !== 'TUNNEL_FAILED') {
        this.#setState('error', error.message);
      }
      throw error;
    } finally {
      this.#connecting = false;
      if (this.#attemptDone === attemptDone) this.#attemptDone = null;
      finishAttempt();
    }

    return this.getStateInfo();
  }

  async disconnect() {
    // The explicit decision of the user wins over every automatic behaviour.
    this.#intent = 'disconnected';
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    this.#reconnectAttempts = 0;
    this.#forgetCookie();

    this.#setState('disconnecting', 'Closing the tunnel');

    // The process that opened this tunnel may be another one: the request tells
    // it that this close is deliberate, so it does not read the exit as a drop.
    requestStop({ pid: readPid() ?? this.#pid, reason: 'stop' });

    const stopped = await this.provider.stop();

    const pid = readPid();
    if (pid && isProcessRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The process was no longer accepting signals.
      }
    }
    clearPid();
    this.#pid = null;

    if (!stopped && await this.provider.isVpnRunning()) {
      this.#setState('error', 'The VPN tunnel could not be closed');
      return false;
    }

    this.#setState('disconnected', 'Disconnected');
    return true;
  }

  /**
   * Stops the attempt in flight. The user asked for this ending, so the state
   * walks from connecting to disconnecting to disconnected and never to error,
   * however the attempt fails once it is aborted.
   *
   * Returns false when there was no attempt to cancel.
   */
  async cancel() {
    if (this.#state !== 'connecting') return false;

    this.#cancelled = true;
    this.#abort?.abort();
    this.#intent = 'disconnected';
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    this.#reconnectAttempts = 0;

    this.log('\nThe connection attempt was cancelled by the user');
    this.#setState('disconnecting', 'Cancelling the connection');

    // Whoever owns the tunnel has to know that this ending is deliberate.
    requestStop({ pid: readPid() ?? this.#pid, reason: 'cancel' });

    // The tunnel may already be starting even if the sign-in never finished.
    try {
      await this.provider.stop();
    } catch (error) {
      this.logError(`The tunnel could not be stopped while cancelling: ${error.message}`);
    }

    await Promise.allSettled([this.#attemptDone, this.#reconnectDone].filter(Boolean));

    // The attempt can finish holding the tunnel while it unwinds: undo that
    // before reporting the ending the user asked for.
    this.#intent = 'disconnected';
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    if (await this.provider.isVpnRunning()) await this.#dropTunnel();

    clearPid();
    this.#pid = null;
    this.#setState('disconnected', 'Connection cancelled');
    return true;
  }

  /**
   * Reconciles the state with the machine. While a reconnect or a sign-in is in
   * flight the state belongs to that operation, so leave it alone.
   */
  async refreshStatus() {
    const running = await this.provider.isVpnRunning();
    const pid = readPid();

    if (!running) {
      if (pid && !isProcessRunning(pid)) clearPid();
      this.#pid = null;
      if (this.#state !== 'error' && this.#state !== 'connecting' && this.#state !== 'disconnecting') {
        this.#setState('disconnected', 'Disconnected');
      }
      return this.getStateInfo();
    }

    this.#pid = pid ?? this.#pid;
    if (this.#state !== 'connected' && !this.#reconnecting && !this.#connecting) {
      this.#setState('connected', `Connected to ${this.config.vpnServer}:${this.config.vpnPort}`, this.#pid);
    }
    return this.getStateInfo();
  }

  /** The machine is going to sleep: stop checking a tunnel that cannot work. */
  handleSuspend() {
    this.#suspended = true;
    this.log('The system is going to sleep');
    // The hold is pointless while the machine is asleep and it would fight a
    // sleep the user asked for. It is taken again once the wake-up check runs.
    this.#releaseKeepAwake();
  }

  /** Back from sleep: the link is usually gone, so check right away. */
  async handleResume() {
    this.#suspended = false;
    this.log('The system woke up');
    if (this.#intent === 'connected') {
      this.#nextAttemptAt = 0;
      await this.#checkTunnel();
    }
    return this.getStateInfo();
  }

  /**
   * The SVPNCOOKIE is a session secret, so it goes to the system store. Only a
   * machine without one keeps the 0600 file, warned once in the log.
   */
  saveCookie(cookie) {
    try {
      if (isStoreAvailable()) {
        setSecret(SECRET_NAMES.cookie, cookie);
        return;
      }
      if (!this.#cookieFileWarned) {
        this.#cookieFileWarned = true;
        this.logError('The session cookie is kept in a 0600 file: this machine has no secret store, so it is not protected by the system');
      }
      const { cookieFile } = getPaths();
      fs.writeFileSync(cookieFile, cookie, { mode: 0o600 });
      fs.chmodSync(cookieFile, 0o600);
    } catch (error) {
      this.logError(`Could not store the last session cookie: ${error.message}`);
    }
  }

  /**
   * The user asked to end the session, so the cookie goes away with it: neither
   * the store item nor the file written by an older version stays behind.
   */
  #forgetCookie() {
    this.#lastCookie = null;
    this.#cookieRejected = false;
    try {
      if (isStoreAvailable()) deleteSecret(SECRET_NAMES.cookie);
      fs.rmSync(getPaths().cookieFile, { force: true });
    } catch (error) {
      this.logError(`Could not remove the stored session cookie: ${error.message}`);
    }
  }

  log(...args) {
    if (this.logger) this.logger.log(...args);
    else console.log(...args);
  }

  logError(...args) {
    if (this.logger) this.logger.error(...args);
    else console.error(...args);
  }

  /* ------------------------------------------------------------- internals */

  /** A cancelled attempt never reports the error state: the cancel path owns it. */
  #isCancelled(error) {
    return this.#cancelled || error?.code === CANCELLED_CODE;
  }

  /**
   * Ends an attempt the user cancelled on purpose, from the cancel channel or
   * from the credential prompt: the state goes to disconnected, never to error,
   * and nothing is left holding the tunnel.
   */
  #settleCancelled() {
    this.#cancelled = true;
    this.#intent = 'disconnected';
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    this.#reconnectAttempts = 0;
    clearPid();
    this.#pid = null;
    this.#setState('disconnected', 'Connection cancelled');
  }

  /**
   * True when another process asked for this tunnel to close, which is what the
   * terminal does with "stop". The request names the tunnel it stopped, so one
   * that belongs to an older tunnel is ignored, and a request is used once.
   */
  #stopRequested() {
    const request = readStopRequest();
    if (!request || request.pid === null) return false;
    if (this.#pid !== null && request.pid !== this.#pid) return false;
    clearStopRequest();
    return true;
  }

  /**
   * Ends the hold of a tunnel another process stopped on purpose: the ending of
   * a disconnect, without the reconnect that a drop would start.
   */
  #settleStopped() {
    this.#intent = 'disconnected';
    this.#stoppedOutside = true;
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    this.#reconnectAttempts = 0;
    clearPid();
    this.#pid = null;
    try {
      this.#forgetCookie();
    } catch (error) {
      this.logError(`The stored session cookie could not be removed: ${error.message}`);
    }
    this.log('\nThe tunnel was closed on request from another process');
    this.#setState('disconnected', 'The tunnel was closed on request');
  }

  #authenticate({ config, askPassword, onProgress, screenshots = config.debugScreenshots === true, signal = null }) {
    return this.authenticator({
      config,
      logger: this.logger,
      screenshotsDir: this.screenshotsDir,
      debugScreenshots: screenshots,
      onProgress: (event) => {
        this.emit('progress', event);
        if (typeof onProgress === 'function') onProgress(event);
      },
      askPassword,
      chromePath: config.chromePath,
      signal,
    });
  }

  async #openTunnel({ config, cookie, foreground, signal = null, reportState = true }) {
    // A request that named an older tunnel is not about the one this attempt
    // opens, so the attempt starts clean and a stop during it is not lost.
    clearStopRequest();
    this.#stoppedOutside = false;

    this.#setState('connecting', 'Opening the VPN tunnel');

    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() !== '') this.log(line);
      }
    };
    const onExit = (code) => {
      this.log(`\nVPN disconnected (exit code: ${code})`);
      // Another process may have closed this tunnel on purpose, which is what
      // the terminal does with "stop": that is the ending the user asked for.
      if (this.#intent === 'connected' && this.#stopRequested()) {
        this.#settleStopped();
        return;
      }
      clearPid();
      this.#pid = null;
      if (this.#stoppedOutside) return;
      // While the user still wants the tunnel, a tunnel that exits is a drop and
      // never a disconnect: report it as such and let the reconnect own the state.
      if (this.#intent === 'connected') {
        if (!this.#reconnecting && !this.#connecting) {
          this.#setState('connecting', 'The tunnel dropped, reconnecting');
          this.#nextAttemptAt = 0;
          this.#checkTunnel().catch(() => {});
        }
        return;
      }
      // A cancelled attempt owns the ending: do not report the process exit over it.
      if (this.#cancelled) return;
      this.#setState('disconnected', 'The tunnel closed');
    };

    const connection = await this.provider.connect({
      server: config.vpnServer,
      port: config.vpnPort,
      cookie,
      trustedCert: config.trustedCert,
      realm: config.vpnRealm,
      detached: !foreground,
      onData,
      onExit,
      outputFile: path.join(getPaths().logsDir, TUNNEL_LOG_NAME),
    });

    if (connection.pid) savePid(connection.pid);
    else clearPid();
    this.#pid = connection.pid ?? null;

    if (foreground) this.log('Starting VPN in foreground...');
    else this.log('Starting VPN in background...');

    const tunnel = await this.#waitForTunnel(connection.pid, signal);
    if (!tunnel.ready || signal?.aborted) {
      if (signal?.aborted) {
        // The user cancelled while the tunnel was coming up: no failure to
        // report, the cancel path owns the state.
        await this.#dropTunnel();
        throw coded('The connection attempt was cancelled', CANCELLED_CODE);
      }
      if (tunnel.reason === 'died' && this.#stopRequested()) {
        // Another process stopped the tunnel while it was coming up: the ending
        // the user asked for, not a failure of the connection.
        await this.#dropTunnel();
        this.#settleStopped();
        throw coded('The tunnel was closed on request', CANCELLED_CODE);
      }
      this.#reportTunnelFailure(tunnel.reason);
      await this.#dropTunnel();
      const message = tunnel.reason === 'died'
        ? 'openfortivpn exited before the tunnel came up'
        : 'The VPN did not connect within 30 seconds';
      // During a reconnect the state belongs to the reconnect loop, which is
      // about to show the next attempt.
      if (reportState) this.#setState('error', message);
      throw coded(message, 'TUNNEL_FAILED');
    }

    this.log('');
    this.log('========================================');
    this.log('VPN connected and running in background!');
    this.log('========================================');

    return connection;
  }

  async #waitForTunnel(pid, signal = null) {
    const startTime = Date.now();

    while ((Date.now() - startTime) < TUNNEL_READY_TIMEOUT_MS) {
      if (signal?.aborted) return { ready: false, reason: 'cancelled' };
      if (await this.provider.isVpnRunning()) return { ready: true, reason: 'ready' };
      if (pid && !isProcessRunning(pid)) {
        this.logError('\nVPN process died unexpectedly');
        return { ready: false, reason: 'died' };
      }
      await wait(TUNNEL_POLL_INTERVAL_MS, signal);
    }
    return { ready: false, reason: 'timeout' };
  }

  /**
   * Stops the tunnel the attempt started and forgets its pid. Used when the
   * user cancels while the tunnel is still coming up.
   */
  async #dropTunnel() {
    try {
      await this.provider.stop();
    } catch {
      // Nothing left to stop.
    }
    clearPid();
    this.#pid = null;
  }

  /**
   * openfortivpn explains the real cause (wrong certificate digest, bad cookie,
   * missing gateway route) on its own output. Show it, otherwise a failed start
   * gives the user nothing to act on.
   */
  #reportTunnelFailure(reason) {
    const tail = readTail(path.join(getPaths().logsDir, TUNNEL_LOG_NAME), TUNNEL_LOG_TAIL_LINES);
    if (tail.length === 0) {
      this.logError(reason === 'died' ? '\nThe tunnel process exited and produced no output' : '\nThe tunnel did not come up and produced no output');
      return;
    }
    this.logError(reason === 'died' ? '\nopenfortivpn output:' : '\nopenfortivpn output so far:');
    for (const line of tail) this.logError(`   ${line}`);
  }

  /* ------------------------------------------------- keeping the tunnel up */

  /** The tunnel is up and the user wants it that way: hold it. */
  #holdTunnel() {
    this.#intent = 'connected';
    this.#reconnectAttempts = 0;
    this.#nextAttemptAt = 0;
    this.#applyKeepAwake();
    this.#startWatchdog();
    this.#setState('connected', `Connected to ${this.config.vpnServer}:${this.config.vpnPort}`, this.#pid);
  }

  #startWatchdog() {
    if (this.#watchdog) return;
    if (this.config.autoReconnect === false) return;
    this.#watchdog = setInterval(() => {
      this.#checkTunnel().catch(() => {});
    }, HEALTH_CHECK_INTERVAL_MS);
    if (typeof this.#watchdog.unref === 'function') this.#watchdog.unref();
  }

  #stopWatchdog() {
    if (!this.#watchdog) return;
    clearInterval(this.#watchdog);
    this.#watchdog = null;
  }

  #applyKeepAwake() {
    this.#releaseKeepAwake();
    if (this.config.keepAwake === false) return;
    if (typeof this.provider.startKeepAwake !== 'function') return;
    try {
      this.#keepAwake = this.provider.startKeepAwake({ tunnelPid: this.#pid });
      if (this.#keepAwake) this.log('The machine stays awake while the tunnel is up');
    } catch (error) {
      this.logError(`The machine could not be held awake: ${error.message}`);
    }
  }

  #releaseKeepAwake() {
    if (!this.#keepAwake) return;
    try {
      this.#keepAwake.stop();
    } catch {
      // Already gone.
    }
    this.#keepAwake = null;
  }

  /** The process can be alive with a dead link after a sleep, so check both. */
  async #isTunnelUp() {
    if (!await this.provider.isVpnRunning()) return false;
    if (typeof this.provider.isTunnelUp !== 'function') return true;
    return this.provider.isTunnelUp();
  }

  async #checkTunnel() {
    if (this.#suspended || this.#reconnecting || this.#connecting) return;
    if (this.#intent !== 'connected') return;

    if (await this.#isTunnelUp()) {
      this.#reconnectAttempts = 0;
      // The tunnel survived, so hold the machine again.
      if (!this.#keepAwake) this.#applyKeepAwake();
      return;
    }

    // The tunnel did not drop on its own: another process stopped it on purpose.
    if (this.#stopRequested()) {
      this.#settleStopped();
      return;
    }

    if (Date.now() < this.#nextAttemptAt) return;
    await this.#reconnect();
  }

  async #reconnect() {
    const signal = this.#abort ? this.#abort.signal : null;
    this.#reconnecting = true;
    let finishReconnect;
    this.#reconnectDone = new Promise((resolve) => { finishReconnect = resolve; });
    try {
      if (signal?.aborted || this.#intent !== 'connected') return;

      this.#reconnectAttempts += 1;
      const attempt = this.#reconnectAttempts;

      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        this.#giveUp();
        return;
      }

      const backoff = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
      this.#setState('connecting', `Reconnecting, attempt ${attempt} of ${MAX_RECONNECT_ATTEMPTS}`);
      this.log(`\nThe tunnel is down. Reconnecting in ${Math.round(backoff / 1000)}s (attempt ${attempt} of ${MAX_RECONNECT_ATTEMPTS})...`);
      await wait(backoff, signal);

      // The user may have disconnected or cancelled while waiting.
      if (signal?.aborted || this.#intent !== 'connected') return;

      // A terminal may have stopped the tunnel while this attempt waited: the
      // stop wins over the reconnect.
      if (this.#stopRequested()) {
        this.#settleStopped();
        return;
      }

      this.#releaseKeepAwake();
      try {
        await this.provider.stop();
      } catch {
        // Nothing left to stop.
      }

      const config = { ...this.config };
      let cookie = this.#lastCookie;

      const canReuseCookie = Boolean(cookie) && !this.#cookieRejected && attempt <= COOKIE_RECONNECT_ATTEMPTS;
      if (!canReuseCookie) {
        this.log('Signing in to Microsoft again...');
        const credentials = await this.#authenticate({
          config,
          askPassword: this.#askPassword,
          onProgress: this.#onProgress,
          signal,
        });
        cookie = credentials.cookie;
        this.#lastCookie = cookie;
        this.#cookieRejected = false;
        this.saveCookie(cookie);
      } else {
        this.log('Reusing the last session cookie...');
      }

      try {
        await this.#openTunnel({ config, cookie, foreground: this.#foreground, reportState: false, signal });
      } catch (error) {
        // A cookie the gateway refuses is not worth a second try: it hands out no
        // configuration and the session has to be built again from scratch.
        if (canReuseCookie && /Could not get VPN configuration|HTTP status code/i.test(String(error.message))) {
          this.#cookieRejected = true;
          this.log('The gateway refused the stored session cookie, the next attempt signs in again');
        }
        throw error;
      }
      if (signal?.aborted) {
        // The user cancelled while the tunnel was coming up: drop it and let
        // the cancel path own the ending.
        await this.#dropTunnel();
        return;
      }
      this.log('[OK] The tunnel is back up');
      this.#holdTunnel();
    } catch (error) {
      // The cancel path owns the state, so an aborted attempt stops here.
      if (signal?.aborted) return;
      // The user cancelled the credential prompt: this attempt ends as a
      // disconnection instead of asking for the password again.
      if (error?.code === CANCELLED_CODE) {
        this.#settleCancelled();
        return;
      }
      this.logError(`Reconnect attempt ${this.#reconnectAttempts} failed: ${error.message}`);
      this.#nextAttemptAt = Date.now() + RECONNECT_BACKOFF_MS[Math.min(this.#reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1)];
      if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) this.#giveUp();
    } finally {
      this.#reconnecting = false;
      this.#reconnectDone = null;
      finishReconnect();
    }
  }

  #giveUp() {
    this.#stopWatchdog();
    this.#releaseKeepAwake();
    const message = `The tunnel dropped and ${MAX_RECONNECT_ATTEMPTS} reconnect attempts failed. Connect again when you are ready.`;
    this.logError(`\n${message}`);
    this.#setState('error', message);
  }

  #setState(state, message = '', pid = this.#pid) {
    const changed = state !== this.#state || message !== this.#message || pid !== this.#pid;
    this.#state = state;
    this.#message = message;
    this.#since = Date.now();
    this.#pid = pid;

    const payload = this.getStateInfo();
    if (changed) this.emit('state', payload);
    return payload;
  }
}
