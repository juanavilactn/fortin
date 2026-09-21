/**
 * A tunnel stopped on purpose is not a tunnel that dropped.
 *
 * The window holds a tunnel and the terminal stops it, which is what
 * "fortin stop" does. Both run the same core, and the process that
 * opened the tunnel only sees its own process exit: without the stop request a
 * deliberate stop reads as an unexpected drop and the window reconnects.
 *
 * These cases run the real controller (src/core/vpn.js) against a provider
 * double, with the sign-in injected and a silent logger. HOME, the
 * configuration file and the secret store live in a temporary directory
 * (FORTIN_SECRET_STORE=file), so nothing here opens a tunnel, reads the
 * Keychain or touches the machine.
 *
 * Every controller of the run shares one simulated machine, like the real one:
 * one tunnel and one pid file. A case resets the world, clears the pid file and
 * the stop request and uses a pid of its own, so a reconnect left in flight by
 * the previous case cannot reach it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, beforeEach } from 'node:test';

import { clearPid, clearStopRequest, readPid, readStopRequest, requestStop } from '../src/core/state.js';
import { VpnController } from '../src/core/vpn.js';

const savedEnv = {
  HOME: process.env.HOME,
  FORTIN_CONFIG: process.env.FORTIN_CONFIG,
  FORTIN_SECRET_STORE: process.env.FORTIN_SECRET_STORE,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-reconnect-'));
process.env.HOME = tmpRoot;
process.env.FORTIN_CONFIG = path.join(tmpRoot, 'config.json');
// The file store keeps the Keychain out of the run: nothing is written or read
// outside the temporary home directory.
process.env.FORTIN_SECRET_STORE = 'file';

const CONFIG = {
  vpnServer: 'vpn.example',
  vpnPort: '443',
  keepAwake: false,
};

/**
 * The machine: one tunnel, shared by the controllers of every case. `pid` is
 * the process the provider says it started, `exits` the exit callbacks it
 * holds, `upOnConnect` decides whether a tunnel comes up at all, `onConnect`
 * runs while the provider starts one (before the caller sees the pid) and
 * `onStop` when the tunnel is taken down.
 */
const world = {
  up: false,
  pid: null,
  exits: [],
  upOnConnect: true,
  onConnect: null,
  onStop: null,
  detached: null,
};

// A pid no live process can have, so isProcessRunning() answers false: the
// controller only reaches the path of a tunnel that died while coming up.
let pidCounter = 2_000_000_000;

/** A pid of this run, different for every case. */
function newPid() {
  pidCounter += 1;
  return pidCounter;
}

function makeProvider() {
  return {
    id: 'stub',
    async helperReady() {
      return true;
    },
    async ensureClient() {
      return { ok: true, version: 'stub', message: '' };
    },
    async connect({ onExit, detached }) {
      world.detached = detached;
      if (world.onConnect) await world.onConnect({ pid: world.pid });
      world.up = world.upOnConnect;
      world.exits.push(onExit);
      return { pid: world.pid };
    },
    async stop() {
      if (world.onStop) world.onStop();
      world.up = false;
      for (const exit of world.exits.splice(0)) exit(0);
      return true;
    },
    async isVpnRunning() {
      return world.up;
    },
    async isTunnelUp() {
      return world.up;
    },
  };
}

/** A logger that says nothing: the cases read states, not log lines. */
const quiet = { log() {}, error() {}, on() {}, off() {} };

const controllers = [];

function build() {
  const controller = new VpnController({
    config: { ...CONFIG },
    logger: quiet,
    provider: makeProvider(),
    // The sign-in with Microsoft is the one step a provider double cannot
    // replace, so the test injects it.
    authenticator: async () => ({ cookie: 'svpn-cookie' }),
  });
  controllers.push(controller);
  return controller;
}

/** Waits for the controller to reach a state, up to the deadline. */
async function waitForState(controller, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (controller.getState() === state) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return controller.getState() === state;
}

beforeEach(() => {
  // The machine of the previous case is put back to rest: no tunnel, no exit
  // callbacks, no pid file and no request for a stop.
  world.up = false;
  world.exits.length = 0;
  world.upOnConnect = true;
  world.onConnect = null;
  world.onStop = null;
  world.detached = null;
  world.pid = null;
  clearPid();
  clearStopRequest();
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  // A case that fails leaves a reconnect in flight, and a tunnel that comes
  // back up feeds it again. With the world dead the pending attempt ends on its
  // own instead of keeping the process alive, so a regression fails the run
  // instead of hanging it. Every case brings the world back.
  world.up = false;
  world.exits.length = 0;
  world.upOnConnect = false;
  world.pid = null;
  clearPid();
  clearStopRequest();
});

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a tunnel that drops on its own starts a reconnect', async () => {
  world.pid = newPid();
  const controller = build();
  await controller.connect({ wait: true });
  assert.equal(controller.getState(), 'connected');

  // The tunnel goes away with no request behind it: the exit is a drop.
  world.up = false;
  for (const exit of world.exits.splice(0)) exit(1);

  assert.equal(controller.getState(), 'connecting');
  assert.equal(controller.getStateInfo().message, 'The tunnel dropped, reconnecting');

  // The reconnect is waiting its five seconds: disconnect() flips the intent,
  // so the loop leaves the tunnel alone instead of bringing it back here.
  assert.equal(await controller.disconnect(), true);
});

test('the terminal stops the tunnel the window holds', async () => {
  world.pid = newPid();
  const window = build();
  await window.connect({ wait: true });
  assert.equal(readPid(), world.pid, 'the pid file names the tunnel of the window');

  // The terminal is another controller over the same machine, exactly what
  // src/cli.js builds before it calls disconnect().
  const terminal = build();
  await terminal.refreshStatus();
  assert.equal(terminal.getState(), 'connected', 'the terminal sees the tunnel of the window');

  assert.equal(await terminal.disconnect(), true);

  assert.equal(window.getState(), 'disconnected', 'the window does not reconnect');
  assert.equal(window.getStateInfo().message, 'The tunnel was closed on request');
  assert.equal(window.isHolding(), false, 'and it does not hold the tunnel any more');
  assert.equal(readStopRequest(), null, 'the request is used up');
  assert.equal(readPid(), null, 'the pid file is gone');
});

test('the health check sees the same stop', async () => {
  world.pid = newPid();
  const controller = build();
  await controller.connect({ wait: true });

  // The other process wrote the request and the tunnel is gone, but this
  // controller got no exit callback: the health check is the one that notices.
  requestStop({ pid: world.pid, reason: 'stop' });
  world.up = false;
  await controller.handleResume();

  assert.equal(controller.getState(), 'disconnected');
  assert.equal(controller.getStateInfo().message, 'The tunnel was closed on request');
  assert.equal(controller.isHolding(), false);
  assert.equal(readStopRequest(), null);
  assert.equal(readPid(), null);
});

test('the window stops a tunnel a foreground terminal holds', async () => {
  world.pid = newPid();
  const terminal = build();
  await terminal.connect({ wait: true, foreground: true });
  assert.equal(world.detached, false, 'the terminal holds the tunnel in the foreground');

  const window = build();
  await window.refreshStatus();
  assert.equal(await window.disconnect(), true);

  assert.equal(terminal.getState(), 'disconnected');
  assert.equal(terminal.getStateInfo().message, 'The tunnel was closed on request');
  assert.equal(terminal.isHolding(), false);
  assert.equal(readStopRequest(), null);
});

test('a request that names another tunnel does not silence a real drop', async () => {
  world.pid = newPid();
  const controller = build();
  await controller.connect({ wait: true });

  const otherTunnel = newPid();
  requestStop({ pid: otherTunnel, reason: 'stop' });
  world.up = false;
  for (const exit of world.exits.splice(0)) exit(1);

  assert.equal(controller.getState(), 'connecting', 'the drop still reconnects');
  assert.equal(controller.getStateInfo().message, 'The tunnel dropped, reconnecting');
  assert.equal(readStopRequest()?.pid, otherTunnel, 'the request of the other tunnel is not consumed');

  assert.equal(await controller.disconnect(), true);
});

test('a tunnel stopped while it comes up ends as a request, not as a failure', async () => {
  world.pid = newPid();
  // The tunnel never comes up and its process is already gone: the exit of the
  // attempt that the controller would report as "exited before the tunnel came
  // up". The request says another process asked for it.
  world.upOnConnect = false;
  world.onConnect = ({ pid }) => requestStop({ pid, reason: 'stop' });

  const controller = build();
  await assert.rejects(controller.connect({ wait: true }), /The tunnel was closed on request/);

  assert.equal(controller.getState(), 'disconnected', 'not the error state of a failed attempt');
  assert.equal(controller.getStateInfo().message, 'The tunnel was closed on request');
  assert.equal(readStopRequest(), null);
  assert.equal(readPid(), null);
});

test('disconnect writes the request for the tunnel of the pid file before stopping it', async () => {
  world.pid = newPid();
  const controller = build();
  await controller.connect({ wait: true });

  // The tunnel is read at the moment it is taken down: a null there would mean
  // the request was written too late to be seen by the process that owns it.
  let requestWhenStopped = null;
  world.onStop = () => {
    requestWhenStopped = readStopRequest();
  };

  assert.equal(await controller.disconnect(), true);

  assert.equal(requestWhenStopped?.pid, world.pid, 'the request names the tunnel in the pid file');
  assert.equal(requestWhenStopped?.reason, 'stop');
  assert.ok(requestWhenStopped.at > 0, 'the request is stamped');
  assert.deepEqual(readStopRequest(), requestWhenStopped, 'the request survives the disconnect');
});

test('a new attempt starts with no request behind it', async () => {
  world.pid = newPid();
  requestStop({ pid: newPid(), reason: 'stop' });
  assert.notEqual(readStopRequest(), null);

  const controller = build();
  await controller.connect({ wait: true });

  assert.equal(controller.getState(), 'connected');
  assert.equal(readStopRequest(), null, 'the request of the old tunnel does not reach this one');
  assert.equal(controller.isHolding(), true);
});

// The slow one: the backoff of the first reconnect attempt is five seconds.
test('a real drop is still recovered', { timeout: 30000 }, async () => {
  world.pid = newPid();
  const controller = build();
  await controller.connect({ wait: true });

  world.up = false;
  for (const exit of world.exits.splice(0)) exit(1);
  assert.equal(controller.getState(), 'connecting');

  assert.equal(await waitForState(controller, 'connected', 20000), true, 'the tunnel comes back on its own');
  assert.equal(controller.isHolding(), true);
  assert.equal(readPid(), world.pid);
});
