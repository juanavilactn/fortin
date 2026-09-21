/**
 * Platform provider double.
 *
 * It re-exports the real module, so every helper of src/core/platform/index.js
 * keeps working, and replaces getProvider() with a provider that touches no
 * part of the machine: no Keychain, no launchctl, no sudo, no installed VPN
 * client. The secret store and the login item are files named by
 * FCVPN_FAKE_STORE_FILE and FCVPN_FAKE_LOGIN_ITEM_FILE.
 *
 * It is loaded by test/doubles/hook.mjs, which is what makes the core see it
 * instead of the real provider inside a child process:
 *
 *   FCVPN_FAKE_PROVIDER=1 node --import ./test/doubles/hook.mjs src/cli.js ...
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export * from '../../src/core/platform/index.js';

const DEFAULT_STORE_FILE = path.join(os.tmpdir(), 'fortin-fake-store.json');
const DEFAULT_LOGIN_ITEM_FILE = path.join(os.tmpdir(), 'fortin-fake-login-item.json');

function fileFromEnv(name, fallback) {
  const value = String(process.env[name] ?? '').trim();
  return value === '' ? fallback : value;
}

export function fakeStoreFile() {
  return fileFromEnv('FCVPN_FAKE_STORE_FILE', DEFAULT_STORE_FILE);
}

export function fakeLoginItemFile() {
  return fileFromEnv('FCVPN_FAKE_LOGIN_ITEM_FILE', DEFAULT_LOGIN_ITEM_FILE);
}

function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Secret store of the double: a JSON object of {account: value}. */
export const fakeSecrets = {
  info() {
    return { id: 'fake', label: 'the fake secret store', available: true, reason: '' };
  },

  get(account) {
    const value = readJsonObject(fakeStoreFile())[account];
    return typeof value === 'string' ? value : '';
  },

  has(account) {
    return Object.hasOwn(readJsonObject(fakeStoreFile()), account);
  },

  set(account, value) {
    const store = readJsonObject(fakeStoreFile());
    store[account] = String(value);
    writeJsonObject(fakeStoreFile(), store);
  },

  remove(account) {
    const store = readJsonObject(fakeStoreFile());
    if (!Object.hasOwn(store, account)) return;
    delete store[account];
    writeJsonObject(fakeStoreFile(), store);
  },
};

/** Login item capability of the double, also backed by a file. */
export const fakeLoginItem = {
  supported: true,
  mechanism: 'fake',
  file: fakeLoginItemFile,

  status() {
    const record = readJsonObject(fakeLoginItemFile());
    if (record.enabled !== true) {
      return { ok: true, enabled: false, mechanism: 'fake', message: '', reason: 'absent' };
    }
    const result = { ok: true, enabled: true, mechanism: 'fake', message: '' };
    if (typeof record.target === 'string') result.target = record.target;
    return result;
  },

  set(enabled, env = {}) {
    if (enabled !== true) {
      fs.rmSync(fakeLoginItemFile(), { force: true });
      return { ok: true, enabled: false, mechanism: 'fake', message: '' };
    }

    const target = String(env?.execPath ?? process.execPath);
    writeJsonObject(fakeLoginItemFile(), { enabled: true, target });
    return { ok: true, enabled: true, mechanism: 'fake', message: '', target };
  },
};

export const fakeProvider = {
  id: 'fake',
  helperPath: '/usr/local/libexec/fortin-helper',
  secrets: fakeSecrets,
  loginItem: fakeLoginItem,

  async helperReady() {
    return true;
  },

  async ensureClient() {
    return { ok: true, version: 'openfortivpn 1.23.1 (fake)', message: '' };
  },

  async isVpnRunning() {
    return false;
  },

  async connect() {
    return { pid: null };
  },

  async stop() {
    return true;
  },
};

/** The double the core receives wherever it asks for the provider of the platform. */
export function getProvider() {
  return fakeProvider;
}
