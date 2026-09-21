/**
 * Electron main process.
 *
 * Owns the application lifecycle, the single browser window and the tray, and
 * builds the session the window and the CLI share (src/core/session.js). What is
 * left here is the part that only a desktop application has: the window, the
 * tray, the power monitor events and the notification of a login start.
 *
 * Closing the window hides it: the application keeps running in the tray on
 * every platform and only `Quit` (tray menu or the `app:quit` channel) stops it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, powerMonitor, shell } from 'electron';

import { getPaths, loadConfig } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { STARTED_AT_LOGIN_FLAG, wasStartedAtLogin } from '../core/login-item.js';
import { getProvider } from '../core/platform/index.js';
import { VpnSession } from '../core/session.js';
import { registerIpc } from './ipc.js';
import { createTray } from './tray.js';

const DIR_NAME = import.meta.dirname;
const ASSETS_DIR = path.resolve(DIR_NAME, '..', '..', 'assets');
const RENDERER_INDEX = path.join(DIR_NAME, '..', 'renderer', 'index.html');
const APP_USER_MODEL_ID = 'com.juanavilactn.fortin';

/** How long the window waits for an answer to the credentials modal. */
const CREDENTIALS_TIMEOUT_MS = 5 * 60 * 1000;

let mainWindow = null;
let tray = null;
let api = null;
let services = null;
let isQuitting = false;

/* ------------------------------------------------------------------ services */

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
}

function startServices() {
  const paths = getPaths();
  const logger = new Logger({ logDir: paths.logsDir });
  const config = loadConfig();
  const provider = getProvider();
  const session = new VpnSession({
    config,
    logger,
    provider,
    paths,
    // The tunnel belongs to the application: quitting takes it down.
    owner: 'app',
    credentialsTimeoutMs: CREDENTIALS_TIMEOUT_MS,
    // A development run (electron .) is not the installed application, so it
    // registers no login item; the packaged application does.
    allowLoginItemWrite: app.isPackaged === true,
    // The system follows the stored startAtLogin, at startup and after a save.
    syncLoginItem: true,
  });
  return { paths, logger, config, provider, session };
}

/**
 * Until the session moved to the core, the login item was registered through
 * Electron, and the system keeps that entry on its own: no file to remove. The
 * packaged application drops it once, so a machine that had the setting on does
 * not start the application twice.
 */
function dropLegacyLoginItem() {
  if (process.platform !== 'darwin') return;
  if (app.isPackaged !== true) return;
  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch (error) {
    services?.logger?.error(`The previous login item could not be removed: ${error?.message ?? error}`);
  }
}

/* -------------------------------------------------------------------- window */

/**
 * The window is created hidden on purpose and shown on ready-to-show. A start
 * triggered by the login item passes `show: false`: the application stays in the
 * tray without a window until someone asks for it.
 */
function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Fortin',
    icon: process.platform === 'darwin' ? undefined : path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: {
      preload: path.join(DIR_NAME, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (show) mainWindow?.show();
  });

  // Closing the window keeps the application alive in the tray.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    services?.logger.error(`Cannot load ${url}: ${description} (${code})`);
  });

  mainWindow.loadFile(RENDERER_INDEX).catch((error) => {
    services?.logger.error(`Cannot open the window: ${error?.message ?? error}`);
  });

  return mainWindow;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quit() {
  isQuitting = true;
  app.quit();
}

/* --------------------------------------------------------------------- tray */

/** Tray click: connect when idle, disconnect when connected, one operation. */
function toggleFromTray() {
  if (!api || !services) return { accepted: false, reason: 'not-ready' };
  const state = services.session.getState();
  if (state === 'connected') return api.disconnect();
  if (state === 'disconnected' || state === 'error') {
    return api.connect({ authMethod: services.config.authMethod });
  }
  return { accepted: false, reason: state };
}

function startTray() {
  const icon = path.join(ASSETS_DIR, 'tray-disconnected.png');
  if (!fs.existsSync(icon)) {
    services.logger.error(`Tray icons are missing (${icon}). Run "npm run icons" to generate them.`);
    return;
  }

  try {
    tray = createTray({
      assetsDir: ASSETS_DIR,
      onToggle: () => toggleFromTray(),
      onShow: () => showWindow(),
      onSettings: () => {
        showWindow();
        api?.focus('settings');
      },
      // The assistant is repeatable by hand: the menu opens the window on it,
      // and it changes no state until the user walks through it again.
      onSetup: () => {
        showWindow();
        api?.focus('setup');
      },
      onOpenLogs: () => api?.openLogs(),
      onQuit: () => quit(),
    });
    tray.update(api.snapshot());
  } catch (error) {
    tray = null;
    services.logger.error(`Cannot create the tray icon: ${error?.message ?? error}`);
  }
}

/* ------------------------------------------------------------------- startup */

async function bootstrap() {
  services = startServices();
  const { paths, logger, session } = services;

  // Move the plaintext secrets of an older version, read the configuration
  // again, make the system match the stored login item and start the periodic
  // status check, in that order.
  await session.start();
  dropLegacyLoginItem();

  api = registerIpc({
    session,
    paths,
    getWindow: () => mainWindow,
    quit,
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      isPackaged: app.isPackaged,
    },
  });

  createWindow({ show: !wasStartedAtLogin() });

  // Sleep kills the link, and a dead link with a live process is invisible to a
  // process check alone, so ask the controller to verify as soon as the machine
  // is usable again.
  powerMonitor.on('suspend', () => {
    session.handleSuspend();
  });
  powerMonitor.on('resume', () => {
    session.handleResume().catch(() => {});
  });
  powerMonitor.on('unlock-screen', () => {
    session.handleResume().catch(() => {});
  });

  session.on('state', (payload) => {
    tray?.update(payload);
  });

  startTray();

  logger.log(`${app.getName()} ${app.getVersion()} ready on ${process.platform}`);
}

/* ------------------------------------------------------------------ lifecycle */

function shutdown() {
  // The owner policy of the session decides what happens to the tunnel.
  services?.session?.quit?.();
  tray?.destroy();
  tray = null;
  api?.dispose();
  api = null;
  services?.logger?.dispose?.();
  services = null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // A login start that finds the application already running stays quiet.
    if (Array.isArray(argv) && argv.includes(STARTED_AT_LOGIN_FLAG)) return;
    showWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('activate', () => showWindow());

  // Never quit here: the application lives in the tray until an explicit quit.
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });

  app.on('will-quit', () => shutdown());

  process.on('uncaughtException', (error) => {
    services?.logger?.error(`Unhandled error: ${error?.stack ?? error?.message ?? error}`);
  });
  process.on('unhandledRejection', (reason) => {
    services?.logger?.error(`Unhandled rejection: ${reason?.message ?? reason}`);
  });

  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

  app
    .whenReady()
    .then(async () => {
      await bootstrap();
    })
    .catch((error) => {
      services?.logger?.error(`Startup failed: ${error?.stack ?? error?.message ?? error}`);
      isQuitting = true;
      app.quit();
    });
}
