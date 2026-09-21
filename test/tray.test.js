/**
 * The tray menu and the ui:focus hint: the two parts of the Electron shell that
 * only exist when a tray and a window do.
 *
 * src/main/tray.js builds the menu of the icon (at the right click on macOS, as
 * the context menu of the tray on the other platforms) and src/main/ipc.js
 * carries the hint the tray uses to open a section of the window.
 *
 * No Electron process, window or tray is started. The 'electron' specifier is
 * mapped to test/doubles/fake-electron.mjs with registerHooks(), before the two
 * modules are imported, and the session and the window are small doubles of this
 * file. The tray icons are the real PNGs of assets/.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { trays } from './doubles/fake-electron.mjs';

const ASSETS_DIR = path.resolve(import.meta.dirname, '..', 'assets');
const FAKE_ELECTRON = path.join(import.meta.dirname, 'doubles', 'fake-electron.mjs');

// tray.js and ipc.js import 'electron', which plain node cannot load. The double
// takes its place for this process only, and a process per file is what keeps
// the replacement inside this test (node --test runs every file on its own).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: pathToFileURL(FAKE_ELECTRON).href, shortCircuit: true, format: 'module' };
    }
    return nextResolve(specifier, context);
  },
});

const { createTray } = await import('../src/main/tray.js');
const { registerIpc } = await import('../src/main/ipc.js');

/** The items of the menu, in order, separators included as the template names them. */
const MENU_SHAPE = [
  'Status: Disconnected',
  'separator',
  'Connect',
  'separator',
  'Show window',
  'Settings',
  'Run setup',
  'Open logs',
  'separator',
  'Quit',
];

/* --------------------------------------------------------------- the menu --- */

/** A tray of a case, with a counter for every callback it was given. */
function makeTray(overrides = {}) {
  const calls = { toggle: 0, show: 0, settings: 0, setup: 0, logs: 0, quit: 0 };
  const tray = createTray({
    assetsDir: ASSETS_DIR,
    onToggle: () => {
      calls.toggle += 1;
    },
    onShow: () => {
      calls.show += 1;
    },
    onSettings: () => {
      calls.settings += 1;
    },
    onSetup: () => {
      calls.setup += 1;
    },
    onOpenLogs: () => {
      calls.logs += 1;
    },
    onQuit: () => {
      calls.quit += 1;
    },
    ...overrides,
  });
  return { tray, calls, double: trays.at(-1) };
}

/** Runs the body while process.platform answers another value, then puts it back. */
function withPlatform(platform, body) {
  const answer = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, 'platform', answer);
  }
}

/** The menu of a macOS tray: the module builds it when the right button asks. */
function menuFromRightClick(double) {
  double.emit('right-click');
  return double.poppedMenus.at(-1);
}

/** The context menu the tray is carrying, on every platform that sets one. */
function lastContextMenu(double) {
  return double.contextMenus.at(-1);
}

/** The menu the tray offers now, by whichever route the platform builds it. */
function currentMenu(double) {
  if (process.platform === 'darwin') return menuFromRightClick(double);
  return lastContextMenu(double);
}

/** The labels of a menu, in order, with a separator standing in for its line. */
function shapeOf(menu) {
  return menu.items.map((item) => (item.type === 'separator' ? 'separator' : item.label));
}

/** The items that carry a label, by label. A separator carries none. */
function itemsByLabel(menu) {
  const items = new Map();
  for (const item of menu.items) {
    if (item.label) items.set(item.label, item);
  }
  return items;
}

function clickItem(menu, label) {
  const item = itemsByLabel(menu).get(label);
  assert.ok(item, `the menu has no "${label}" item`);
  item.click();
}

/* ------------------------------------------------- the window and the session */

/** The window surface registerIpc uses: the liveness checks, send and the load event. */
function fakeWindow({ destroyed = false, webContentsDestroyed = false, loading = false } = {}) {
  const sends = [];
  const listeners = [];
  let isLoading = loading;
  const window = {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => webContentsDestroyed,
      isLoading: () => isLoading,
      send(channel, payload) {
        sends.push({ channel, payload });
      },
      once(event, listener) {
        listeners.push({ event, listener });
      },
    },
  };

  return {
    window,
    sends,
    listeners,
    /** The renderer of the window finished loading. */
    finishLoad() {
      isLoading = false;
      for (const entry of listeners.splice(0)) {
        if (entry.event === 'did-finish-load') entry.listener();
      }
    },
  };
}

/** registerIpc over the doubles of this file: no Electron, no window, no session. */
function makeIpc(window) {
  const session = new EventEmitter();
  // The module reaches these two through the credentials event and dispose().
  session.answerCredentials = () => {};
  session.cancelPendingCredentials = () => {};

  return registerIpc({
    session,
    paths: {
      logsDir: path.join(os.tmpdir(), 'fcvpn-tray-logs'),
      screenshotsDir: path.join(os.tmpdir(), 'fcvpn-tray-screenshots'),
    },
    getWindow: () => window,
    quit: () => {},
    runtime: {},
  });
}

/* ---------------------------------------------------------- the tray menu --- */

test('the macOS tray builds its menu when the right button asks for it', () => {
  const { double } = withPlatform('darwin', () => makeTray());

  assert.deepEqual(double.contextMenus, [], 'a context menu would make every left click open the menu');
  assert.deepEqual(double.poppedMenus, [], 'and nothing is built before someone asks for it');

  assert.deepEqual(shapeOf(menuFromRightClick(double)), MENU_SHAPE);
  assert.equal(double.poppedMenus.length, 1, 'the right click pops one menu');
});

test('the tray of the other platforms carries that menu as its context menu', () => {
  const { tray, double } = withPlatform('linux', () => makeTray());

  assert.deepEqual(shapeOf(lastContextMenu(double)), MENU_SHAPE, 'the menu is set when the tray is created');
  assert.deepEqual(double.poppedMenus, []);

  const before = double.contextMenus.length;
  withPlatform('linux', () => tray.rebuildMenu());
  assert.equal(double.contextMenus.length, before + 1, 'a rebuild hands the tray a fresh menu');
});

test('Run setup calls onSetup once and the other items call the callback they name', () => {
  const { calls, double } = makeTray();

  clickItem(currentMenu(double), 'Run setup');
  assert.equal(calls.setup, 1, 'one click opens the assistant once');
  assert.deepEqual(calls, { toggle: 0, show: 0, settings: 0, setup: 1, logs: 0, quit: 0 });

  clickItem(currentMenu(double), 'Show window');
  clickItem(currentMenu(double), 'Settings');
  clickItem(currentMenu(double), 'Open logs');
  clickItem(currentMenu(double), 'Connect');
  clickItem(currentMenu(double), 'Quit');

  assert.deepEqual(calls, { toggle: 1, show: 1, settings: 1, setup: 1, logs: 1, quit: 1 });
});

test('a tray built without onSetup does not throw when Run setup is clicked', () => {
  const { double } = makeTray({ onSetup: undefined });
  const menu = currentMenu(double);

  assert.equal(itemsByLabel(menu).has('Run setup'), true, 'the item is part of the menu whatever the caller passes');
  assert.doesNotThrow(() => clickItem(menu, 'Run setup'));
});

test('the menu follows the state and disables the action while the tunnel is busy', () => {
  const { tray, double } = makeTray();

  const idle = itemsByLabel(currentMenu(double));
  assert.equal(idle.get('Status: Disconnected').enabled, false, 'the status line is a label, not a command');
  assert.equal(idle.get('Connect').enabled, true, 'an idle tunnel can be connected from the menu');

  tray.update({ state: 'connecting' });
  const connecting = itemsByLabel(currentMenu(double));
  assert.equal(connecting.get('Status: Connecting').enabled, false);
  assert.equal(connecting.get('Connect').enabled, false, 'one click, one operation');

  tray.update({ state: 'disconnecting' });
  const disconnecting = itemsByLabel(currentMenu(double));
  assert.equal(disconnecting.get('Status: Disconnecting').enabled, false);
  assert.equal(disconnecting.get('Connect').enabled, false, 'still busy, still disabled');

  tray.update({ state: 'connected' });
  const connected = itemsByLabel(currentMenu(double));
  assert.equal(connected.get('Status: Connected').enabled, false);
  assert.equal(connected.has('Connect'), false, 'a connected tunnel offers Disconnect instead');
  assert.equal(connected.get('Disconnect').enabled, true);
});

test('the tray icon is the PNG of the state and never a template image', () => {
  const { tray, double } = makeTray();

  assert.match(path.basename(double.image.path), /^tray-disconnected(-\d+)?\.png$/);
  assert.equal(fs.existsSync(double.image.path), true, 'the icon is a real file of the checkout');
  assert.equal(double.image.templateImage, false, 'the coloured glyph must not be tinted by macOS');
  assert.equal(double.tooltip, 'Fortin - Disconnected');

  tray.update({ state: 'error', message: 'the tunnel is down' });
  assert.match(path.basename(double.image.path), /^tray-error(-\d+)?\.png$/);
  assert.equal(double.tooltip, 'Fortin - Error - the tunnel is down');
});

/* --------------------------------------------------------- the focus hint --- */

test('focus sends the section on ui:focus to a window that is there', () => {
  const { window, sends } = fakeWindow();
  const api = makeIpc(window);

  assert.equal(api.focus('setup'), true);
  assert.deepEqual(
    sends,
    [{ channel: 'ui:focus', payload: { section: 'setup' } }],
    'this hint is what the tray uses to open the assistant',
  );
});

test('focus keeps taking any other section and answers window when there is none', () => {
  const { window, sends } = fakeWindow();
  const api = makeIpc(window);

  assert.equal(api.focus('settings'), true);
  assert.equal(api.focus(), true);
  assert.equal(api.focus(null), true);
  assert.deepEqual(
    sends.map((entry) => entry.payload.section),
    ['settings', 'window', 'window'],
    'no section is the default this call always had',
  );
  assert.ok(sends.every((entry) => entry.channel === 'ui:focus'));
});

// A webContents that is still loading has not subscribed to ui:focus yet, and a
// message sent before that is dropped, so the hint waits for the load. This is
// the window the tray opens on a machine that had none: without the wait, the
// section the tray asked for would be lost.
test('a window that is still loading receives the hint when the load finishes', () => {
  const { window, sends, listeners, finishLoad } = fakeWindow({ loading: true });
  const api = makeIpc(window);

  assert.equal(api.focus('setup'), true);
  assert.deepEqual(sends, [], 'nothing is sent before the renderer is listening');
  assert.deepEqual(
    listeners.map((entry) => entry.event),
    ['did-finish-load'],
    'the hint waits for the load',
  );

  finishLoad();
  assert.deepEqual(
    sends,
    [{ channel: 'ui:focus', payload: { section: 'setup' } }],
    'the hint leaves once the load is done',
  );
  assert.deepEqual(listeners, [], 'the listener is used once');
});

test('focus answers false and sends nothing when the window is missing or gone', () => {
  const noWindow = makeIpc(null);
  assert.equal(noWindow.focus('setup'), false, 'no window at all');

  const windowGone = fakeWindow({ destroyed: true });
  assert.equal(makeIpc(windowGone.window).focus('setup'), false, 'the window is destroyed');

  const rendererGone = fakeWindow({ webContentsDestroyed: true });
  assert.equal(makeIpc(rendererGone.window).focus('setup'), false, 'the renderer is destroyed');

  assert.deepEqual(windowGone.sends, [], 'nothing is sent to a window that is gone');
  assert.deepEqual(windowGone.listeners, [], 'and no listener waits on it');
  assert.deepEqual(rendererGone.sends, []);
  assert.deepEqual(rendererGone.listeners, []);
});
