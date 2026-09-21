/**
 * Configuration and secret priority.
 *
 * The rule of the core: the environment wins over the system store, and the
 * store over the configuration file. The store here is a double installed in
 * the provider of the running platform, so the real Keychain is never touched,
 * and every file lives under a temporary home directory.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

import { loadConfig, saveConfig, setConfigLog } from '../src/core/config.js';
import { getProvider } from '../src/core/platform/index.js';
import { storeInfo } from '../src/core/secrets.js';

const ENVIRONMENT_VARIABLES = [
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
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-config-'));
const configFile = path.join(tmpRoot, '.fortin', 'config.json');

process.env.HOME = tmpRoot;
process.env.FORTIN_CONFIG = configFile;
delete process.env.FORTIN_SECRET_STORE;
for (const name of ENVIRONMENT_VARIABLES) delete process.env[name];

// The line that names the file just read belongs to the terminal, not to a test.
setConfigLog(() => {});

/** The store of this test: the provider of the platform with its secrets replaced. */
const provider = getProvider();
const realSecrets = provider.secrets;
const store = new Map();
provider.secrets = {
  info: () => ({ id: 'test', label: 'the store of this test', available: true, reason: '' }),
  get: (account) => store.get(account) ?? '',
  has: (account) => store.has(account),
  set: (account, value) => {
    store.set(account, String(value));
  },
  remove: (account) => {
    store.delete(account);
  },
};

after(() => {
  provider.secrets = realSecrets;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfigFile(value) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

beforeEach(() => {
  store.clear();
  delete process.env.FORTIN_SECRET_STORE;
  for (const name of ENVIRONMENT_VARIABLES) delete process.env[name];
  fs.rmSync(configFile, { force: true });
  writeConfigFile({});
});

test('the store wins over the configuration file', () => {
  writeConfigFile({
    vpnServer: 'file.example.com',
    vpnPort: '1443',
    username: 'file-user',
    password: 'file-pass',
    totpSecret: 'file-totp',
  });
  store.set('password', 'store-pass');
  store.set('totpSecret', 'store-totp');

  const config = loadConfig();

  assert.equal(config.vpnServer, 'file.example.com', 'a plain value comes from the file');
  assert.equal(config.vpnPort, '1443');
  assert.equal(config.username, 'file-user');
  assert.equal(config.password, 'store-pass');
  assert.equal(config.totpSecret, 'store-totp');
});

test('the environment wins over the store and over the file', () => {
  writeConfigFile({ vpnServer: 'file.example.com', password: 'file-pass', totpSecret: 'file-totp' });
  store.set('password', 'store-pass');
  store.set('totpSecret', 'store-totp');
  process.env.VPN_SERVER = 'env.example.com';
  process.env.VPN_PASSWORD = 'env-pass';
  process.env.VPN_TOTP_SECRET = 'env-totp';

  const config = loadConfig();

  assert.equal(config.vpnServer, 'env.example.com');
  assert.equal(config.password, 'env-pass');
  assert.equal(config.totpSecret, 'env-totp');
});

test('the file is the last resort, and only when the store holds nothing', () => {
  writeConfigFile({ vpnServer: 'file.example.com', password: 'file-pass', totpSecret: 'file-totp' });

  const config = loadConfig();

  assert.equal(config.vpnServer, 'file.example.com');
  assert.equal(config.password, 'file-pass');
  assert.equal(config.totpSecret, 'file-totp');
});

test('a save keeps the secrets out of the file while the store is available', () => {
  // The file still holds a password written before the store existed: the save
  // takes it away, because a value the store holds does not live in the file.
  writeConfigFile({ vpnServer: 'old.example.com', password: 'file-pass' });
  const logged = [];

  const saved = saveConfig(
    { vpnServer: 'vpn.example.com', vpnPort: '8443', password: 'new-pass' },
    { log: (line) => logged.push(line) },
  );

  assert.equal(store.get('password'), 'new-pass', 'the password went to the store');
  assert.equal(saved.password, undefined);
  const file = readConfigFile();
  assert.equal(file.vpnServer, 'vpn.example.com');
  assert.equal(file.vpnPort, '8443');
  assert.equal(Object.hasOwn(file, 'password'), false, 'no secret belongs in the file');
  assert.equal(loadConfig().password, 'new-pass');
  assert.deepEqual(logged, [], 'with a store there is nothing to warn about');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  saveConfig({ password: '' });
  assert.equal(store.get('password'), 'new-pass', 'an empty field keeps the stored value');
  assert.equal(loadConfig().password, 'new-pass');
});

test('a machine without a store keeps the secrets in the file and says so', () => {
  process.env.FORTIN_SECRET_STORE = 'file';
  writeConfigFile({ vpnServer: 'vpn.example.com' });
  const logged = [];

  saveConfig({ password: 'file-pass' }, { log: (line) => logged.push(line) });

  assert.equal(store.size, 0, 'the store is not used at all');
  assert.equal(readConfigFile().password, 'file-pass');
  assert.equal(loadConfig().password, 'file-pass');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /not protected by the system/);

  const info = storeInfo();
  assert.equal(info.available, false);
  assert.equal(info.reason, 'disabled with FORTIN_SECRET_STORE=file');
});
