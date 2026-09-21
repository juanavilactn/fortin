/**
 * The initial setup of a machine, and the command line that reads it.
 *
 * src/core/setup.js owns the decision (when the assistant is due and why) and the
 * flags that remember the answer. VpnSession carries both to the window and to
 * the terminal, and src/cli.js answers setup status, complete, skip and reset.
 *
 * The cases of setupDecision() and setupPatch() run with every input given. The
 * cases over a session use the controller and the provider doubles of
 * test/doubles/, and the cases over the terminal start src/cli.js as a child
 * process with the module hook of test/doubles/ (FCVPN_FAKE_PROVIDER=1). Every
 * path comes from a temporary directory: nothing here reads or writes the real
 * configuration file, the real ~/.fortin, the Keychain, the privileged
 * helper, launchctl or a tunnel.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

import { CLI_COMMANDS } from '../src/cli.js';
import { getPaths, setConfigLog } from '../src/core/config.js';
import { getProvider } from '../src/core/platform/index.js';
import { VpnSession } from '../src/core/session.js';
import {
  SETUP_KEYS,
  SETUP_STEPS,
  SETUP_VERSION,
  readSetupFlags,
  setupDecision,
  setupPatch,
} from '../src/core/setup.js';
import { fakeProvider } from './doubles/fake-provider.mjs';
import { VpnController } from './doubles/fake-vpn.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(REPO_ROOT, 'test', 'doubles', 'hook.mjs');
const CLI = path.join(REPO_ROOT, 'src', 'cli.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-setup-'));
const configFile = path.join(tmpRoot, '.fortin', 'config.json');
const storeFile = path.join(tmpRoot, 'store.json');
const loginItemFile = path.join(tmpRoot, 'login-item.json');

/** The shape of every instant the assistant writes. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The flags of a machine whose user never answered the assistant. */
const NO_ANSWER_FLAGS = { completed: false, skipped: false, version: 0, decidedAt: '', decided: false };

/** The flags of a machine whose user walked through this version. */
const ANSWERED_FLAGS = {
  completed: true,
  skipped: false,
  version: SETUP_VERSION,
  decidedAt: '2026-01-02T03:04:05.000Z',
  decided: true,
};

/** Variables of the machine that would change the answer of a case. */
const VARIABLES_TO_DROP = [
  'FORTIN_SECRET_STORE',
  'FORTIN_LAUNCHER',
  'XDG_CONFIG_HOME',
  'VPN_SERVER',
  'VPN_PORT',
  'VPN_REALM',
  'VPN_USERNAME',
  'VPN_PASSWORD',
  'VPN_TOTP_SECRET',
  'VPN_AUTH_METHOD',
  'VPN_HEADLESS',
  'VPN_TRUSTED_CERT',
  'VPN_START_AT_LOGIN',
  'VPN_DEBUG_SCREENSHOTS',
  'VPN_KEEP_AWAKE',
  'VPN_AUTO_RECONNECT',
  'CHROME_PATH',
];

process.env.HOME = tmpRoot;
process.env.FORTIN_CONFIG = configFile;
process.env.FCVPN_FAKE_STORE_FILE = storeFile;
process.env.FCVPN_FAKE_LOGIN_ITEM_FILE = loginItemFile;
delete process.env.FORTIN_SECRET_STORE;
for (const name of VARIABLES_TO_DROP) delete process.env[name];

// The line that names the file just read belongs to the terminal, not to a test.
setConfigLog(() => {});

// src/core/config.js and src/core/secrets.js ask the provider of the running
// platform for the store, so the double goes in there too: the store of this
// test is a file of the temporary root, never the Keychain.
const provider = getProvider();
const realSecrets = provider.secrets;
provider.secrets = fakeProvider.secrets;

/** Roots of the child processes, removed when the file is done. */
const sandboxes = [];

after(() => {
  provider.secrets = realSecrets;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(configFile, { force: true });
  fs.rmSync(storeFile, { force: true });
  fs.rmSync(loginItemFile, { force: true });
  fs.rmSync(getPaths().cookieFile, { force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** The setup keys of a configuration file, and only those. */
function setupKeysOf(file) {
  const found = {};
  for (const key of SETUP_KEYS) {
    if (Object.hasOwn(file, key)) found[key] = file[key];
  }
  return found;
}

/** The same file without the keys of the assistant: what it must never touch. */
function withoutSetupKeys(file) {
  const rest = { ...file };
  for (const key of SETUP_KEYS) delete rest[key];
  return rest;
}

/** A session over the doubles: no tunnel, no Keychain, no real configuration. */
function makeSession(overrides = {}) {
  const config = overrides.config ?? {};
  return new VpnSession({
    config,
    provider: overrides.provider ?? fakeProvider,
    paths: getPaths(),
    controller: overrides.controller ?? new VpnController({ config }),
  });
}

/** A home directory and the files of the doubles, all of them temporary. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-setup-cli-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  sandboxes.push(root);
  return {
    root,
    home,
    configFile: path.join(root, 'config.json'),
    storeFile: path.join(root, 'store.json'),
    loginItemFile: path.join(root, 'login-item.json'),
    dumpFile: path.join(root, 'dump.json'),
  };
}

function runCli(box, args) {
  const env = { ...process.env };
  for (const name of VARIABLES_TO_DROP) delete env[name];

  // The doubles are the last word on the environment: without
  // FCVPN_FAKE_PROVIDER the hook is inert and the child would reach the real
  // provider, which means the real Keychain and the real tunnel.
  Object.assign(env, {
    HOME: box.home,
    FORTIN_CONFIG: box.configFile,
    FCVPN_FAKE_PROVIDER: '1',
    FCVPN_FAKE_STORE_FILE: box.storeFile,
    FCVPN_FAKE_LOGIN_ITEM_FILE: box.loginItemFile,
    FCVPN_FAKE_DUMP: box.dumpFile,
  });
  assert.equal(env.FCVPN_FAKE_PROVIDER, '1', 'the child has to run against the doubles');

  return spawnSync(process.execPath, ['--import', HOOK, CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

/** The document of a command that worked: exit code 0 and JSON on the standard output. */
function jsonOf(result) {
  assert.equal(result.error, undefined, `the child could not run: ${result.error?.message}`);
  assert.equal(result.status, 0, `exit code ${result.status}, stderr: ${result.stderr}`);
  const document = JSON.parse(result.stdout);
  assert.equal(document.ok, true, result.stdout);
  assert.deepEqual(Object.keys(document).sort(), ['command', 'ok', 'result']);
  return document;
}

/* ---------------------------------------------------------- the contract ---- */

test('the assistant names one version, four keys and eight steps', () => {
  assert.equal(SETUP_VERSION, 1);
  assert.deepEqual([...SETUP_KEYS], ['setupCompleted', 'setupSkipped', 'setupVersion', 'setupDecidedAt']);
  assert.deepEqual(
    SETUP_STEPS.map((step) => step.id),
    ['welcome', 'helper', 'server', 'authentication', 'secrets', 'tunnel', 'command', 'summary'],
    'the first step promises these steps, in this order',
  );
  assert.equal(SETUP_STEPS.length, 8);
  assert.ok(SETUP_STEPS.every((step) => typeof step.title === 'string' && step.title.length > 0));
});

test('a file that is not there, or that nobody can read, answers no answer', () => {
  assert.deepEqual(readSetupFlags(configFile), NO_ANSWER_FLAGS, 'the file does not exist');

  writeJson(configFile, {
    setupCompleted: true,
    setupVersion: SETUP_VERSION,
    setupDecidedAt: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(readSetupFlags(configFile).decided, true);

  writeJson(configFile, { setupCompleted: true });
  assert.equal(readSetupFlags(configFile).completed, true);
  assert.equal(readSetupFlags(configFile).version, 0, 'a completion without a version answers version 0');
  assert.equal(readSetupFlags(configFile).decided, false, 'and does not count for this version');

  fs.writeFileSync(configFile, 'not a JSON document', { mode: 0o600 });
  assert.deepEqual(readSetupFlags(configFile), NO_ANSWER_FLAGS, 'a file nobody can read is a machine that never answered');
});

/* ------------------------------------------- when the assistant is due ---- */

test('the assistant is due when the configuration file does not exist', () => {
  const decision = setupDecision({
    config: { vpnServer: 'vpn.example.com' },
    configFileExists: false,
    helperReady: true,
    flags: NO_ANSWER_FLAGS,
  });

  assert.deepEqual(decision.reasons, ['no-config-file'], 'the missing file is the only reason');
  assert.equal(decision.configured, false);
  assert.equal(decision.due, true);
  assert.equal(decision.decided, false);
  assert.equal(decision.version, SETUP_VERSION);
  assert.equal(decision.flags, NO_ANSWER_FLAGS, 'the flags of the machine travel back untouched');
});

test('the assistant is due when the file names no server', () => {
  const absent = setupDecision({ config: {}, configFileExists: true, helperReady: true, flags: NO_ANSWER_FLAGS });
  assert.deepEqual(absent.reasons, ['no-server']);
  assert.equal(absent.configured, false);
  assert.equal(absent.due, true);

  const blank = setupDecision({
    config: { vpnServer: '   ' },
    configFileExists: true,
    helperReady: true,
    flags: NO_ANSWER_FLAGS,
  });
  assert.deepEqual(blank.reasons, ['no-server'], 'a server of spaces is no server');
  assert.equal(blank.due, true);
});

test('the assistant is due when the privileged helper is not ready', () => {
  const decision = setupDecision({
    config: { vpnServer: 'vpn.example.com' },
    configFileExists: true,
    helperReady: false,
    flags: NO_ANSWER_FLAGS,
  });

  assert.deepEqual(decision.reasons, ['helper-not-ready']);
  assert.equal(decision.configured, false);
  assert.equal(decision.due, true);
});

test('a machine that is already configured is never interrupted', () => {
  const machine = { config: { vpnServer: 'vpn.example.com' }, configFileExists: true, helperReady: true };

  const never = setupDecision({ ...machine, flags: NO_ANSWER_FLAGS });
  assert.equal(never.configured, true, 'the file is there, it names a server and the helper is ready');
  assert.deepEqual(never.reasons, [], 'nothing is missing');
  assert.equal(never.due, false, 'so there is nothing to ask, even with no answer of any kind');

  const answered = setupDecision({ ...machine, flags: ANSWERED_FLAGS });
  assert.equal(answered.configured, true);
  assert.equal(answered.due, false);
  assert.equal(answered.decided, true);
});

test('an answer given to an older version of the assistant expires', () => {
  writeJson(configFile, { setupSkipped: true, setupVersion: 0, setupDecidedAt: '2026-01-02T03:04:05.000Z' });
  const expired = readSetupFlags(configFile);
  assert.equal(expired.skipped, true);
  assert.equal(expired.version, 0);
  assert.equal(expired.decided, false, 'a skip of an older version does not count for this one');

  const decision = setupDecision({
    config: { vpnServer: 'vpn.example.com' },
    configFileExists: true,
    helperReady: false,
    flags: expired,
  });
  assert.equal(decision.decided, false);
  assert.equal(decision.due, true, 'the assistant asks again');

  writeJson(configFile, {
    setupSkipped: true,
    setupVersion: SETUP_VERSION,
    setupDecidedAt: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(readSetupFlags(configFile).decided, true, 'the answer of this version counts');
});

test('the patch of an answer carries its keys and reset forgets both answers', () => {
  const at = '2026-01-02T03:04:05.000Z';

  assert.deepEqual(setupPatch({ completed: true, at }), {
    setupCompleted: true,
    setupSkipped: false,
    setupVersion: SETUP_VERSION,
    setupDecidedAt: at,
  });
  assert.deepEqual(setupPatch({ skipped: true, at }), {
    setupSkipped: true,
    setupVersion: SETUP_VERSION,
    setupDecidedAt: at,
  });
  assert.deepEqual(setupPatch({ reset: true, at }), {
    setupCompleted: false,
    setupSkipped: false,
    setupVersion: SETUP_VERSION,
    setupDecidedAt: at,
  });
  assert.match(setupPatch({ completed: true }).setupDecidedAt, ISO_8601, 'without an instant the patch carries now');
});

/* -------------------------------------------------- the session of a run ---- */

test('setupStatus asks for the file and the server on a machine that has neither', async () => {
  const status = await makeSession().setupStatus();

  assert.equal(status.ok, true);
  assert.equal(status.version, SETUP_VERSION);
  // The helper of the double is always ready (test/doubles/fake-provider.mjs),
  // so 'helper-not-ready' cannot appear here: the case of a helper that is not
  // ready is the next one, with a provider that says so.
  assert.deepEqual(status.reasons, ['no-config-file', 'no-server']);
  assert.equal(status.configured, false);
  assert.equal(status.due, true);
  assert.equal(status.decided, false);
  assert.deepEqual(status.flags, NO_ANSWER_FLAGS);
  assert.deepEqual(
    status.steps.map((step) => step.id),
    SETUP_STEPS.map((step) => step.id),
    'the window paints the steps the core names',
  );
  assert.equal(status.helper.ready, true);
  assert.equal(status.loginItem.ok, true);
  assert.equal(status.config.config.vpnServer, '');
  assert.deepEqual(status.config.setup, NO_ANSWER_FLAGS, 'the settings payload carries the same answer');
  assert.equal(status.config.paths.configFile, configFile);
});

test('setupStatus asks for the helper when the file already names a server', async () => {
  writeJson(configFile, { vpnServer: 'vpn.example.com' });
  const session = makeSession({ provider: { ...fakeProvider, helperReady: async () => false } });

  const status = await session.setupStatus();

  assert.deepEqual(status.reasons, ['helper-not-ready']);
  assert.equal(status.configured, false);
  assert.equal(status.due, true);
  assert.equal(status.helper.ready, false);
});

test('setupStatus leaves a configured machine alone and writes nothing', async () => {
  const original = { vpnServer: 'vpn.example.com', vpnPort: '8443' };
  writeJson(configFile, original);

  const status = await makeSession().setupStatus();

  assert.equal(status.configured, true);
  assert.deepEqual(status.reasons, []);
  assert.equal(status.due, false, 'a machine ready to connect is never interrupted');
  assert.equal(status.decided, false, 'and it never had to answer anything');
  assert.deepEqual(readJson(configFile), original, 'reading the setup changes no key of the file');
});

test('completing the assistant writes the four keys and keeps every other value', async () => {
  const original = { vpnServer: 'vpn.example.com', vpnPort: '8443', chromePath: '/opt/chrome', somethingElse: 'kept' };
  writeJson(configFile, original);

  const status = await makeSession().setupComplete();

  assert.equal(status.ok, true);
  assert.equal(status.decided, true);
  assert.equal(status.due, false);
  assert.equal(status.flags.completed, true);

  const file = readJson(configFile);
  assert.deepEqual(
    Object.keys(file).sort(),
    [...Object.keys(original), ...SETUP_KEYS].sort(),
    'the four keys of the assistant were added and nothing else',
  );
  assert.deepEqual(withoutSetupKeys(file), original, 'every value that was there is still there, unchanged');
  assert.equal(file.setupCompleted, true);
  assert.equal(file.setupSkipped, false);
  assert.equal(file.setupVersion, SETUP_VERSION);
  assert.match(file.setupDecidedAt, ISO_8601);
  assert.ok(Number.isFinite(Date.parse(file.setupDecidedAt)), 'the instant is a date JavaScript reads back');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, 'the file stays private to the user');
});

test('completing twice keeps the answer, the rest of the file and the version', async () => {
  writeJson(configFile, { vpnServer: 'vpn.example.com', somethingElse: 'kept' });
  const session = makeSession();

  await session.setupComplete();
  const once = readJson(configFile);

  const second = await session.setupComplete();
  const twice = readJson(configFile);

  assert.equal(second.due, false);
  assert.equal(second.decided, true);
  assert.equal(second.configured, true);
  assert.equal(twice.setupCompleted, true);
  assert.equal(twice.setupVersion, SETUP_VERSION);
  const { setupDecidedAt: firstAt, ...firstAnswer } = setupKeysOf(once);
  const { setupDecidedAt: secondAt, ...secondAnswer } = setupKeysOf(twice);
  assert.deepEqual(secondAnswer, firstAnswer, 'the second run leaves the answer of the first one');
  assert.match(secondAt, ISO_8601, 'and stamps the instant of the run that answered');
  assert.ok(Date.parse(secondAt) >= Date.parse(firstAt), 'walking through it again never carries an older instant');
  assert.deepEqual(withoutSetupKeys(twice), withoutSetupKeys(once), 'and every other value');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  const fresh = await makeSession().setupStatus();
  assert.equal(fresh.due, false, 'a new session reads the same answer');
  assert.equal(fresh.decided, true);
});

test('skipping keeps the file and stops the question', async () => {
  const original = { vpnPort: '8443', somethingElse: 'kept' };
  writeJson(configFile, original);

  const status = await makeSession().setupSkip();

  assert.equal(status.due, false, 'the assistant stops asking');
  assert.equal(status.configured, false, 'the machine still cannot connect');
  assert.ok(status.reasons.length > 0, 'and the window still knows what is missing');

  const file = readJson(configFile);
  assert.deepEqual(withoutSetupKeys(file), original, 'a skip keeps every value that was there');
  assert.equal(file.setupSkipped, true);
  assert.equal(file.setupVersion, SETUP_VERSION);
  assert.match(file.setupDecidedAt, ISO_8601);
  assert.equal(Object.hasOwn(file, 'setupCompleted'), false, 'a skip never claims the assistant was walked through');

  const fresh = await makeSession().setupStatus();
  assert.equal(fresh.due, false, 'a new session over the same file reads the same answer');
  assert.equal(fresh.decided, true);
  assert.equal(fresh.configured, false);
  assert.ok(fresh.reasons.length > 0);
});

test('repeating the assistant prefills what the file holds and a step loses nothing', async () => {
  writeJson(configFile, {
    vpnServer: 'vpn.example.com',
    vpnPort: '8443',
    username: 'someone@example.com',
    authMethod: 'totp',
    keepAwake: false,
    autoReconnect: false,
    somethingElse: 'kept',
  });
  const session = makeSession();
  await session.start({ poll: false });
  session.configSave({ password: 'prefilled-pass', totpSecret: 'prefilled-totp' });

  const status = await session.setupStatus();
  const shown = status.config;

  assert.equal(shown.config.vpnServer, 'vpn.example.com');
  assert.equal(shown.config.vpnPort, '8443');
  assert.equal(shown.config.username, 'someone@example.com');
  assert.equal(shown.config.authMethod, 'totp');
  assert.equal(shown.config.keepAwake, false);
  assert.equal(shown.config.autoReconnect, false);
  assert.equal(shown.config.password, '', 'a secret never comes back through the payload');
  assert.equal(shown.config.totpSecret, '');
  assert.equal(shown.hasPassword, true);
  assert.equal(shown.hasTotpSecret, true);
  assert.equal(shown.secretsStore.available, true);
  assert.equal(shown.secretsStore.id, 'fake');
  assert.equal(status.configured, true, 'the file names a server and the helper of the double is ready');
  assert.equal(status.due, false);

  await session.setupComplete();
  const answered = readJson(configFile);

  const step = session.configSave({ vpnPort: '9443' });

  assert.equal(step.ok, true);
  const walked = readJson(configFile);
  assert.equal(walked.vpnPort, '9443', 'the step took the value the assistant collected');
  assert.equal(walked.vpnServer, 'vpn.example.com', 'every other value stays as it was');
  assert.equal(walked.username, 'someone@example.com');
  assert.equal(walked.authMethod, 'totp');
  assert.equal(walked.keepAwake, false);
  assert.equal(walked.autoReconnect, false);
  assert.equal(walked.somethingElse, 'kept');
  assert.equal(Object.hasOwn(walked, 'password'), false, 'the step writes no secret');
  assert.equal(Object.hasOwn(walked, 'totpSecret'), false);
  assert.deepEqual(Object.keys(walked).sort(), Object.keys(answered).sort(), 'no key is duplicated or lost');
  assert.deepEqual(setupKeysOf(walked), setupKeysOf(answered), 'the answer of the assistant is untouched');
});

test('the secrets the assistant collects never land in the file in clear', async () => {
  const session = makeSession();
  await session.start({ poll: false });

  const saved = session.configSave({ password: 'assistant-pass', totpSecret: 'assistant-totp' });

  assert.equal(saved.ok, true);
  assert.equal(saved.hasPassword, true);
  assert.equal(saved.hasTotpSecret, true);

  const text = fs.readFileSync(configFile, 'utf8');
  const file = JSON.parse(text);
  assert.equal(Object.hasOwn(file, 'password'), false);
  assert.equal(Object.hasOwn(file, 'totpSecret'), false);
  assert.equal(text.includes('assistant-pass'), false, 'not even the value of the password is in the file');
  assert.equal(text.includes('assistant-totp'), false);
  assert.equal(readJson(storeFile).password, 'assistant-pass', 'the store of the double holds them');
  assert.equal(readJson(storeFile).totpSecret, 'assistant-totp');

  // The step that writes one secret at a time takes the same road.
  session.secretSet('password', 'second-pass');
  assert.equal(readJson(storeFile).password, 'second-pass');
  assert.equal(fs.readFileSync(configFile, 'utf8').includes('second-pass'), false);

  // And the window learns that they exist, never what they are.
  const status = await session.setupStatus();
  assert.equal(status.config.config.password, '');
  assert.equal(status.config.config.totpSecret, '');
  assert.equal(status.config.hasPassword, true);
  assert.equal(status.config.hasTotpSecret, true);
});

test('resetting forgets the answer and makes an unconfigured machine due again', async () => {
  const session = makeSession();
  await session.start({ poll: false });

  await session.setupSkip();
  assert.equal((await session.setupStatus()).due, false);

  const status = await session.setupReset();

  assert.equal(status.due, true, 'the assistant shows up again at the next start');
  assert.equal(status.decided, false);
  assert.equal(status.configured, false);
  assert.equal(status.flags.completed, false);
  assert.equal(status.flags.skipped, false);
  assert.equal(status.flags.version, SETUP_VERSION, 'the file keeps the version that answered');
  const file = readJson(configFile);
  assert.equal(file.setupCompleted, false);
  assert.equal(file.setupSkipped, false);
  assert.match(file.setupDecidedAt, ISO_8601);

  const fresh = await makeSession().setupStatus();
  assert.equal(fresh.due, true, 'a new session asks again too');
});

/* --------------------------------------------- the terminal, end to end ---- */

test('setup status, skip, complete and reset answer in a child process', () => {
  const box = sandbox();

  const cleanDocument = jsonOf(runCli(box, ['setup', 'status', '--json']));
  assert.equal(cleanDocument.command, 'setup status');
  const clean = cleanDocument.result;
  assert.equal(clean.version, SETUP_VERSION);
  assert.equal(clean.due, true);
  assert.equal(clean.configured, false);
  assert.equal(clean.decided, false);
  // The helper of the double is always ready, so the two reasons of a machine
  // with no file and no server are the two that appear here. The third reason
  // is the case of a provider that is not ready, covered above.
  assert.deepEqual(clean.reasons, ['no-config-file', 'no-server']);
  assert.deepEqual(clean.flags, NO_ANSWER_FLAGS);
  assert.deepEqual(
    clean.steps.map((step) => step.id),
    SETUP_STEPS.map((step) => step.id),
  );
  assert.equal(clean.helper.ready, true);
  assert.equal(clean.config.paths.configFile, box.configFile);

  const skipDocument = jsonOf(runCli(box, ['setup', 'skip', '--json']));
  assert.equal(skipDocument.command, 'setup skip');
  const skipped = skipDocument.result;
  assert.equal(skipped.due, false);
  assert.equal(skipped.configured, false);
  assert.equal(skipped.decided, true);
  assert.equal(skipped.flags.skipped, true);
  assert.equal(skipped.flags.version, SETUP_VERSION);
  assert.equal(readJson(box.configFile).setupSkipped, true, 'the answer landed in the file of the sandbox');

  const completeDocument = jsonOf(runCli(box, ['setup', 'complete', '--json']));
  assert.equal(completeDocument.command, 'setup complete');
  const completed = completeDocument.result;
  assert.equal(completed.due, false);
  assert.equal(completed.decided, true);
  assert.equal(completed.flags.completed, true);
  assert.equal(completed.flags.skipped, false);
  assert.equal(readJson(box.configFile).setupCompleted, true);
  assert.equal(readJson(box.configFile).setupSkipped, false);

  const resetDocument = jsonOf(runCli(box, ['setup', 'reset', '--json']));
  assert.equal(resetDocument.command, 'setup reset');
  const reset = resetDocument.result;
  assert.equal(reset.due, true, 'the assistant is due again');
  assert.equal(reset.decided, false);
  assert.equal(reset.flags.completed, false);
  assert.equal(reset.flags.skipped, false);
  assert.equal(reset.flags.version, SETUP_VERSION);
  assert.equal(readJson(box.configFile).setupCompleted, false);
});

test('config get and doctor carry the answer of the assistant', () => {
  const box = sandbox();
  writeJson(box.configFile, {
    vpnServer: 'vpn.example.com',
    setupCompleted: true,
    setupSkipped: false,
    setupVersion: SETUP_VERSION,
    setupDecidedAt: '2026-01-02T03:04:05.000Z',
  });

  const configDocument = jsonOf(runCli(box, ['config', 'get', '--json']));
  assert.equal(configDocument.command, 'config get');
  assert.deepEqual(configDocument.result.setup, ANSWERED_FLAGS);
  assert.equal(configDocument.result.config.vpnServer, 'vpn.example.com', 'the assistant prefills the same payload');
  assert.equal(configDocument.result.paths.configFile, box.configFile);

  const doctorDocument = jsonOf(runCli(box, ['doctor', '--json']));
  assert.equal(doctorDocument.command, 'doctor');
  const setup = doctorDocument.result.setup;
  assert.equal(setup.version, SETUP_VERSION);
  assert.equal(setup.configured, true, 'the file names a server and the helper of the double is ready');
  assert.deepEqual(setup.reasons, []);
  assert.equal(setup.due, false);
  assert.equal(setup.decided, true);
  assert.deepEqual(setup.flags, configDocument.result.setup, 'the terminal and the window read the same flags');
});

test('setup without a subcommand is still the alias of helper install', () => {
  const box = sandbox();

  // The dispatch table says it, and the child process proves which command runs.
  assert.equal(CLI_COMMANDS.setup.run, CLI_COMMANDS.helper.subcommands.install.run);

  const result = runCli(box, ['setup', '--json']);
  const document = JSON.parse(result.stdout);

  assert.equal(document.command, 'helper install', 'the plain form answers as helper install');
  // The provider of the double implements no installHelper (the providers of
  // src/core/platform do), so the installation itself cannot happen under the
  // doubles. What this case pins is the alias: the plain form reaches the same
  // command as the subcommand, and it is not an unknown one.
  assert.equal(document.ok, false);
  assert.match(document.error.message, /cannot install the helper/);
});
