/**
 * Preload script (CommonJS on purpose: it is the only file loaded outside the
 * ESM module graph).
 *
 * It exposes `window.vpn` through contextBridge and never gives the renderer
 * direct access to ipcRenderer or to Node APIs.
 *
 * The exposed object offers, for convenience:
 *   - one flat method per invoke channel: appInfo(), configGet(), configSave(patch),
 *     vpnConnect({authMethod, foreground}), vpnCancel(), vpnDisconnect(), vpnStatus(), vpnState(),
 *     logsRecent({lines}), shellOpenLogs(), shellOpenScreenshots(), helperStatus(),
 *     helperInstall(), setupStatus(), setupComplete(), setupSkip(), commandLineStatus(),
 *     commandLineInstall(), credentialsAnswer({id, value, cancel}), appQuit()
 *   - the same methods grouped by area: app.info(), config.get(), vpn.connect(), ...
 *   - invoke(channel, payload) for anything else
 *   - on(event, callback), which returns an unsubscribe function
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Channels answered by main through ipcMain.handle. */
const INVOKE_CHANNELS = [
  'app:info',
  'config:get',
  'config:save',
  'vpn:connect',
  'vpn:disconnect',
  'vpn:cancel',
  'vpn:status',
  'vpn:state',
  'logs:recent',
  'shell:open-logs',
  'shell:open-screenshots',
  'helper:status',
  'helper:install',
  'setup:status',
  'setup:complete',
  'setup:skip',
  'command-line:status',
  'command-line:install',
  'credentials:answer',
  'app:quit',
];

/** Events pushed by main to the renderer. */
const EVENT_CHANNELS = [
  'state:changed',
  'log:line',
  'progress',
  'credentials:request',
  'helper:changed',
  'ui:focus',
];

function invokeOn(channel) {
  if (!INVOKE_CHANNELS.includes(channel)) {
    throw new Error(`Unknown invoke channel: ${channel}`);
  }
  return (payload) => ipcRenderer.invoke(channel, payload);
}

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.includes(channel)) {
    return Promise.reject(new Error(`Unknown invoke channel: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload);
}

function on(event, callback) {
  if (!EVENT_CHANNELS.includes(event)) {
    throw new Error(`Unknown event channel: ${event}`);
  }
  if (typeof callback !== 'function') {
    throw new TypeError('on(event, callback) needs a callback function');
  }
  const listener = (_ipcEvent, payload) => callback(payload);
  ipcRenderer.on(event, listener);
  return () => ipcRenderer.removeListener(event, listener);
}

const appInfo = invokeOn('app:info');
const configGet = invokeOn('config:get');
const configSave = invokeOn('config:save');
const vpnConnect = invokeOn('vpn:connect');
const vpnDisconnect = invokeOn('vpn:disconnect');
const vpnCancel = invokeOn('vpn:cancel');
const vpnStatus = invokeOn('vpn:status');
const vpnState = invokeOn('vpn:state');
const logsRecent = invokeOn('logs:recent');
const shellOpenLogs = invokeOn('shell:open-logs');
const shellOpenScreenshots = invokeOn('shell:open-screenshots');
const helperStatus = invokeOn('helper:status');
const helperInstall = invokeOn('helper:install');
const setupStatus = invokeOn('setup:status');
const setupComplete = invokeOn('setup:complete');
const setupSkip = invokeOn('setup:skip');
const commandLineStatus = invokeOn('command-line:status');
const commandLineInstall = invokeOn('command-line:install');
const credentialsAnswer = invokeOn('credentials:answer');
const appQuit = invokeOn('app:quit');

contextBridge.exposeInMainWorld('vpn', {
  invoke,
  on,
  channels: { invoke: [...INVOKE_CHANNELS], events: [...EVENT_CHANNELS] },

  // Flat API, one method per channel.
  appInfo,
  configGet,
  configSave,
  vpnConnect,
  vpnDisconnect,
  vpnCancel,
  vpnStatus,
  vpnState,
  logsRecent,
  shellOpenLogs,
  shellOpenScreenshots,
  helperStatus,
  helperInstall,
  setupStatus,
  setupComplete,
  setupSkip,
  commandLineStatus,
  commandLineInstall,
  credentialsAnswer,
  appQuit,

  // Grouped aliases for the same methods.
  app: { info: appInfo, quit: appQuit },
  config: { get: configGet, save: configSave },
  vpn: { connect: vpnConnect, cancel: vpnCancel, disconnect: vpnDisconnect, status: vpnStatus, state: vpnState },
  logs: { recent: logsRecent },
  shell: { openLogs: shellOpenLogs, openScreenshots: shellOpenScreenshots },
  helper: { status: helperStatus, install: helperInstall },
  setup: { status: setupStatus, complete: setupComplete, skip: setupSkip },
  commandLine: { status: commandLineStatus, install: commandLineInstall },
  credentials: { answer: credentialsAnswer },
});
