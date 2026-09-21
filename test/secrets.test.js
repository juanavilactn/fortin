/**
 * Secrets: the move of the plaintext values an older version left behind, and
 * the delete that leaves no copy anywhere.
 *
 * The store is the file backed double of test/doubles/fake-provider.mjs and
 * every path comes from a temporary home directory, so neither the real
 * Keychain nor ~/.fortin is involved.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

import { getPaths, loadConfig, migrateSecretsToStore, setConfigLog } from '../src/core/config.js';
import { getProvider } from '../src/core/platform/index.js';
import { SECRET_NAMES, hasSecret } from '../src/core/secrets.js';
import { VpnSession } from '../src/core/session.js';
import { fakeProvider } from './doubles/fake-provider.mjs';
import { VpnController } from './doubles/fake-vpn.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-secrets-'));
const configFile = path.join(tmpRoot, '.fortin', 'config.json');
const storeFile = path.join(tmpRoot, 'store.json');

process.env.HOME = tmpRoot;
process.env.FORTIN_CONFIG = configFile;
process.env.FCVPN_FAKE_STORE_FILE = storeFile;
delete process.env.FORTIN_SECRET_STORE;

setConfigLog(() => {});

// The secret store the core reaches is the fake one, through the provider of
// the platform. The provider the session receives directly is the same double.
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
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function makeSession() {
  const config = {};
  return new VpnSession({
    config,
    provider: fakeProvider,
    paths: getPaths(),
    controller: new VpnController({ config }),
  });
}

beforeEach(() => {
  fs.rmSync(configFile, { force: true });
  fs.rmSync(storeFile, { force: true });
  fs.rmSync(getPaths().cookieFile, { force: true });
  writeJson(configFile, {});
});

test('the migration moves the plaintext secrets without losing any of them', () => {
  const paths = getPaths();
  writeJson(configFile, {
    vpnServer: 'vpn.example.com',
    username: 'file-user',
    password: 'file-pass',
    totpSecret: 'file-totp',
  });
  fs.writeFileSync(paths.cookieFile, 'cookie-value\n', { mode: 0o600 });

  const result = makeSession().migrateSecrets();

  assert.deepEqual(result.migrated, ['password', 'totpSecret']);
  assert.equal(result.cookie, true);

  const store = readJson(storeFile);
  assert.equal(store.password, 'file-pass');
  assert.equal(store.totpSecret, 'file-totp');
  assert.equal(store[SECRET_NAMES.cookie], 'cookie-value');

  const file = readJson(configFile);
  assert.equal(file.vpnServer, 'vpn.example.com', 'a plain value stays where it was');
  assert.equal(file.username, 'file-user');
  assert.equal(Object.hasOwn(file, 'password'), false, 'the password left the file');
  assert.equal(Object.hasOwn(file, 'totpSecret'), false, 'the TOTP secret left the file');
  assert.equal(fs.existsSync(paths.cookieFile), false, 'the plaintext cookie file is gone');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.equal(hasSecret(SECRET_NAMES.password), true);
  assert.equal(loadConfig().password, 'file-pass');
});

test('the migration names the secrets it moves and never prints their value', () => {
  writeJson(configFile, { password: 'file-pass', totpSecret: 'file-totp' });
  const logged = [];

  migrateSecretsToStore({ log: (line) => logged.push(line) });

  const text = logged.join('\n');
  assert.match(text, /password/);
  assert.match(text, /TOTP secret/);
  assert.equal(text.includes('file-pass'), false, 'a value never reaches the log');
  assert.equal(text.includes('file-totp'), false);
});

test('deleting a secret removes the item and the copy in the file', () => {
  writeJson(configFile, { vpnServer: 'vpn.example.com', password: 'file-pass' });
  writeJson(storeFile, { password: 'file-pass' });
  const session = makeSession();

  assert.equal(session.configGet().hasPassword, true);

  const result = session.secretDelete('password');

  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(hasSecret(SECRET_NAMES.password), false);
  assert.equal(Object.hasOwn(readJson(configFile), 'password'), false);
  assert.equal(Object.hasOwn(readJson(storeFile), 'password'), false);
  assert.equal(session.configGet().hasPassword, false);
  assert.equal(session.secretsStatus().items.find((item) => item.name === 'password').where, 'none');
});
