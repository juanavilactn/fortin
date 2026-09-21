// Renderer for the Fortin window.
//
// It renders the VPN state and forwards user actions to the main process
// through the bridge that the preload script exposes as "window.vpn". No
// framework and no bundler: DOM APIs and that bridge only.

/* ---------------------------------------------------------------- constants */

const STATE_INFO = {
  disconnected: { label: 'Disconnected', detail: 'The tunnel is down.' },
  connecting: { label: 'Connecting', detail: 'Signing in to Microsoft.' },
  connected: { label: 'Connected', detail: 'The tunnel is up.' },
  disconnecting: { label: 'Disconnecting', detail: 'Closing the tunnel.' },
  error: { label: 'Error', detail: 'The last operation failed.' },
};

const ERROR_HINT = 'Press Connect to try again.';
const LOG_LINE_LIMIT = 500;
const SCROLL_STICK_PX = 24;
const TOTP_LENGTH = 6;
const TOTP_PATTERN = /^[0-9]{6}$/;
const SAVED_HINT = '\u2022\u2022\u2022\u2022\u2022 (saved)';
const NOTIFICATION_GAP_MS = 5000;
const RECONNECT_PATTERN = /reconnecting, attempt (\d+) of (\d+)/i;
const TUNNEL_DROP_PATTERN = /tunnel dropped/i;
const PUSH_CODE_PATTERN = /(\d{2,8})/;
const LOG_FILE_PATTERN = /^\[([^\]]+)\]\s*(?:\[([A-Z]+)\]\s*)?([\s\S]*)$/;
const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const TOTP_SECRET_PATTERN = /^[A-Za-z2-7]+$/;
const LEVELS = ['info', 'warning', 'error'];
const CREDENTIAL_REASONS = {
  missing: 'No password is stored yet. Enter the Microsoft password.',
  incorrect: 'Microsoft rejected the password. Enter it again.',
};

/** Why the initial setup is due, in words, as the banner says it. */
const SETUP_REASON_TEXT = {
  'no-config-file': 'there is no configuration yet',
  'no-server': 'no VPN server is configured',
  'helper-not-ready': 'the privileged helper is not ready',
};


/* ------------------------------------------------------------------ bridge */

const bridge = window.vpn ?? {};

const api = {
  appInfo: bridge.appInfo,
  getConfig: bridge.configGet,
  saveConfig: bridge.configSave,
  connect: bridge.vpnConnect,
  disconnect: bridge.vpnDisconnect,
  cancel: bridge.vpnCancel,
  state: bridge.vpnState,
  status: bridge.vpnStatus,
  recentLogs: bridge.logsRecent,
  openLogs: bridge.shellOpenLogs,
  openScreenshots: bridge.shellOpenScreenshots,
  helperStatus: bridge.helperStatus,
  installHelper: bridge.helperInstall,
  setupStatus: bridge.setupStatus,
  setupComplete: bridge.setupComplete,
  setupSkip: bridge.setupSkip,
  commandLineStatus: bridge.commandLineStatus,
  commandLineInstall: bridge.commandLineInstall,
  answerCredentials: bridge.credentialsAnswer,
  quit: bridge.appQuit,
  on: bridge.on,
};

function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error('The window is missing the element #' + id);
  return node;
}

const el = {
  statusCard: element('status-card'),
  statusDot: element('status-dot'),
  pill: element('status-pill'),
  detail: element('status-detail'),
  hint: element('status-hint'),
  metaServer: element('meta-server'),
  metaTimer: element('meta-timer'),
  metaAwake: element('meta-awake'),
  metaReconnect: element('meta-reconnect'),
  primary: element('primary-action'),
  primaryLabel: element('primary-label'),
  primarySpinner: element('primary-spinner'),
  cancelAction: element('cancel-action'),
  helperBanner: element('helper-banner'),
  helperMessage: element('helper-message'),
  helperInstall: element('helper-install'),
  setupBanner: element('setup-banner'),
  setupBannerMessage: element('setup-banner-message'),
  setupBannerOpen: element('setup-banner-open'),
  sectionSwitch: element('section-switch'),
  viewSetup: element('view-setup'),
  setupStepTitle: element('setup-step-title'),
  setupStepCounter: element('setup-step-counter'),
  setupLater: element('setup-later'),
  setupBody: element('setup-body'),
  setupWelcomeList: element('setup-welcome-list'),
  setupHelperPending: element('setup-helper-pending'),
  setupHelperReady: element('setup-helper-ready'),
  setupHelperInstall: element('setup-helper-install'),
  setupServer: element('setup-server'),
  setupPort: element('setup-port'),
  setupRealm: element('setup-realm'),
  setupUsername: element('setup-username'),
  setupAuthPush: element('setup-auth-push'),
  setupAuthTotp: element('setup-auth-totp'),
  setupTotpField: element('setup-totp-field'),
  setupTotp: element('setup-totp'),
  setupTotpHint: element('setup-totp-hint'),
  setupPassword: element('setup-password'),
  setupPasswordHint: element('setup-password-hint'),
  setupSecretsStore: element('setup-secrets-store'),
  setupStartAtLogin: element('setup-start-at-login'),
  setupStartAtLoginHelp: element('setup-start-at-login-help'),
  setupKeepAwake: element('setup-keep-awake'),
  setupAutoReconnect: element('setup-auto-reconnect'),
  setupCommandStatus: element('setup-command-status'),
  setupCommandAdmin: element('setup-command-admin'),
  setupCommandInstall: element('setup-command-install'),
  setupSummary: element('setup-summary'),
  setupFinish: element('setup-finish'),
  setupConnect: element('setup-connect'),
  setupBack: element('setup-back'),
  setupNext: element('setup-next'),
  setupMessage: element('setup-message'),
  setupSteps: {
    welcome: element('setup-step-welcome'),
    helper: element('setup-step-helper'),
    server: element('setup-step-server'),
    authentication: element('setup-step-authentication'),
    secrets: element('setup-step-secrets'),
    tunnel: element('setup-step-tunnel'),
    command: element('setup-step-command'),
    summary: element('setup-step-summary'),
  },
  tabActivity: element('tab-activity'),
  tabSettings: element('tab-settings'),
  viewActivity: element('view-activity'),
  viewSettings: element('view-settings'),
  filterButtons: [...document.querySelectorAll('.chip[data-level]')],
  logOutput: element('log-output'),
  logCopy: element('log-copy'),
  logClear: element('log-clear'),
  logLatest: element('log-latest'),
  logStatus: element('log-status'),
  logsOpen: element('logs-open'),
  screenshotsOpen: element('screenshots-open'),
  settingsForm: element('settings-form'),
  settingsEnv: element('settings-env'),
  settingsSecretsStore: element('settings-secrets-store'),
  server: element('field-server'),
  port: element('field-port'),
  realm: element('field-realm'),
  username: element('field-username'),
  password: element('field-password'),
  passwordHint: element('password-hint'),
  totp: element('field-totp'),
  totpHint: element('totp-hint'),
  authPush: element('auth-push'),
  authTotp: element('auth-totp'),
  headless: element('field-headless'),
  keepAwake: element('field-keep-awake'),
  autoReconnect: element('field-auto-reconnect'),
  trustedCert: element('field-trusted-cert'),
  chromePath: element('field-chrome-path'),
  debugScreenshots: element('field-debug-screenshots'),
  startAtLogin: element('field-start-at-login'),
  startAtLoginHelp: element('help-start-at-login'),
  settingsMessage: element('settings-message'),
  errors: {
    server: element('error-server'),
    port: element('error-port'),
    username: element('error-username'),
    totp: element('error-totp'),
    cert: element('error-cert'),
  },
  setupErrors: {
    server: element('setup-error-server'),
    port: element('setup-error-port'),
    username: element('setup-error-username'),
    totp: element('setup-error-totp'),
  },
  versionApp: element('version-app'),
  versionElectron: element('version-electron'),
  versionPlatform: element('version-platform'),
  appQuit: element('app-quit'),
  modal: element('credentials-modal'),
  modalForm: element('credentials-form'),
  modalTitle: element('credentials-title'),
  modalMessage: element('credentials-message'),
  modalAttempt: element('credentials-attempt'),
  modalInput: element('credentials-input'),
  modalInputLabel: element('credentials-input-label'),
  modalHelp: element('credentials-help'),
  modalReveal: element('credentials-reveal'),
  modalError: element('credentials-error'),
  modalSubmit: element('credentials-submit'),
  modalCancel: element('credentials-cancel'),
};

const validatedFields = new Map([
  [el.server, 'server'],
  [el.port, 'port'],
  [el.username, 'username'],
  [el.totp, 'totp'],
  [el.trustedCert, 'cert'],
]);

/* -------------------------------------------------------------------- state */

let currentState = 'disconnected';
let stateSince = Date.now();
let stateMessage = '';
let progress = null;
let reconnect = null;
let currentConfig = {};
let serverLabel = '';
let stickToBottom = true;
let logFilter = 'all';
const levelCounts = { info: 0, warning: 0, error: 0 };
let pendingRequest = null;
let credentialKind = 'password';
const secretsSaved = { password: false, totp: false };
let bridgeWarned = false;
let firstSnapshotDone = false;
// Only the installed application can register a login item: a development run
// would register the Electron binary, so the switch stays disabled there.
let startAtLoginAvailable = false;
let sawDrop = false;
let userAskedDisconnect = false;
let timerHandle = null;
let copyHandle = null;
let lastNotification = null;
let heldNotification = null;
let notificationHandle = null;
let notifiedAt = 0;
// Initial setup: the answer the core gave, the steps it named and where the
// window is in them. The window decides nothing about the assistant itself.
let setupPayload = null;
let setupSteps = [];
let setupStepIndex = 0;
let setupBusy = false;
let commandLineReport = null;

/* ------------------------------------------------------------ small helpers */

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
}

function valueAt(source, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), source);
}

function firstValue(source, paths) {
  for (const path of paths) {
    const value = valueAt(source, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function callApi(method, ...args) {
  if (typeof method !== 'function') throw new Error('This action is not available in the app bridge.');
  return await method(...args);
}

function reportBridgeGap() {
  if (bridgeWarned || typeof api.getConfig === 'function' || typeof api.connect === 'function') return;
  bridgeWarned = true;
  logLine({ level: 'error', message: 'The window bridge (window.vpn) is not available. Restart the app.' });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatClock(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
}

function formatTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toLocaleTimeString();
  const raw = textOf(value);
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleTimeString();
    return raw;
  }
  return new Date().toLocaleTimeString();
}

function plural(count, singular, pluralForm) {
  return count === 1 ? '1 ' + singular : count + ' ' + pluralForm;
}

/* -------------------------------------------------------------- the log */

function normaliseLevel(value) {
  const level = textOf(value).toLowerCase();
  if (level === 'error') return 'error';
  if (level === 'warning' || level === 'warn') return 'warning';
  return 'info';
}

function levelTag(level) {
  return level === 'warning' ? 'warn' : level;
}

/** Log files hold "[ISO] message" and "[ISO] [ERROR] message" lines. */
function parseFileLine(raw) {
  const text = String(raw ?? '');
  const match = LOG_FILE_PATTERN.exec(text);
  if (!match) return { time: '', level: 'info', message: text };
  return { time: match[1], level: normaliseLevel(match[2]), message: match[3] };
}

function trimLog() {
  while (el.logOutput.childElementCount > LOG_LINE_LIMIT) {
    const first = el.logOutput.firstElementChild;
    const level = normaliseLevel(first?.dataset?.level);
    levelCounts[level] = Math.max(0, levelCounts[level] - 1);
    first.remove();
  }
}

function scrollToBottom() {
  el.logOutput.scrollTop = el.logOutput.scrollHeight;
}

function updateLatestButton() {
  const overflowing = el.logOutput.scrollHeight - el.logOutput.clientHeight > 4;
  el.logLatest.hidden = stickToBottom || !overflowing;
}

function updateLogStatus() {
  const total = el.logOutput.childElementCount;
  if (total === 0) {
    el.logStatus.textContent = 'No lines yet.';
    return;
  }
  const lines = plural(total, 'line', 'lines');
  if (logFilter === 'all') {
    el.logStatus.textContent = lines;
    return;
  }
  el.logStatus.textContent = levelCounts[logFilter] + ' of ' + total + ' shown';
}

function appendLine(level, time, message) {
  const line = document.createElement('div');
  line.className = 'log-line log-line--' + level;
  line.dataset.level = level;

  const stamp = document.createElement('span');
  stamp.className = 'log-line__time';
  stamp.textContent = time || '--:--:--';

  const tag = document.createElement('span');
  tag.className = 'log-line__level';
  tag.textContent = levelTag(level);

  const text = document.createElement('span');
  text.className = 'log-line__text';
  text.textContent = message;

  line.append(stamp, tag, text);
  el.logOutput.append(line);
  levelCounts[level] += 1;
  trimLog();
  if (stickToBottom) scrollToBottom();
  updateLatestButton();
  updateLogStatus();
}

function logLine(line) {
  const source = typeof line === 'string' ? parseFileLine(line) : line ?? {};
  const message = textOf(source.message);
  // The logger writes empty lines as separators; they carry no information.
  if (message === '') return;
  appendLine(normaliseLevel(source.level), formatTime(source.time), message);
}

function clearLog() {
  el.logOutput.replaceChildren();
  levelCounts.info = 0;
  levelCounts.warning = 0;
  levelCounts.error = 0;
  stickToBottom = true;
  updateLatestButton();
  updateLogStatus();
}

function setFilter(level) {
  logFilter = LEVELS.includes(level) ? level : 'all';
  el.logOutput.dataset.filter = logFilter;
  for (const button of el.filterButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.level === logFilter));
  }
  updateLogStatus();
}

function visibleLogLines() {
  return [...el.logOutput.children]
    .filter((node) => logFilter === 'all' || node.dataset.level === logFilter)
    .map((node) => [...node.children].map((cell) => cell.textContent).join('  '));
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the selection based copy below.
  }
  try {
    const helper = document.createElement('textarea');
    helper.className = 'clipboard-helper';
    helper.value = text;
    helper.setAttribute('readonly', '');
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    return copied;
  } catch {
    return false;
  }
}

function setCopyFeedback(message) {
  el.logCopy.textContent = message;
  if (copyHandle) clearTimeout(copyHandle);
  copyHandle = setTimeout(() => {
    el.logCopy.textContent = 'Copy';
  }, 2000);
}

async function copyLog() {
  const lines = visibleLogLines();
  if (lines.length === 0) {
    setCopyFeedback('Nothing to copy');
    return;
  }
  const copied = await writeClipboard(lines.join('\n'));
  setCopyFeedback(copied ? 'Copied ' + plural(lines.length, 'line', 'lines') : 'Copy failed');
}

/* -------------------------------------------------------------------- state */

function parseReconnect(message) {
  const match = RECONNECT_PATTERN.exec(message);
  if (!match) return null;
  return { attempt: Number(match[1]), max: Number(match[2]) };
}

function buildCodeChip(value) {
  const chip = document.createElement('span');
  chip.className = 'code';
  chip.textContent = value;
  return chip;
}

function renderDetail() {
  const info = STATE_INFO[currentState];
  const active = currentState === 'connecting' ? progress : null;
  let message = textOf(active?.message) || stateMessage || info.detail;
  if (message.toLowerCase() === info.label.toLowerCase()) message = info.detail;

  el.detail.dataset.kind = textOf(active?.kind);
  el.detail.replaceChildren();
  const match = active?.kind === 'push-code' ? PUSH_CODE_PATTERN.exec(message) : null;
  if (match) {
    el.detail.append(
      document.createTextNode(message.slice(0, match.index)),
      buildCodeChip(match[1]),
      document.createTextNode(message.slice(match.index + match[1].length)),
    );
    return;
  }
  el.detail.append(document.createTextNode(message));
}

function updateTimer() {
  const showConnected = currentState === 'connected';
  const showDown = currentState === 'connecting' && reconnect !== null;
  if (!showConnected && !showDown) {
    el.metaTimer.hidden = true;
    el.metaTimer.textContent = '';
    return;
  }
  el.metaTimer.hidden = false;
  const elapsed = formatClock(Date.now() - stateSince);
  el.metaTimer.textContent = showConnected ? 'Connected for ' + elapsed : 'Down for ' + elapsed;
}

function syncTimer() {
  const wanted = currentState === 'connected' || (currentState === 'connecting' && reconnect !== null);
  if (wanted && timerHandle === null) timerHandle = setInterval(updateTimer, 1000);
  if (!wanted && timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  updateTimer();
}

function renderMeta() {
  el.metaServer.textContent = serverLabel || 'No server configured';
  el.metaAwake.hidden = !(currentState === 'connected' && currentConfig.keepAwake !== false);
  if (reconnect) {
    el.metaReconnect.textContent = 'Reconnect attempt ' + reconnect.attempt + ' of ' + reconnect.max;
    el.metaReconnect.hidden = false;
  } else {
    el.metaReconnect.hidden = true;
  }
  syncTimer();
}

function renderPrimaryAction() {
  const busy = currentState === 'connecting' || currentState === 'disconnecting';
  el.primarySpinner.hidden = !busy;
  if (busy) el.primaryLabel.textContent = currentState === 'connecting' ? 'Connecting' : 'Disconnecting';
  else el.primaryLabel.textContent = currentState === 'connected' ? 'Disconnect' : 'Connect';
  el.primary.disabled = busy;
}

function renderCancelAction() {
  const visible = typeof api.cancel === 'function' && currentState === 'connecting';
  el.cancelAction.hidden = !visible;
  if (!visible) {
    el.cancelAction.disabled = false;
    el.cancelAction.textContent = 'Cancel';
  }
}

function renderStatusCard() {
  const info = STATE_INFO[currentState];
  el.statusCard.dataset.state = currentState;
  el.statusDot.dataset.state = currentState;
  el.pill.textContent = info.label;
  el.pill.dataset.state = currentState;
  el.hint.textContent = currentState === 'error' ? ERROR_HINT : '';
  el.hint.hidden = currentState !== 'error';
  renderDetail();
}

function renderState(payload) {
  const state = Object.hasOwn(STATE_INFO, payload?.state) ? payload.state : 'disconnected';
  const previous = currentState;
  const first = !firstSnapshotDone;

  currentState = state;
  stateSince = Number.isFinite(Number(payload?.since)) ? Number(payload.since) : Date.now();
  stateMessage = textOf(payload?.message);
  reconnect = parseReconnect(stateMessage);
  if (state !== 'connecting') progress = null;

  // A tunnel that leaves "connected" without the user asking is a drop: the
  // controller reconnects, and the window has to say so.
  if (previous === 'connected' && state !== 'connected' && !userAskedDisconnect) sawDrop = true;

  renderStatusCard();
  renderPrimaryAction();
  renderCancelAction();
  renderMeta();
  notifyTransition(previous, state, first);

  firstSnapshotDone = true;
}

function renderProgress(event) {
  const message = textOf(event?.message);
  if (!message) return;
  progress = { message, kind: textOf(event?.kind) };
  renderDetail();
}

async function refreshState() {
  const reader = api.state ?? api.status;
  if (typeof reader !== 'function') return;
  const snapshot = await reader();
  if (!snapshot || typeof snapshot !== 'object') return;
  renderState({ ...snapshot, state: textOf(snapshot.state) || currentState });
}

async function toggleConnection() {
  el.primary.disabled = true;
  try {
    if (currentState === 'connected') {
      userAskedDisconnect = true;
      await callApi(api.disconnect);
    } else {
      await callApi(api.connect, { authMethod: currentAuthMethod(), foreground: false });
    }
  } catch (error) {
    logLine({ level: 'error', message: 'The request failed: ' + errorText(error) });
  } finally {
    try {
      await refreshState();
    } catch {
      renderState({ state: currentState, message: stateMessage, since: stateSince });
    }
  }
}

async function cancelConnection() {
  if (typeof api.cancel !== 'function') return;
  el.cancelAction.disabled = true;
  el.cancelAction.textContent = 'Cancelling';
  // The main process may be waiting for the credential prompt: close it first.
  if (pendingRequest) cancelCredentials();
  try {
    const result = await callApi(api.cancel);
    if (result && result.accepted === false) {
      logLine({ level: 'warning', message: 'The connection could not be cancelled.' });
    }
  } catch (error) {
    logLine({ level: 'error', message: 'Could not cancel the connection: ' + errorText(error) });
  } finally {
    el.cancelAction.disabled = false;
    el.cancelAction.textContent = 'Cancel';
    renderCancelAction();
  }
}

/* ------------------------------------------------------------ notifications */

function showNotification(title, body) {
  if (typeof Notification !== 'function') return;
  const permission = typeof Notification.permission === 'string' ? Notification.permission : 'granted';
  if (permission === 'denied') return;

  const display = () => {
    try {
      new Notification(title, { body });
    } catch {
      // The window still shows the state when the system refuses the notice.
    }
  };

  if (permission === 'granted') {
    display();
    return;
  }
  Promise.resolve(Notification.requestPermission())
    .then((result) => {
      if (result === 'granted') display();
    })
    .catch(() => {});
}

/**
 * Shows a notice now and remembers it: the last notice drops immediate repeats,
 * and the moment it went out sets the gap to the next notice.
 */
function presentNotification(title, body) {
  lastNotification = { title, body };
  notifiedAt = Date.now();
  showNotification(title, body);
}

/** Shows the notice the gap held back, when the gap expires. */
function flushNotification() {
  notificationHandle = null;
  const held = heldNotification;
  heldNotification = null;
  if (held) presentNotification(held.title, held.body);
}

/**
 * Posts one notice: never the same one twice in a row, and never two of them
 * closer than the gap. A notice the gap suppresses leaves the newest one
 * waiting for its turn.
 */
function postNotification(title, body) {
  const text = textOf(body);
  if (lastNotification && lastNotification.title === title && lastNotification.body === text) return;
  const wait = notifiedAt + NOTIFICATION_GAP_MS - Date.now();
  if (wait > 0) {
    heldNotification = { title, body: text };
    if (notificationHandle === null) notificationHandle = setTimeout(flushNotification, wait);
    return;
  }
  presentNotification(title, text);
}

function notifyTransition(previous, state, first) {
  if (first) {
    // The first snapshot only describes what the app found when it opened.
    if (state === 'connected') sawDrop = false;
    return;
  }

  // A reconnect keeps the state on "connecting" and moves only the message: the
  // drop, and then every attempt, are the steps worth telling.
  if (state === previous) {
    if (state === 'connecting') {
      if (reconnect) postNotification('Reconnect attempt ' + reconnect.attempt + ' of ' + reconnect.max, 'The tunnel is down.');
      else if (TUNNEL_DROP_PATTERN.test(stateMessage)) postNotification('VPN connection lost', stateMessage);
    }
    return;
  }

  if (state === 'connecting') {
    // A tunnel that leaves "connected" on its own is a drop, and the reconnect
    // loop owns the connecting state from here on.
    if (previous === 'connected') {
      postNotification('VPN connection lost', stateMessage || 'The tunnel is down, reconnecting.');
      return;
    }
    postNotification('VPN connecting', serverLabel ? 'Connecting to ' + serverLabel : 'Connecting to the VPN server');
    return;
  }

  if (state === 'connected') {
    // Only a connection this window watched (connecting -> connected) is worth a
    // notification: a tunnel the app found already up is not a new connection.
    if (previous === 'connecting') {
      const where = stateMessage || (serverLabel ? 'Connected to ' + serverLabel : 'The tunnel is up.');
      postNotification(sawDrop ? 'VPN reconnected' : 'VPN connected', where);
    }
    sawDrop = false;
    userAskedDisconnect = false;
    return;
  }

  // A "disconnecting" step arrives right before the final "disconnected" notice.
  // The guard is the switch for that step: delete it and the branch below takes
  // over.
  if (state === 'disconnecting') return;

  if (state === 'disconnecting') {
    postNotification('VPN disconnecting', stateMessage || 'Closing the tunnel.');
    return;
  }

  if (state === 'error') {
    postNotification('VPN error', stateMessage || 'The last operation failed.');
    sawDrop = false;
    return;
  }

  if (state === 'disconnected') {
    // "Disconnected" only repeats the state, so it keeps the standard detail:
    // anything else the controller says ("Connection cancelled", "The tunnel
    // closed") is what happened and is shown as it is.
    const detail = stateMessage && stateMessage.toLowerCase() !== 'disconnected' ? stateMessage : 'The tunnel is down.';
    postNotification('VPN disconnected', detail);
    sawDrop = false;
    userAskedDisconnect = false;
  }
}

/* ------------------------------------------------------------------- helper */

function renderHelperStatus(status) {
  if (!status || typeof status !== 'object') {
    el.helperBanner.hidden = true;
    renderSetupHelper(null);
    return;
  }

  const ready = status.ready === true;
  const clientOk = status.client?.ok !== false;
  renderSetupHelper(status);
  el.helperBanner.hidden = ready && clientOk;
  if (el.helperBanner.hidden) return;

  el.helperMessage.textContent = ready
    ? (status.client?.message || 'The VPN client is missing.')
    : (status.readyError || 'The privileged VPN helper is not installed or not authorized.');
}

async function refreshHelperStatus() {
  renderHelperStatus(await callApi(api.helperStatus));
}

/** One installer, two places that offer it: the banner and the assistant. */
async function installHelper(button = el.helperInstall) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Installing';
  try {
    await callApi(api.installHelper);
    logLine({ level: 'info', message: 'Helper installation finished.' });
  } catch (error) {
    logLine({ level: 'error', message: 'Helper installation failed: ' + errorText(error) });
  } finally {
    button.disabled = false;
    button.textContent = label;
    try {
      await refreshHelperStatus();
    } catch {
      // Keep the banner as it is when the status cannot be read.
    }
  }
}

/* ------------------------------------------------------------------- views */

/**
 * One pane at a time: the activity log, the settings form or the assistant.
 * The assistant hides the section tabs, because it is the only thing the user
 * has to look at while it runs; finishing it or postponing it brings them back.
 */
function showView(name, options = {}) {
  const setup = name === 'setup';
  const settings = name === 'settings';
  const activity = !setup && !settings;

  el.viewSetup.hidden = !setup;
  el.viewSettings.hidden = !settings;
  el.viewActivity.hidden = !activity;
  el.sectionSwitch.hidden = setup;
  el.tabActivity.setAttribute('aria-pressed', String(activity));
  el.tabSettings.setAttribute('aria-pressed', String(settings));

  if (settings && options.focus) {
    el.viewSettings.scrollTop = 0;
    el.server.focus();
  }
  if (setup) {
    renderSetupStep(options.step);
  }
  renderSetupBanner(setupPayload);
}

/* ---------------------------------------------------------------- settings */

function currentAuthMethod() {
  return el.authTotp.checked ? 'totp' : 'push';
}

function setAuthMethod(value) {
  const totp = textOf(value).toLowerCase().includes('totp');
  el.authPush.checked = !totp;
  el.authTotp.checked = totp;
}

function renderSecretHints() {
  el.passwordHint.textContent = SAVED_HINT;
  el.totpHint.textContent = SAVED_HINT;
  el.passwordHint.hidden = !secretsSaved.password;
  el.totpHint.hidden = !secretsSaved.totp;
}

function renderServerLabel() {
  const host = textOf(currentConfig.vpnServer);
  const port = currentConfig.vpnPort === undefined || currentConfig.vpnPort === null ? '' : String(currentConfig.vpnPort);
  serverLabel = host ? (port ? host + ':' + port : host) : '';
  renderMeta();
}

function setFieldError(key, message) {
  const node = el.errors[key];
  if (!node) return;
  node.textContent = message;
  node.hidden = message === '';
}

function clearErrors() {
  for (const node of Object.values(el.errors)) {
    node.textContent = '';
    node.hidden = true;
  }
  for (const input of validatedFields.keys()) input.removeAttribute('aria-invalid');
}

function markInvalid(input, key, message) {
  input.setAttribute('aria-invalid', 'true');
  setFieldError(key, message);
}

function renderEnvOverrides(names) {
  const list = Array.isArray(names) ? names.filter((name) => textOf(name) !== '') : [];
  el.settingsEnv.hidden = list.length === 0;
  el.settingsEnv.textContent = list.length === 0
    ? ''
    : 'Environment variables override the saved configuration: ' + list.join(', ') + '.';
}

/**
 * Where the password and the TOTP secret are kept. With a system store the line
 * names it; without one it says that the value is only as private as the
 * configuration file. Nothing is shown when the payload says nothing.
 */
function renderSecretsStore(info, node = el.settingsSecretsStore) {
  if (!node) return;
  const label = textOf(info?.label);
  if (info?.available === true && label !== '') {
    node.textContent = 'Secrets are stored in ' + label + '.';
    node.hidden = false;
    return;
  }
  if (info?.available === false) {
    const reason = textOf(info.reason);
    node.textContent = 'No system keychain is available'
      + (reason === '' ? '' : ': ' + reason)
      + '. Secrets are saved in the configuration file with mode 0600 and are not protected by the system.';
    node.hidden = false;
    return;
  }
  node.textContent = '';
  node.hidden = true;
}

function renderConfig(config) {
  if (!config || typeof config !== 'object') return;
  currentConfig = { ...config };

  el.server.value = textOf(config.vpnServer);
  el.port.value = config.vpnPort === undefined || config.vpnPort === null ? '' : String(config.vpnPort);
  el.realm.value = textOf(config.vpnRealm);
  el.username.value = textOf(config.username);
  el.chromePath.value = textOf(config.chromePath);
  setAuthMethod(config.authMethod);
  el.headless.checked = config.headless !== false;
  el.keepAwake.checked = config.keepAwake !== false;
  el.autoReconnect.checked = config.autoReconnect !== false;
  el.trustedCert.value = textOf(config.trustedCert) || 'any';
  el.debugScreenshots.checked = config.debugScreenshots === true;
  el.startAtLogin.checked = config.startAtLogin === true;

  el.password.value = '';
  el.totp.value = '';
  secretsSaved.password = secretsSaved.password || textOf(config.password) !== '' || config.hasPassword === true;
  secretsSaved.totp = secretsSaved.totp || textOf(config.totpSecret) !== '' || config.hasTotpSecret === true;
  renderSecretHints();
  clearErrors();
  renderServerLabel();

  // A window without a server is not configured yet: open the settings view,
  // unless the assistant is the pane that is open, because it configures the
  // same values in order.
  if (!textOf(config.vpnServer) && el.viewSetup.hidden) showView('settings');
}

function applyConfigPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.hasPassword === true) secretsSaved.password = true;
  if (payload.hasTotpSecret === true) secretsSaved.totp = true;
  renderEnvOverrides(payload.envOverrides);
  renderSecretsStore(payload.secretsStore);
  renderConfig(payload.config);
}

function setSettingsMessage(message, isError = false) {
  el.settingsMessage.textContent = message;
  el.settingsMessage.classList.toggle('form__message--error', isError === true);
}

/**
 * "Saved." stands alone. A note from the login item joins it, and a refusal is
 * reported as a warning: the configuration itself was written either way. A
 * secret written where the system cannot protect it is said out loud, next to
 * the save that wrote it.
 */
function settingsSavedMessage(result, patch = {}) {
  const parts = [];
  const loginItem = result?.loginItem;
  if (!loginItem || typeof loginItem !== 'object' || typeof loginItem.ok !== 'boolean') {
    parts.push('Saved.');
  } else {
    const note = textOf(loginItem.message);
    if (loginItem.ok === false) {
      parts.push(note === '' ? 'Saved, but the login item failed.' : 'Saved, but the login item failed: ' + note);
    } else {
      parts.push(note === '' ? 'Saved.' : 'Saved. ' + note);
    }
  }

  const wroteSecrets = patch.password !== undefined || patch.totpSecret !== undefined;
  if (wroteSecrets && result?.secretsStore?.available === false) {
    parts.push('Secrets are saved in the configuration file with mode 0600 and are not protected by the system.');
  }

  return parts.join(' ');
}

function collectConfigPatch() {
  const patch = {
    vpnServer: el.server.value.trim(),
    vpnRealm: el.realm.value.trim(),
    username: el.username.value.trim(),
    authMethod: currentAuthMethod(),
    headless: el.headless.checked,
    keepAwake: el.keepAwake.checked,
    autoReconnect: el.autoReconnect.checked,
    // openfortivpn needs "any" or a sha256 fingerprint, never a boolean.
    trustedCert: el.trustedCert.value.trim() || 'any',
    debugScreenshots: el.debugScreenshots.checked,
    chromePath: el.chromePath.value.trim(),
    vpnPort: el.port.value.trim(),
  };

  // A development run cannot register a login item, so it must not erase the
  // value the installed application stored.
  if (startAtLoginAvailable) patch.startAtLogin = el.startAtLogin.checked;

  // Secrets travel only when the user typed a new value.
  if (el.password.value !== '') patch.password = el.password.value;
  if (el.totp.value !== '') patch.totpSecret = el.totp.value;
  return patch;
}

function validateSettings() {
  clearErrors();
  let firstInvalid = null;
  const server = el.server.value.trim();
  const port = el.port.value.trim();
  const username = el.username.value.trim();
  const totp = el.totp.value.trim();
  const cert = el.trustedCert.value.trim() || 'any';

  if (server === '') {
    markInvalid(el.server, 'server', 'Enter the VPN server, for example vpn.example.com.');
    firstInvalid = firstInvalid ?? el.server;
  } else if (!HOST_PATTERN.test(server)) {
    markInvalid(el.server, 'server', 'Use a host name or an IP address, without spaces or slashes.');
    firstInvalid = firstInvalid ?? el.server;
  }

  if (port === '') {
    markInvalid(el.port, 'port', 'Enter the port, usually 443.');
    firstInvalid = firstInvalid ?? el.port;
  } else if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    markInvalid(el.port, 'port', 'Enter a port between 1 and 65535.');
    firstInvalid = firstInvalid ?? el.port;
  }

  if (username === '') {
    markInvalid(el.username, 'username', 'Enter the Microsoft account used for the sign-in.');
    firstInvalid = firstInvalid ?? el.username;
  }

  if (totp !== '' && !TOTP_SECRET_PATTERN.test(totp)) {
    markInvalid(el.totp, 'totp', 'Enter a base32 secret: letters A to Z and digits 2 to 7.');
    firstInvalid = firstInvalid ?? el.totp;
  }

  if (cert !== 'any' && !SHA256_PATTERN.test(cert)) {
    markInvalid(el.trustedCert, 'cert', 'Enter any, or the sha256 fingerprint (64 hex characters).');
    firstInvalid = firstInvalid ?? el.trustedCert;
  }

  return firstInvalid;
}

async function saveSettings(event) {
  event.preventDefault();
  const firstInvalid = validateSettings();
  if (firstInvalid) {
    setSettingsMessage('Fix the highlighted fields before saving.', true);
    firstInvalid.focus();
    return;
  }

  setSettingsMessage('Saving...');
  const patch = collectConfigPatch();
  try {
    const result = await callApi(api.saveConfig, patch);
    el.password.value = '';
    el.totp.value = '';
    if (patch.password !== undefined) secretsSaved.password = true;
    if (patch.totpSecret !== undefined) secretsSaved.totp = true;
    renderSecretHints();
    setSettingsMessage(settingsSavedMessage(result, patch), result?.loginItem?.ok === false);
    if (result && typeof result === 'object' && result.config) {
      applyConfigPayload(result);
    } else {
      currentConfig = { ...currentConfig, ...patch };
      renderServerLabel();
    }
  } catch (error) {
    setSettingsMessage('Could not save: ' + errorText(error), true);
  }
}

/* -------------------------------------------------------------- initial setup */

/*
 * The assistant is a pane of this window, painted from what the core decides
 * (src/core/setup.js): the step list, when it is due, the values the machine
 * already has and the flags that remember the answer. The window only renders,
 * validates what the user types and calls the same channels the settings form
 * uses, so the assistant and the form write the same configuration with the
 * same rules.
 */

/** The step the window is painting, or null when the core named none. */
function currentSetupStep() {
  if (setupSteps.length === 0) return null;
  return setupSteps[Math.min(setupStepIndex, setupSteps.length - 1)];
}

function currentSetupStepId() {
  return currentSetupStep()?.id ?? '';
}

function setSetupMessage(message, isError = false) {
  el.setupMessage.textContent = message;
  el.setupMessage.classList.toggle('form__message--error', isError === true);
}

/** Why this machine is not configured, in the words of the banner. */
function setupReasonsText(reasons) {
  return (Array.isArray(reasons) ? reasons : []).map((reason) => SETUP_REASON_TEXT[reason] ?? reason).join(', ');
}

/**
 * A machine that cannot connect must not look configured: while the assistant
 * is not open, the window states what is missing and offers to open it again.
 */
function renderSetupBanner(payload) {
  const visible = payload?.configured !== true && el.viewSetup.hidden;
  el.setupBanner.hidden = !visible;
  if (!visible) return;

  const missing = setupReasonsText(payload?.reasons);
  el.setupBannerMessage.textContent = missing === ''
    ? 'The initial setup is not finished.'
    : 'The initial setup is not finished: ' + missing + '.';
}

/** The steps the core named, as the first step promises them. */
function renderSetupWelcomeList() {
  el.setupWelcomeList.replaceChildren(...setupSteps.map((step) => {
    const item = document.createElement('li');
    item.textContent = textOf(step?.title) || textOf(step?.id) || 'Step';
    return item;
  }));
}

/** Step 2 resolved: the helper is there, so there is nothing to install. */
function renderSetupHelper(status) {
  const ready = status?.ready === true;
  el.setupHelperReady.hidden = !ready;
  el.setupHelperPending.hidden = ready;
  el.setupHelperInstall.hidden = ready;
  el.setupHelperInstall.disabled = ready;
}

function openSetup({ step = 0 } = {}) {
  renderSetupWelcomeList();
  showView('setup', { step });
}

function renderSetupStep(step = null) {
  if (Number.isInteger(step)) setupStepIndex = step;
  const current = currentSetupStep();
  const id = currentSetupStepId();

  for (const [key, node] of Object.entries(el.setupSteps)) node.hidden = key !== id;

  el.setupStepTitle.textContent = textOf(current?.title) || 'Initial setup';
  el.setupStepCounter.textContent = setupSteps.length > 0 ? 'Step ' + (setupStepIndex + 1) + ' of ' + setupSteps.length : '';
  el.setupStepCounter.hidden = setupSteps.length === 0;
  el.setupBack.disabled = setupStepIndex === 0 || setupBusy;
  el.setupNext.disabled = setupBusy;
  el.setupNext.textContent = id === 'welcome' ? 'Start' : 'Continue';
  // The last step answers itself: it offers Finish and Connect now.
  el.setupNext.hidden = id === 'summary';
  el.setupLater.hidden = id === 'summary';
  el.setupBody.scrollTop = 0;
  setSetupMessage('');
  renderSetupStepData(id);
}

function renderSetupStepData(id) {
  if (id === 'welcome') renderSetupWelcomeList();
  else if (id === 'helper') renderSetupHelper(setupPayload?.helper);
  else if (id === 'summary') renderSetupSummary();
  else if (id === 'command') void loadCommandLine();
}

/* ------------------------------------------------------ the values of a step */

function setupInputs() {
  return { server: el.setupServer, port: el.setupPort, username: el.setupUsername, totp: el.setupTotp };
}

function markSetupInvalid(input, key, message) {
  input.setAttribute('aria-invalid', 'true');
  const node = el.setupErrors[key];
  if (node) {
    node.textContent = message;
    node.hidden = false;
  }
  return input;
}

function clearSetupErrors() {
  for (const node of Object.values(el.setupErrors)) {
    node.textContent = '';
    node.hidden = true;
  }
  for (const input of Object.values(setupInputs())) input.removeAttribute('aria-invalid');
}

function clearSetupFieldError(input) {
  for (const [key, node] of Object.entries(setupInputs())) {
    if (node !== input) continue;
    input.removeAttribute('aria-invalid');
    const error = el.setupErrors[key];
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
  }
}

function currentSetupAuthMethod() {
  return el.setupAuthTotp.checked ? 'totp' : 'push';
}

function setSetupAuthMethod(value) {
  const totp = textOf(value).toLowerCase().includes('totp');
  el.setupAuthPush.checked = !totp;
  el.setupAuthTotp.checked = totp;
  updateSetupTotpField();
}

/** The TOTP secret is only asked for when the sign-in uses a TOTP code. */
function updateSetupTotpField() {
  el.setupTotpField.hidden = currentSetupAuthMethod() !== 'totp';
}

function renderSetupSecretHints() {
  el.setupPasswordHint.textContent = SAVED_HINT;
  el.setupTotpHint.textContent = SAVED_HINT;
  el.setupPasswordHint.hidden = !secretsSaved.password;
  el.setupTotpHint.hidden = !secretsSaved.totp;
}

function validateSetupServer() {
  clearSetupErrors();
  const server = el.setupServer.value.trim();
  const port = el.setupPort.value.trim();

  if (server === '') return markSetupInvalid(el.setupServer, 'server', 'Enter the VPN server, for example vpn.example.com.');
  if (!HOST_PATTERN.test(server)) {
    return markSetupInvalid(el.setupServer, 'server', 'Use a host name or an IP address, without spaces or slashes.');
  }
  if (port === '') return markSetupInvalid(el.setupPort, 'port', 'Enter the port, usually 443.');
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return markSetupInvalid(el.setupPort, 'port', 'Enter a port between 1 and 65535.');
  }
  return null;
}

function validateSetupAuthentication() {
  clearSetupErrors();
  if (el.setupUsername.value.trim() === '') {
    return markSetupInvalid(el.setupUsername, 'username', 'Enter the Microsoft account used for the sign-in.');
  }
  if (el.setupTotpField.hidden) return null;

  const totp = el.setupTotp.value.trim();
  if (totp !== '' && !TOTP_SECRET_PATTERN.test(totp)) {
    return markSetupInvalid(el.setupTotp, 'totp', 'Enter a base32 secret: letters A to Z and digits 2 to 7.');
  }
  if (totp === '' && !secretsSaved.totp) {
    return markSetupInvalid(el.setupTotp, 'totp', 'A TOTP sign-in needs the base32 secret of the authenticator entry.');
  }
  return null;
}

/**
 * Saves the values of a step through the settings channel, which is the same
 * write the form does: the empty secret keeps the stored one, and a secret only
 * reaches the configuration file when the machine has no store for it.
 */
async function saveSetupValues(patch) {
  const result = await callApi(api.saveConfig, patch);
  if (result?.ok === false) return result.message ?? 'The configuration could not be saved.';
  if (result && typeof result === 'object') applyConfigPayload(result);
  await loadSetup();
  return '';
}

async function applySetupServer() {
  return saveSetupValues({
    vpnServer: el.setupServer.value.trim(),
    vpnPort: el.setupPort.value.trim(),
    vpnRealm: el.setupRealm.value.trim(),
  });
}

async function applySetupAuthentication() {
  const patch = { username: el.setupUsername.value.trim(), authMethod: currentSetupAuthMethod() };
  if (!el.setupTotpField.hidden && el.setupTotp.value !== '') patch.totpSecret = el.setupTotp.value;
  return saveSetupValues(patch);
}

async function applySetupPassword() {
  if (el.setupPassword.value === '') return '';
  return saveSetupValues({ password: el.setupPassword.value });
}

async function applySetupTunnel() {
  const patch = { keepAwake: el.setupKeepAwake.checked, autoReconnect: el.setupAutoReconnect.checked };
  // A development run cannot register a login item, so it must not erase the
  // value the installed application stored.
  if (startAtLoginAvailable) patch.startAtLogin = el.setupStartAtLogin.checked;
  return saveSetupValues(patch);
}

/** What each step does when the user continues: validate first, then write. */
const SETUP_STEP_SAVE = {
  server: { validate: validateSetupServer, apply: applySetupServer },
  authentication: { validate: validateSetupAuthentication, apply: applySetupAuthentication },
  secrets: { apply: applySetupPassword },
  tunnel: { apply: applySetupTunnel },
};

async function setupNext() {
  if (setupBusy) return;
  const step = SETUP_STEP_SAVE[currentSetupStepId()];

  if (step) {
    if (typeof step.validate === 'function') {
      const invalid = step.validate();
      if (invalid) {
        setSetupMessage('Fix the highlighted fields before continuing.', true);
        invalid.focus();
        return;
      }
    }

    setupBusy = true;
    renderSetupStep();
    try {
      const problem = await step.apply();
      if (problem !== '') {
        setSetupMessage(problem, true);
        return;
      }
    } catch (error) {
      setSetupMessage('Could not save: ' + errorText(error), true);
      return;
    } finally {
      setupBusy = false;
      el.setupNext.disabled = false;
      el.setupBack.disabled = setupStepIndex === 0;
    }
  }

  if (setupStepIndex >= setupSteps.length - 1) return;
  setupStepIndex += 1;
  renderSetupStep();
}

function setupBack() {
  if (setupStepIndex === 0 || setupBusy) return;
  setupStepIndex -= 1;
  renderSetupStep();
}

/** The core records the answer; the window closes the pane and says so. */
async function completeSetup() {
  const payload = await callApi(api.setupComplete);
  if (payload && typeof payload === 'object') setupPayload = payload;
  logLine({ level: 'info', message: 'Initial setup completed.' });
  showView('activity');
  return payload;
}

/** "Later": nothing is lost and the window keeps saying what is missing. */
async function postponeSetup() {
  el.setupLater.disabled = true;
  try {
    const payload = await callApi(api.setupSkip);
    if (payload && typeof payload === 'object') setupPayload = payload;
    logLine({ level: 'info', message: 'Initial setup postponed. The banner says what is still missing.' });
    showView('activity');
  } catch (error) {
    setSetupMessage('The assistant could not be postponed: ' + errorText(error), true);
  } finally {
    el.setupLater.disabled = false;
  }
}

/** The last step without connecting: the machine is configured, so it is done. */
async function finishSetup() {
  el.setupFinish.disabled = true;
  try {
    await completeSetup();
  } catch (error) {
    setSetupMessage('The assistant could not be closed: ' + errorText(error), true);
  } finally {
    el.setupFinish.disabled = false;
  }
}

async function connectFromSetup() {
  el.setupConnect.disabled = true;
  try {
    await completeSetup();
    await toggleConnection();
  } catch (error) {
    logLine({ level: 'error', message: 'The connection could not be started: ' + errorText(error) });
  } finally {
    el.setupConnect.disabled = false;
  }
}

/* ---------------------------------------------------- the terminal command */

/** Step 7: what the command line tool of this build is, and where it would go. */
async function loadCommandLine() {
  el.setupCommandStatus.textContent = 'Looking for the command line tool of this build...';
  el.setupCommandAdmin.hidden = true;
  el.setupCommandInstall.hidden = true;

  let report = null;
  try {
    report = await callApi(api.commandLineStatus);
  } catch (error) {
    el.setupCommandStatus.textContent = 'The command line tool could not be checked: ' + errorText(error);
    return null;
  }

  commandLineReport = report;
  if (!report || report.available !== true) {
    el.setupCommandStatus.textContent = report?.message
      ?? 'The command line tool ships with the installed application, and this run is not one of them.';
    return report;
  }
  if (report.ok !== true) {
    // The launcher is there but it did not answer: say that, instead of
    // pretending there is no directory to install into.
    el.setupCommandStatus.textContent = report.message || 'The command line tool could not be queried.';
    return report;
  }

  el.setupCommandInstall.hidden = false;
  const entry = report.entry;
  if (entry?.state === 'ours') {
    // Nothing to install: the command of this build is the one a terminal runs.
    el.setupCommandStatus.textContent = 'The command is already installed: ' + (entry.path ?? '') + '.';
    el.setupCommandInstall.hidden = true;
  } else if (report.directory) {
    el.setupCommandStatus.textContent = 'The command goes into ' + report.directory
      + (report.onPath === true ? ', which is in your PATH.' : ', which is not in your PATH yet.');
  } else {
    el.setupCommandStatus.textContent = 'No directory of the PATH takes the command yet.';
  }

  const alternative = report.alternative;
  if (alternative) {
    el.setupCommandAdmin.hidden = false;
    el.setupCommandAdmin.textContent = 'That directory is not in the PATH of a new terminal, so the command has no name there yet. To put it in '
      + alternative.directory + ' instead, which every terminal searches, run this once in a terminal: '
      + alternative.command + '. That directory needs administrator permission.';
  }
  return report;
}

async function installCommandLineFromSetup() {
  // Navigation waits for the install: the summary of the next step states
  // whether the command is linked, and a read taken in the middle of it would
  // say the wrong thing.
  setupBusy = true;
  el.setupCommandInstall.disabled = true;
  el.setupNext.disabled = true;
  el.setupBack.disabled = true;
  const label = el.setupCommandInstall.textContent;
  el.setupCommandInstall.textContent = 'Installing';
  try {
    const result = await callApi(api.commandLineInstall);
    if (result?.installed === true) {
      setSetupMessage('The command is installed. Open a new terminal and run: fortin status');
    } else {
      setSetupMessage(result?.message || 'The command could not be installed.', true);
    }
  } catch (error) {
    setSetupMessage('The command could not be installed: ' + errorText(error), true);
  } finally {
    el.setupCommandInstall.disabled = false;
    el.setupCommandInstall.textContent = label;
    await loadCommandLine();
    setupBusy = false;
    el.setupNext.disabled = false;
    el.setupBack.disabled = setupStepIndex === 0;
  }
}

/* -------------------------------------------------------------- the summary */

function authMethodLabel(value) {
  return value === 'totp' ? 'TOTP code' : 'Push notification';
}

function setupCommandLineText() {
  if (!commandLineReport) return 'not checked';
  if (commandLineReport.available !== true) return 'not available in this run';
  if (commandLineReport.entry?.state === 'ours') return 'installed';
  return 'not installed';
}

/** What the assistant configured, as the last step states it. */
function renderSetupSummary() {
  const payload = setupPayload ?? {};
  const config = payload.config?.config ?? {};
  const store = payload.config?.secretsStore;
  const port = config.vpnPort === undefined || config.vpnPort === null ? '' : String(config.vpnPort);
  const host = textOf(config.vpnServer);
  const whereSecrets = store?.available === true ? store.label : 'the configuration file (mode 0600)';

  const rows = [
    ['VPN server', host === '' ? 'not set' : host + (port === '' ? '' : ':' + port)],
    ['Realm', textOf(config.vpnRealm) || 'none'],
    ['Microsoft account', textOf(config.username) || 'not set'],
    ['Sign-in', authMethodLabel(config.authMethod)],
    ['Password', secretsSaved.password ? 'stored in ' + whereSecrets : 'asked when connecting'],
    ['TOTP secret', secretsSaved.totp ? 'stored in ' + whereSecrets : 'not used'],
    ['Privileged helper', payload.helper?.ready === true ? 'ready' : 'not ready yet'],
    ['Start at login', config.startAtLogin === true ? 'enabled' : 'disabled'],
    ['Keep the machine awake', config.keepAwake === false ? 'disabled' : 'enabled'],
    ['Reconnect by itself', config.autoReconnect === false ? 'disabled' : 'enabled'],
    ['Terminal command', setupCommandLineText()],
  ];

  const cells = [];
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    cells.push(term, detail);
  }
  el.setupSummary.replaceChildren(...cells);
}

/* ---------------------------------------------------------------- the answer */

/**
 * Reads the answer of the core: the step list, the values the machine already
 * has and the banner a machine that is not configured shows. On the first load
 * it opens the assistant when the core says it is due; a login start passes
 * `open: false` only through the fact that nobody has asked for the window.
 */
async function loadSetup({ open = false } = {}) {
  let payload = null;
  try {
    payload = await callApi(api.setupStatus);
  } catch (error) {
    logLine({ level: 'error', message: 'Could not read the initial setup: ' + errorText(error) });
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  setupPayload = payload;
  setupSteps = Array.isArray(payload.steps) ? payload.steps : [];
  renderSetupFields(payload);
  renderSetupBanner(payload);
  if (open === true && payload.due === true && el.viewSetup.hidden === true) openSetup();
  return payload;
}

/**
 * Prefills every step with what this machine has, so repeating the assistant
 * never asks again for a value that is stored. Secrets are never rendered: a
 * saved password or TOTP secret only shows the "(saved)" hint.
 */
function renderSetupFields(payload) {
  const config = payload?.config?.config;
  if (!config || typeof config !== 'object') return;

  el.setupServer.value = textOf(config.vpnServer);
  el.setupPort.value = config.vpnPort === undefined || config.vpnPort === null ? '' : String(config.vpnPort);
  el.setupRealm.value = textOf(config.vpnRealm);
  el.setupUsername.value = textOf(config.username);
  setSetupAuthMethod(config.authMethod);
  el.setupKeepAwake.checked = config.keepAwake !== false;
  el.setupAutoReconnect.checked = config.autoReconnect !== false;
  el.setupStartAtLogin.checked = config.startAtLogin === true;

  el.setupPassword.value = '';
  el.setupTotp.value = '';
  secretsSaved.password = payload.config?.hasPassword === true || secretsSaved.password;
  secretsSaved.totp = payload.config?.hasTotpSecret === true || secretsSaved.totp;
  renderSetupSecretHints();
  renderSecretsStore(payload.config?.secretsStore, el.setupSecretsStore);
  renderSetupHelper(payload.helper);
  clearSetupErrors();
}

/* --------------------------------------------------------------- credentials */

function describeAttempt(request) {
  if (typeof request?.attempt !== 'number') return '';
  if (typeof request?.max === 'number' && request.max > 0) {
    return 'Attempt ' + request.attempt + ' of ' + request.max;
  }
  return 'Attempt ' + request.attempt;
}

function revealPassword(show) {
  const visible = show === true;
  el.modalInput.type = visible ? 'text' : 'password';
  el.modalReveal.textContent = visible ? 'Hide' : 'Show';
  el.modalReveal.setAttribute('aria-pressed', String(visible));
}

function configureCredentialInput(kind) {
  const input = el.modalInput;
  input.value = '';
  revealPassword(false);

  if (kind === 'totp') {
    el.modalTitle.textContent = 'Authentication code required';
    el.modalInputLabel.textContent = 'Authentication code';
    el.modalHelp.textContent = 'Six digits from the authenticator app.';
    el.modalReveal.hidden = true;
    input.type = 'text';
    input.inputMode = 'numeric';
    input.maxLength = TOTP_LENGTH;
    input.setAttribute('pattern', '[0-9]*');
    input.setAttribute('autocomplete', 'one-time-code');
    input.setAttribute('placeholder', '123456');
    return;
  }

  el.modalTitle.textContent = 'Password required';
  el.modalInputLabel.textContent = 'Password';
  el.modalHelp.textContent = 'The Microsoft password for this account.';
  el.modalReveal.hidden = false;
  input.type = 'password';
  input.removeAttribute('inputmode');
  input.removeAttribute('maxlength');
  input.removeAttribute('pattern');
  input.setAttribute('autocomplete', 'current-password');
  input.setAttribute('placeholder', '');
}

function credentialMessage(request, kind) {
  const raw = textOf(request?.message);
  if (raw !== '' && Object.hasOwn(CREDENTIAL_REASONS, raw.toLowerCase())) {
    return CREDENTIAL_REASONS[raw.toLowerCase()];
  }
  if (raw !== '') return raw;
  return kind === 'totp' ? 'Enter the code from your authenticator app.' : 'Enter your account password.';
}

function setCredentialError(message) {
  el.modalError.textContent = message;
  el.modalError.hidden = message === '';
}

function answerCredentials(body) {
  if (typeof api.answerCredentials !== 'function') {
    logLine({ level: 'error', message: 'The credential answer could not be sent: the bridge is not available.' });
    return;
  }
  Promise.resolve(api.answerCredentials(body)).catch((error) => {
    logLine({ level: 'error', message: 'The credential answer failed: ' + errorText(error) });
  });
}

function showCredentialsRequest(request) {
  if (!request || request.id === undefined || request.id === null) return;

  // Never leave the main process waiting on a request that is no longer shown.
  if (pendingRequest) answerCredentials({ id: pendingRequest.id, cancel: true });

  pendingRequest = request;
  credentialKind = request.kind === 'totp' ? 'totp' : 'password';

  el.modalMessage.textContent = credentialMessage(request, credentialKind);
  el.modalAttempt.textContent = describeAttempt(request);
  el.modalAttempt.hidden = el.modalAttempt.textContent === '';
  configureCredentialInput(credentialKind);
  setCredentialError('');

  if (!el.modal.open) el.modal.showModal();
  el.modalInput.focus();
}

function closeCredentialsModal() {
  if (el.modal.open) el.modal.close();
}

function submitCredentials(event) {
  event.preventDefault();
  const request = pendingRequest;
  if (!request) {
    closeCredentialsModal();
    return;
  }

  const value = el.modalInput.value.trim();
  if (value === '') {
    setCredentialError(credentialKind === 'totp' ? 'Enter the 6-digit code.' : 'Enter the password.');
    return;
  }
  if (credentialKind === 'totp' && !TOTP_PATTERN.test(value)) {
    setCredentialError('Enter the ' + TOTP_LENGTH + '-digit code.');
    return;
  }

  pendingRequest = null;
  closeCredentialsModal();
  // The value is never written to the log panel.
  logLine({ level: 'info', message: credentialKind === 'totp' ? 'Authentication code submitted.' : 'Password submitted.' });
  answerCredentials({ id: request.id, value });
}

function cancelCredentials(event) {
  if (event) event.preventDefault();
  const request = pendingRequest;
  pendingRequest = null;
  closeCredentialsModal();
  if (!request) return;
  logLine({ level: 'info', message: 'Credential request cancelled.' });
  answerCredentials({ id: request.id, cancel: true });
}

function keepTotpNumeric() {
  if (credentialKind !== 'totp') return;
  const digits = el.modalInput.value.replace(/[^0-9]/g, '').slice(0, TOTP_LENGTH);
  if (digits !== el.modalInput.value) el.modalInput.value = digits;
}

/* ------------------------------------------------------------------ versions */

function renderAppInfo(info) {
  const app = firstValue(info, ['appVersion', 'version', 'app.version']) ?? 'unknown';
  const electron = firstValue(info, ['electron', 'electronVersion', 'versions.electron']) ?? 'unknown';
  const platform = firstValue(info, ['platform', 'os', 'process.platform']) ?? 'unknown';
  el.versionApp.textContent = 'App ' + app;
  el.versionElectron.textContent = 'Electron ' + electron;
  el.versionPlatform.textContent = String(platform);
  setStartAtLoginAvailability(info?.isPackaged === true);
}

/** The switch and its note follow what this build can really do. */
function setStartAtLoginAvailability(available) {
  startAtLoginAvailable = available === true;
  el.startAtLogin.disabled = !startAtLoginAvailable;
  el.startAtLoginHelp.hidden = startAtLoginAvailable;
  el.setupStartAtLogin.disabled = !startAtLoginAvailable;
  el.setupStartAtLoginHelp.hidden = startAtLoginAvailable;
}

/* ------------------------------------------------------------- wiring / init */

function subscribe(event, handler) {
  if (typeof api.on !== 'function') return;
  try {
    api.on(event, handler);
  } catch (error) {
    logLine({ level: 'error', message: 'Could not subscribe to ' + event + ': ' + errorText(error) });
  }
}

function clearFieldError(input) {
  const key = validatedFields.get(input);
  if (!key) return;
  input.removeAttribute('aria-invalid');
  setFieldError(key, '');
}

function bindEvents() {
  el.primary.addEventListener('click', () => {
    void toggleConnection();
  });
  el.cancelAction.addEventListener('click', () => {
    void cancelConnection();
  });
  el.tabActivity.addEventListener('click', () => showView('activity'));
  el.tabSettings.addEventListener('click', () => showView('settings'));
  for (const button of el.filterButtons) {
    button.addEventListener('click', () => setFilter(button.dataset.level));
  }
  el.logCopy.addEventListener('click', () => {
    void copyLog();
  });
  el.logClear.addEventListener('click', clearLog);
  el.logLatest.addEventListener('click', () => {
    stickToBottom = true;
    scrollToBottom();
    updateLatestButton();
  });
  el.logOutput.addEventListener('scroll', () => {
    stickToBottom = el.logOutput.scrollHeight - el.logOutput.scrollTop - el.logOutput.clientHeight <= SCROLL_STICK_PX;
    updateLatestButton();
  });
  el.helperInstall.addEventListener('click', () => {
    void installHelper();
  });
  el.setupHelperInstall.addEventListener('click', () => {
    void installHelper(el.setupHelperInstall);
  });
  el.setupBannerOpen.addEventListener('click', () => openSetup());
  el.setupLater.addEventListener('click', () => {
    void postponeSetup();
  });
  el.setupBack.addEventListener('click', setupBack);
  el.setupNext.addEventListener('click', () => {
    void setupNext();
  });
  el.setupConnect.addEventListener('click', () => {
    void connectFromSetup();
  });
  el.setupFinish.addEventListener('click', () => {
    void finishSetup();
  });
  el.setupCommandInstall.addEventListener('click', () => {
    void installCommandLineFromSetup();
  });
  for (const radio of [el.setupAuthPush, el.setupAuthTotp]) {
    radio.addEventListener('change', updateSetupTotpField);
  }
  for (const input of Object.values(setupInputs())) {
    input.addEventListener('input', (event) => clearSetupFieldError(event.target));
  }
  el.settingsForm.addEventListener('submit', (event) => {
    void saveSettings(event);
  });
  el.settingsForm.addEventListener('input', (event) => clearFieldError(event.target));
  el.logsOpen.addEventListener('click', () => {
    void callApi(api.openLogs).catch((error) => logLine({ level: 'error', message: 'Could not open the log folder: ' + errorText(error) }));
  });
  el.screenshotsOpen.addEventListener('click', () => {
    void callApi(api.openScreenshots).catch((error) =>
      logLine({ level: 'error', message: 'Could not open the screenshots folder: ' + errorText(error) }),
    );
  });
  el.appQuit.addEventListener('click', () => {
    void callApi(api.quit).catch((error) => logLine({ level: 'error', message: 'Could not quit: ' + errorText(error) }));
  });
  el.modalForm.addEventListener('submit', submitCredentials);
  el.modalCancel.addEventListener('click', cancelCredentials);
  el.modal.addEventListener('cancel', cancelCredentials);
  el.modalReveal.addEventListener('click', () => revealPassword(el.modalInput.type === 'password'));
  el.modalInput.addEventListener('input', keepTotpNumeric);
}

function subscribeEvents() {
  subscribe('state:changed', (payload) => {
    if (payload && typeof payload === 'object') renderState(payload);
  });
  subscribe('log:line', (line) => logLine(line));
  subscribe('progress', (event) => renderProgress(event));
  subscribe('credentials:request', (request) => showCredentialsRequest(request));
  subscribe('helper:changed', (status) => {
    // An empty payload means "something changed": ask for the current status.
    if (status === undefined || status === null) {
      void refreshHelperStatus().catch(() => {});
      return;
    }
    renderHelperStatus(status);
  });
  subscribe('ui:focus', (payload) => {
    const section = textOf(payload?.section);
    if (section === 'settings') showView('settings', { focus: true });
    if (section === 'setup') openSetup();
  });
}

async function loadAppInfo() {
  try {
    renderAppInfo(await callApi(api.appInfo));
  } catch (error) {
    logLine({ level: 'error', message: 'Could not read the app version: ' + errorText(error) });
  }
}

async function loadConfig() {
  try {
    const payload = await callApi(api.getConfig);
    secretsSaved.password = payload?.hasPassword === true;
    secretsSaved.totp = payload?.hasTotpSecret === true;
    renderEnvOverrides(payload?.envOverrides);
    renderSecretsStore(payload?.secretsStore);
    renderConfig(payload?.config);
  } catch (error) {
    logLine({ level: 'error', message: 'Could not read the configuration: ' + errorText(error) });
  }
}

async function loadHelperStatus() {
  try {
    await refreshHelperStatus();
  } catch (error) {
    el.helperBanner.hidden = true;
    logLine({ level: 'error', message: 'Could not read the helper status: ' + errorText(error) });
  }
}

async function loadRecentLogs() {
  try {
    const payload = await callApi(api.recentLogs, { lines: LOG_LINE_LIMIT });
    if (Array.isArray(payload?.lines)) payload.lines.forEach((line) => logLine(line));
  } catch (error) {
    logLine({ level: 'error', message: 'Could not read the recent log lines: ' + errorText(error) });
  }
}

async function start() {
  bindEvents();
  subscribeEvents();
  reportBridgeGap();
  setFilter('all');
  renderStatusCard();
  renderPrimaryAction();
  renderCancelAction();
  renderMeta();
  updateLogStatus();
  await Promise.all([
    loadAppInfo(),
    loadConfig(),
    loadHelperStatus(),
    loadRecentLogs(),
    refreshState().catch(() => {}),
    loadSetup({ open: true }),
  ]);
  updateLatestButton();
}

void start();
