/**
 * System tray icon.
 *
 * A single left click toggles the tunnel (connect when idle, disconnect when
 * connected) and does nothing while the controller is busy, so a click can
 * never queue a second operation. The icon, the tooltip and the menu follow
 * the VPN state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Menu, Tray, nativeImage, screen } from 'electron';

const STATE_META = {
  disconnected: { label: 'Disconnected', file: 'tray-disconnected' },
  connecting: { label: 'Connecting', file: 'tray-connecting' },
  connected: { label: 'Connected', file: 'tray-connected' },
  disconnecting: { label: 'Disconnecting', file: 'tray-connecting' },
  error: { label: 'Error', file: 'tray-error' },
};

const BUSY_STATES = new Set(['connecting', 'disconnecting']);
const APP_LABEL = 'Fortin';

/**
 * @param {object} options
 * @param {string} options.assetsDir   directory holding the generated PNGs
 * @param {() => unknown} options.onToggle   one-click connect/disconnect
 * @param {() => void} options.onShow        show the window
 * @param {() => void} options.onSettings    show the window on the settings section
 * @param {() => void} options.onSetup       show the window on the initial setup
 * @param {() => void} options.onOpenLogs    open the log folder
 * @param {() => void} options.onQuit        quit the application
 */
export function createTray(options) {
  const { assetsDir, onToggle, onShow, onSettings, onSetup, onOpenLogs, onQuit } = options;
  const images = new Map();
  let current = { state: 'disconnected', message: '', since: Date.now(), pid: null };

  function iconFor(file) {
    if (images.has(file)) return images.get(file);

    const target = trayIconPath(assetsDir, file);
    if (!fs.existsSync(target)) {
      throw new Error(`Tray icon not found: ${target}. Run "npm run icons".`);
    }

    const image = nativeImage.createFromPath(target);
    if (image.isEmpty()) throw new Error(`Tray icon cannot be loaded: ${target}`);
    // The glyph is coloured on purpose, so it must not be tinted as a template image.
    image.setTemplateImage(false);

    images.set(file, image);
    return image;
  }

  function isBusy() {
    return BUSY_STATES.has(current.state);
  }

  function isConnected() {
    return current.state === 'connected';
  }

  function menuTemplate() {
    const meta = STATE_META[current.state] ?? STATE_META.disconnected;
    const detail = current.message ? ` (${current.message})` : '';
    const items = [
      { label: `Status: ${meta.label}${detail}`, enabled: false },
      { type: 'separator' },
      {
        label: isConnected() ? 'Disconnect' : 'Connect',
        enabled: !isBusy(),
        click: () => toggle(),
      },
      { type: 'separator' },
      { label: 'Show window', click: () => onShow() },
      { label: 'Settings', click: () => onSettings() },
      { label: 'Run setup', click: () => onSetup?.() },
      { label: 'Open logs', click: () => onOpenLogs() },
      { type: 'separator' },
      { label: 'Quit', click: () => onQuit() },
    ];
    return items;
  }

  function buildMenu() {
    return Menu.buildFromTemplate(menuTemplate());
  }

  function toggle() {
    // Disabled while connecting or disconnecting: one click, one operation.
    if (isBusy()) return;
    try {
      const result = onToggle();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // The controller reports failures through its own state and log events.
    }
  }

  const startFile = STATE_META.disconnected.file;
  const tray = new Tray(iconFor(startFile));

  function setTooltip() {
    const meta = STATE_META[current.state] ?? STATE_META.disconnected;
    const detail = current.message ? ` - ${truncate(current.message, 80)}` : '';
    tray.setToolTip(`${APP_LABEL} - ${meta.label}${detail}`);
  }

  function update(payload = {}) {
    current = {
      state: payload.state ?? 'disconnected',
      message: payload.message ?? '',
      since: payload.since ?? Date.now(),
      pid: payload.pid ?? null,
    };

    const meta = STATE_META[current.state] ?? STATE_META.disconnected;
    tray.setImage(iconFor(meta.file));
    setTooltip();

    if (process.platform !== 'darwin') tray.setContextMenu(buildMenu());
    return current;
  }

  tray.on('click', () => toggle());

  if (process.platform === 'darwin') {
    // Setting a context menu on macOS would make every left click open the menu,
    // so the menu is popped up on demand from the right button instead.
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  } else {
    tray.setContextMenu(buildMenu());
  }

  setTooltip();

  function destroy() {
    try {
      tray.destroy();
    } catch {
      // Already destroyed.
    }
  }

  return {
    tray,
    update,
    destroy,
    getState: () => ({ ...current }),
    rebuildMenu: () => {
      if (process.platform !== 'darwin') tray.setContextMenu(buildMenu());
    },
  };
}

/** Base file name, or the DPI specific file where the platform needs one. */
function trayIconPath(assetsDir, file) {
  if (process.platform === 'darwin') {
    // Electron resolves tray-<state>@2x.png and @3x.png next to the base file.
    return path.join(assetsDir, `${file}.png`);
  }
  const scale = screen?.getPrimaryDisplay?.()?.scaleFactor ?? 1;
  const size = scale >= 2.5 ? 64 : scale >= 1.5 ? 32 : 16;
  return path.join(assetsDir, `${file}-${size}.png`);
}

function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
