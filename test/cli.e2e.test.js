/**
 * The terminal, end to end.
 *
 * Every case starts src/cli.js as a child process with the module hook of
 * test/doubles/ (FCVPN_FAKE_PROVIDER=1), HOME and FORTIN_CONFIG inside a
 * temporary directory, and the fake secret store, the fake login item and the
 * dump of the connection in files of that same directory. Nothing here reads or
 * writes the real configuration, the Keychain or an installed application.
 *
 * With --json the standard output carries the JSON document and nothing else,
 * which is why every case parses the whole standard output.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(REPO_ROOT, 'test', 'doubles', 'hook.mjs');
const CLI = path.join(REPO_ROOT, 'src', 'cli.js');

/** Variables of the machine that would change the answer of a case. */
const VARIABLES_TO_DROP = [
  'FORTIN_SECRET_STORE',
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

const sandboxes = [];

/** A home directory and the files of the doubles, all of them temporary. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-cli-'));
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

after(() => {
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true });
});

function runCli(box, args, { input = '' } = {}) {
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
    input,
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

test('status --json answers one JSON document', () => {
  const box = sandbox();

  const document = jsonOf(runCli(box, ['status', '--json']));

  assert.equal(document.command, 'status');
  assert.equal(document.result.state, 'disconnected');
  assert.equal(document.result.backgroundPid, null);
  assert.equal(document.result.logFile, path.join(box.home, '.fortin', 'logs', 'latest.log'));
});

test('a command that does not exist answers one JSON document and the exit code 1', () => {
  const box = sandbox();

  const result = runCli(box, ['not-a-command', '--json']);

  assert.equal(result.status, 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.ok, false);
  assert.equal(document.command, 'not-a-command');
  assert.deepEqual(Object.keys(document).sort(), ['command', 'error', 'ok']);
  assert.match(document.error.message, /Unknown command/);
});

test('config get --json shows the configuration, the fields and the paths', () => {
  const box = sandbox();

  const document = jsonOf(runCli(box, ['config', 'get', '--json']));

  assert.equal(document.command, 'config get');
  assert.equal(document.result.config.vpnPort, '443');
  assert.equal(document.result.hasPassword, false);
  assert.equal(document.result.secretsStore.available, true);
  assert.equal(document.result.secretsStore.id, 'fake');
  assert.equal(document.result.paths.configFile, box.configFile);
  assert.ok(document.result.fields.length > 0, 'the window and the terminal read the same fields');
});

test('config set writes the value and keeps every secret out of the file', () => {
  const box = sandbox();

  const result = runCli(box, ['config', 'set', 'vpnPort', '8443']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(box.configFile).vpnPort, '8443');
  const text = fs.readFileSync(box.configFile, 'utf8');
  assert.equal(text.includes('password'), false, 'the file holds no secret key');
  assert.equal(text.includes('totpSecret'), false);
  assert.equal(fs.statSync(box.configFile).mode & 0o777, 0o600);
});

test('secrets set reads the value from the standard input, status reports it and delete removes it', () => {
  const box = sandbox();

  const set = runCli(box, ['secrets', 'set', 'password', '--json'], { input: 'store-pass\n' });

  const stored = jsonOf(set);
  assert.equal(stored.command, 'secrets set');
  assert.equal(readJson(box.storeFile).password, 'store-pass', 'the value went to the store');
  assert.equal(Object.hasOwn(readJson(box.configFile), 'password'), false);
  assert.equal(set.stdout.includes('store-pass'), false, 'the value is never printed');
  assert.equal(set.stderr.includes('store-pass'), false);

  const status = jsonOf(runCli(box, ['secrets', 'status', '--json']));
  const password = status.result.items.find((item) => item.name === 'password');
  assert.deepEqual({ present: password.present, where: password.where }, { present: true, where: 'store' });

  const deleted = jsonOf(runCli(box, ['secrets', 'delete', 'password', '--json']));
  assert.equal(deleted.result.deleted, true);
  assert.equal(Object.hasOwn(readJson(box.storeFile), 'password'), false, 'the item left the store');
  assert.equal(
    jsonOf(runCli(box, ['secrets', 'status', '--json'])).result.items.find((item) => item.name === 'password').where,
    'none',
  );
});

test('logs --json reads the current log file', () => {
  const box = sandbox();
  const latest = path.join(box.home, '.fortin', 'logs', 'latest.log');
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.writeFileSync(latest, 'first line\nsecond line\n');

  const document = jsonOf(runCli(box, ['logs', '--json']));

  assert.equal(document.command, 'logs');
  assert.deepEqual(document.result.lines, ['first line', 'second line']);
  assert.equal(document.result.total, 2);
});

test('helper status --json reports the helper and the client of the provider', () => {
  const box = sandbox();

  const document = jsonOf(runCli(box, ['helper', 'status', '--json']));

  assert.equal(document.command, 'helper status');
  assert.equal(document.result.id, 'fake');
  assert.equal(document.result.ready, true);
  assert.equal(document.result.client.ok, true);
  assert.match(document.result.client.version, /openfortivpn/);
});

test('login-item status, enable and disable answer with what they applied', () => {
  const box = sandbox();

  const status = jsonOf(runCli(box, ['login-item', 'status', '--json']));
  assert.equal(status.command, 'login-item status');
  assert.equal(status.result.enabled, false);
  assert.equal(status.result.mechanism, 'fake');

  const enabled = jsonOf(runCli(box, ['login-item', 'enable', '--json']));
  assert.equal(enabled.command, 'login-item enable');
  assert.equal(enabled.result.enabled, true);
  assert.equal(readJson(box.loginItemFile).target, process.execPath);

  const disabled = jsonOf(runCli(box, ['login-item', 'disable', '--json']));
  assert.equal(disabled.result.enabled, false);
  assert.equal(fs.existsSync(box.loginItemFile), false);
});

test('info --json names the application, the provider and the paths in use', () => {
  const box = sandbox();

  const document = jsonOf(runCli(box, ['info', '--json']));

  assert.equal(document.command, 'info');
  assert.equal(document.result.name, 'fortin');
  assert.match(document.result.version, /^\d+\.\d+\.\d+/);
  assert.equal(document.result.provider.id, 'fake');
  assert.equal(document.result.configDir, path.join(box.home, '.fortin'));
  assert.equal(document.result.configFile, box.configFile);
  assert.equal(document.result.secretsStore.available, true);
});

test('doctor --json answers the whole state and writes nothing', () => {
  const box = sandbox();

  const document = jsonOf(runCli(box, ['doctor', '--json']));

  assert.equal(document.command, 'doctor');
  assert.equal(document.result.app.provider.id, 'fake');
  assert.equal(document.result.config.file, box.configFile);
  assert.equal(document.result.config.exists, false);
  assert.equal(document.result.secrets.store.id, 'fake');
  assert.equal(document.result.helper.ready, true);
  assert.equal(document.result.tunnel.state, 'disconnected');
  assert.equal(document.result.tunnel.owner, 'detached');
  assert.equal(document.result.loginItem.ok, true);
  assert.equal(fs.existsSync(path.join(box.home, '.fortin')), false, 'doctor is read only');
});

test('a connection started with a flag takes the password of the command line', () => {
  const box = sandbox();
  writeJson(box.configFile, { vpnServer: 'vpn.example.com', password: 'file-pass' });
  writeJson(box.storeFile, { password: 'store-pass' });

  const document = jsonOf(runCli(box, ['start', '--json', '-P', 'cli-pass']));

  assert.equal(document.command, 'start');
  assert.deepEqual(readJson(box.dumpFile), {
    password: 'cli-pass',
    totpSecret: '',
    server: 'vpn.example.com',
    port: '443',
    authMethod: 'push',
    foreground: false,
    headless: true,
  });
});

test('a connection started without a flag takes the password of the store', () => {
  const box = sandbox();
  writeJson(box.configFile, { vpnServer: 'vpn.example.com' });
  writeJson(box.storeFile, { password: 'store-pass' });

  jsonOf(runCli(box, ['start', '--json']));

  assert.equal(readJson(box.dumpFile).password, 'store-pass');
});

// The rule is the environment, then the store, then the file. A plaintext copy
// in the file must not replace the item the store already holds.
test('the copy in the file does not replace the password of the store', () => {
  const box = sandbox();
  writeJson(box.configFile, { vpnServer: 'vpn.example.com', password: 'file-pass' });
  writeJson(box.storeFile, { password: 'store-pass' });

  jsonOf(runCli(box, ['start', '--json']));

  assert.equal(readJson(box.dumpFile).password, 'store-pass');
});
