/**
 * VpnSession, the core both front ends share.
 *
 * The controller and the provider are doubles (test/doubles/fake-vpn.mjs and
 * test/doubles/fake-provider.mjs), and every path comes from a temporary home
 * directory, so no tunnel is opened and the real Keychain is never read.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

import { CANCELLED_CODE } from '../src/core/auth.js';
import { getPaths, setConfigLog } from '../src/core/config.js';
import { getProvider } from '../src/core/platform/index.js';
import { VpnSession } from '../src/core/session.js';
import { fakeProvider } from './doubles/fake-provider.mjs';
import { VpnController } from './doubles/fake-vpn.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-session-'));
const configFile = path.join(tmpRoot, '.fortin', 'config.json');
const storeFile = path.join(tmpRoot, 'store.json');
const loginItemFile = path.join(tmpRoot, 'login-item.json');

process.env.HOME = tmpRoot;
process.env.FORTIN_CONFIG = configFile;
process.env.FCVPN_FAKE_STORE_FILE = storeFile;
process.env.FCVPN_FAKE_LOGIN_ITEM_FILE = loginItemFile;
delete process.env.FORTIN_SECRET_STORE;

setConfigLog(() => {});

// The session receives the fake provider, but src/core/secrets.js asks the
// provider of the platform for the store: the same double goes in there.
const provider = getProvider();
const realSecrets = provider.secrets;
provider.secrets = fakeProvider.secrets;

after(() => {
  provider.secrets = realSecrets;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function storeValue(name) {
  return readJson(storeFile)[name];
}

/** A logger double that collects the lines, so no test writes to the console. */
function makeLogger() {
  const lines = [];
  return {
    lines,
    filePath: null,
    log: (...parts) => lines.push(parts.join(' ')),
    error: (...parts) => lines.push(parts.join(' ')),
  };
}

function makeSession(overrides = {}) {
  const config = overrides.config ?? {};
  const controller = overrides.controller ?? new VpnController({ config });
  const session = new VpnSession({
    config,
    provider: fakeProvider,
    paths: getPaths(),
    controller,
    ...overrides,
  });
  return { session, controller, config };
}

beforeEach(() => {
  fs.rmSync(configFile, { force: true });
  fs.rmSync(storeFile, { force: true });
  fs.rmSync(loginItemFile, { force: true });
  fs.rmSync(getPaths().cookieFile, { force: true });
});

test('start moves the plaintext secrets and reads the configuration again', async () => {
  const { session } = makeSession();
  writeJson(configFile, { vpnServer: 'vpn.example.com', password: 'file-pass' });

  const snapshot = await session.start({ poll: false });

  assert.equal(session.config.vpnServer, 'vpn.example.com', 'the configuration was read again');
  assert.equal(storeValue('password'), 'file-pass', 'the password moved to the store');
  assert.equal(Object.hasOwn(readJson(configFile), 'password'), false, 'and left the file');
  assert.equal(snapshot.state, 'disconnected');
  assert.equal(session.snapshot().state, 'disconnected');
});

test('connect with wait resolves the whole attempt and reports the states', async () => {
  const { session } = makeSession();
  const states = [];
  session.on('state', (payload) => states.push(payload.state));

  const result = await session.connect({ wait: true });

  assert.equal(result.accepted, true);
  assert.equal(result.authMethod, 'push', 'the default method of the configuration');
  assert.equal(result.foreground, false);
  assert.deepEqual(states, ['connecting', 'connected']);
  assert.equal(session.getState(), 'connected');
  assert.equal(session.snapshot().state, 'connected');
  assert.equal(session.isBusy(), false);

  const second = makeSession();
  const asked = await second.session.connect({ authMethod: 'totp', foreground: true, wait: true });
  assert.equal(asked.accepted, true);
  assert.equal(asked.authMethod, 'totp');
  assert.equal(asked.foreground, true);
});

test('connect without wait accepts the attempt and never raises', async () => {
  const logger = makeLogger();
  const accepted = await makeSession({ logger }).session.connect();
  assert.equal(accepted.accepted, true);

  // The window does not wait: a failure of the attempt is logged once and the
  // adapter that asked for it never sees an unhandled rejection.
  const failing = makeSession({ logger });
  failing.controller.connect = async () => {
    throw new Error('openfortivpn refused the connection');
  };
  const result = await failing.session.connect();
  assert.equal(result.accepted, true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    logger.lines.some((line) => line.includes('Connect failed: openfortivpn refused the connection')),
    'the failure reaches the log',
  );
});

test('connect refuses an attempt when the tunnel is already up', async () => {
  const { session, controller } = makeSession();
  controller.state = 'connected';

  const result = await session.connect();

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'already-connected');
  assert.equal(controller.connectCalls, 0, 'the controller was never asked');
});

test('configSave keeps the secrets out of the file and follows the login item only for the application', async () => {
  const { session } = makeSession();
  await session.start({ poll: false });

  const result = session.configSave({
    vpnServer: 'vpn.example.com',
    vpnPort: '8443',
    authMethod: 'totp',
    password: 'new-pass',
  });

  assert.equal(result.ok, true);
  assert.equal(result.hasPassword, true);
  assert.equal(result.message, 'Configuration saved');
  const file = readJson(configFile);
  assert.equal(file.vpnServer, 'vpn.example.com');
  assert.equal(file.vpnPort, '8443');
  assert.equal(file.authMethod, 'totp');
  assert.equal(Object.hasOwn(file, 'password'), false, 'the password went to the store');
  assert.equal(storeValue('password'), 'new-pass');
  assert.equal(result.loginItem, undefined, 'a one-shot command never rewrites the system');
  assert.equal(fs.existsSync(loginItemFile), false);

  const owner = makeSession({ syncLoginItem: true, allowLoginItemWrite: true });
  await owner.session.start({ poll: false });

  const on = owner.session.configSave({ startAtLogin: true });
  assert.equal(on.loginItem.enabled, true);
  assert.equal(readJson(loginItemFile).target, process.execPath);

  const off = owner.session.configSave({ startAtLogin: false });
  assert.equal(off.loginItem.enabled, false);
  assert.equal(fs.existsSync(loginItemFile), false);
});

test('the secret operations reach the store of the provider', async () => {
  const { session } = makeSession();
  await session.start({ poll: false });

  const empty = session.secretsStatus();
  assert.equal(empty.ok, true);
  assert.equal(empty.store.available, true);
  assert.equal(empty.store.id, 'fake');
  assert.deepEqual(empty.items.map((item) => item.name), ['password', 'totpSecret', 'svpnCookie']);
  assert.deepEqual(empty.items.map((item) => item.where), ['none', 'none', 'none']);

  const stored = session.secretSet('password', 'new-pass');
  assert.equal(stored.ok, true);
  assert.equal(stored.items.find((item) => item.name === 'password').where, 'store');
  assert.equal(storeValue('password'), 'new-pass');
  assert.equal(session.configGet().hasPassword, true);

  // The session cookie belongs to the store, and the plaintext file of an
  // older version goes away with it.
  const cookieFile = getPaths().cookieFile;
  fs.writeFileSync(cookieFile, 'cookie-value\n', { mode: 0o600 });
  const cookie = session.secretSet('cookie', 'cookie-value');
  assert.equal(cookie.ok, true);
  assert.equal(storeValue('svpnCookie'), 'cookie-value', 'the cookie lives under its own account in the store');
  assert.equal(fs.existsSync(cookieFile), false);

  assert.deepEqual(session.secretSet('nope', 'value'), { ok: false, message: 'Unknown secret: nope' });
  assert.equal(session.secretSet('password', '   ').ok, false);

  const deleted = session.secretDelete('password');
  assert.equal(deleted.ok, true);
  assert.equal(deleted.deleted, true);
  assert.equal(storeValue('password'), undefined);
  assert.equal(session.configGet().hasPassword, false);
});

// The terminal names the cookie 'svpnCookie' (src/cli.js:577) while the session
// looks the name up in SECRET_NAMES, whose key is 'cookie' (src/core/session.js:452),
// so "secrets set cookie" answers "Unknown secret: svpnCookie" and a terminal
// cannot store or delete the cookie at all.
test('the session accepts the name of the cookie the terminal passes', () => {
  const { session } = makeSession();
  assert.equal(session.secretSet('svpnCookie', 'cookie-value').ok, true);
  assert.equal(session.secretDelete('svpnCookie').ok, true);
});

test('logsRecent reads the log file the session points at', async () => {
  const { session } = makeSession();
  await session.start({ poll: false });
  const latest = path.join(getPaths().logsDir, 'latest.log');
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.writeFileSync(latest, 'first line\nsecond line\nthird line\n');

  const recent = session.logsRecent({ lines: 2 });

  assert.equal(recent.ok, true);
  assert.equal(recent.path, fs.realpathSync(latest));
  assert.deepEqual(recent.lines, ['second line', 'third line']);
  assert.equal(recent.total, 3);
  assert.equal(recent.truncated, true);
});

test('requestCredentials fails without a listener and resolves through answerCredentials', async () => {
  const session = makeSession().session;

  await assert.rejects(session.requestCredentials({ kind: 'password' }), /No listener to request credentials/);

  const seen = [];
  session.on('credentials:request', (request) => {
    seen.push(request);
    assert.equal(session.answerCredentials(request.id, { value: 'typed-value' }).ok, true);
  });
  const value = await session.requestCredentials({ kind: 'totp', message: 'Enter the code', attempt: 2, max: 5 });

  assert.equal(value, 'typed-value');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'totp');
  assert.equal(seen[0].message, 'Enter the code');
  assert.equal(seen[0].attempt, 2);
  assert.equal(seen[0].max, 5);
  assert.deepEqual(session.answerCredentials('an-id-nobody-asked-for', { value: 'value' }), {
    ok: false,
    message: 'No pending credential request with that id',
  });

  // Closing the session fails every request in flight.
  const closing = makeSession().session;
  closing.on('credentials:request', () => {});
  const pending = closing.requestCredentials({ kind: 'password' });
  closing.stop();
  await assert.rejects(pending, /The session is closing/);
});

test('a cancelled credential request rejects with the cancellation code', async () => {
  const cancelled = makeSession().session;
  cancelled.on('credentials:request', (request) => cancelled.answerCredentials(request.id, { cancel: true }));
  await assert.rejects(cancelled.requestCredentials({ kind: 'password' }), (error) => error.code === CANCELLED_CODE);

  // An adapter that cannot ask at all reports the error instead.
  const unavailable = makeSession().session;
  unavailable.on('credentials:request', (request) =>
    unavailable.answerCredentials(request.id, { error: 'there is no window to ask' }));
  await assert.rejects(unavailable.requestCredentials({ kind: 'password' }), /there is no window to ask/);
});

test('quit takes the tunnel down only when the session owns the application', () => {
  const application = makeSession({ owner: 'app' });
  assert.deepEqual(application.session.quit(), { ok: true, owner: 'app' });
  assert.equal(application.controller.releaseForQuitCalls, 1);

  const detached = makeSession({ owner: 'detached' });
  assert.deepEqual(detached.session.quit(), { ok: true, owner: 'detached' });
  assert.equal(detached.controller.releaseForQuitCalls, 0, 'a detached tunnel outlives the process');
});
