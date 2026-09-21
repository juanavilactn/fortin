/**
 * IPC layer between the Electron main process and the renderer.
 *
 * Almost every handler is one line over the shared session (src/core/session.js):
 * the tunnel, the configuration, the secret status, the helper, the logs and the
 * login item all live in the core, where the CLI reaches the same code. What is
 * here is only what a window has and a terminal does not:
 *
 *   - the credentials modal: the session asks through 'credentials:request' and
 *     the answer comes back through the `credentials:answer` channel;
 *   - the folder pickers for the log and the screenshots;
 *   - `ui:focus`, the hint the tray uses to open a section.
 *
 * The channels are listed in src/core/api.js with the terminal equivalent of
 * each one; test/parity.test.js reads this file's channel list through
 * src/main/preload.cjs and fails when a channel loses its counterpart.
 */

import fs from 'node:fs';
import { ipcMain, shell } from 'electron';

/** Every channel this module registers, removed again by dispose(). */
const HANDLED_CHANNELS = [
  'app:info',
  'config:get',
  'config:save',
  'vpn:connect',
  'vpn:disconnect',
  'vpn:cancel',
  'vpn:state',
  'vpn:status',
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

/**
 * @param {object} deps
 * @param {import('../core/session.js').VpnSession} deps.session
 * @param {object} deps.paths     result of getPaths()
 * @param {() => Electron.BrowserWindow|null} deps.getWindow
 * @param {() => void} deps.quit
 * @param {object} deps.runtime   what only the desktop knows about itself
 *                                ({electron, chrome, isPackaged})
 */
export function registerIpc({ session, paths, getWindow, quit, runtime = {} }) {
  /* ------------------------------------------------------------- transport */

  function send(channel, payload) {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    window.webContents.send(channel, payload);
    return true;
  }

  /** The log event carries either a logger line or the line itself. */
  function sendLog(line) {
    if (line && typeof line === 'object') return send('log:line', line);
    return send('log:line', { level: 'info', message: String(line ?? ''), time: new Date().toISOString() });
  }

  function broadcast(channel, payload) {
    return send(channel, payload);
  }

  /**
   * The tray asks the window to open a section. A window the tray just created
   * has not loaded the renderer yet, so the hint waits for the load instead of
   * being lost on the way.
   */
  function focus(section) {
    const payload = { section: section ?? 'window' };
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    // A webContents that is still loading has not subscribed yet, and a
    // message sent before that is dropped: it waits for the load to finish.
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => send('ui:focus', payload));
      return true;
    }
    send('ui:focus', payload);
    return true;
  }

  /* ----------------------------------------------------------------- events */

  const forwarded = {
    state: (payload) => send('state:changed', payload),
    log: (line) => sendLog(line),
    progress: (payload) => send('progress', payload ?? {}),
    helper: (status) => send('helper:changed', status),
  };
  session.on('state', forwarded.state);
  session.on('log', forwarded.log);
  session.on('progress', forwarded.progress);
  session.on('helper:changed', forwarded.helper);

  /**
   * The session asks for a password through its event and waits for
   * `credentials:answer` with the same id. A window that is gone fails the
   * request at once, so the attempt reports "nobody could ask" instead of
   * waiting for a modal that can never appear.
   */
  session.on('credentials:request', (request) => {
    if (!send('credentials:request', request)) {
      session.answerCredentials(request.id, { error: 'No window available to request credentials' });
    }
  });

  /* ---------------------------------------------------------------- folders */

  async function openFolder(directory, label) {
    try {
      await fs.promises.mkdir(directory, { recursive: true });
    } catch {
      // Opening a folder that does not exist yet is fine, openPath reports it.
    }
    const error = await shell.openPath(directory);
    return error
      ? { ok: false, path: directory, message: `Cannot open ${label}: ${error}` }
      : { ok: true, path: directory, message: '' };
  }

  /* --------------------------------------------------------------- handlers */

  ipcMain.handle('app:info', () => session.appInfo(runtime));
  ipcMain.handle('config:get', () => session.configGet());
  ipcMain.handle('config:save', (_event, payload) => session.configSave(payload ?? {}));
  ipcMain.handle('vpn:connect', (_event, options) => session.connect(options ?? {}));
  ipcMain.handle('vpn:disconnect', () => session.disconnect());
  ipcMain.handle('vpn:cancel', () => session.cancel());
  ipcMain.handle('vpn:state', () => session.snapshot());
  ipcMain.handle('vpn:status', () => session.refreshStatus());
  ipcMain.handle('logs:recent', (_event, options) => session.logsRecent(options ?? {}));
  ipcMain.handle('helper:status', () => session.helperStatus());
  ipcMain.handle('helper:install', () => session.helperInstall());
  ipcMain.handle('setup:status', () => session.setupStatus());
  ipcMain.handle('setup:complete', () => session.setupComplete());
  ipcMain.handle('setup:skip', () => session.setupSkip());
  ipcMain.handle('command-line:status', () => session.commandLineStatus());
  ipcMain.handle('command-line:install', () => session.commandLineInstall());
  ipcMain.handle('shell:open-logs', () => openFolder(paths.logsDir, 'the log folder'));
  ipcMain.handle('shell:open-screenshots', () => openFolder(paths.screenshotsDir, 'the screenshot folder'));
  ipcMain.handle('credentials:answer', (_event, payload) => session.answerCredentials(payload?.id, payload ?? {}));
  ipcMain.handle('app:quit', () => {
    quit();
    return { ok: true };
  });

  /* ------------------------------------------------------------------- api */

  function dispose() {
    session.off('state', forwarded.state);
    session.off('log', forwarded.log);
    session.off('progress', forwarded.progress);
    session.off('helper:changed', forwarded.helper);
    session.cancelPendingCredentials('The application is closing');
    for (const channel of HANDLED_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  }

  return {
    broadcast,
    connect: (options) => session.connect(options ?? {}),
    disconnect: () => session.disconnect(),
    cancel: () => session.cancel(),
    refreshStatus: () => session.refreshStatus(),
    snapshot: () => session.snapshot(),
    helperStatus: () => session.helperStatus(),
    openLogs: () => openFolder(paths.logsDir, 'the log folder'),
    openScreenshots: () => openFolder(paths.screenshotsDir, 'the screenshot folder'),
    focus,
    cancelPendingCredentials: (reason) => session.cancelPendingCredentials(reason),
    dispose,
  };
}
