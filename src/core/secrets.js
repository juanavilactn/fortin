/**
 * Secret storage: password, TOTP secret and the last session cookie.
 *
 * The values live in the store the operating system provides, through the
 * provider of the current platform (src/core/platform): the macOS Keychain and
 * the freedesktop secret store are implemented, Windows falls back to the file.
 * This module is the only place that decides where a secret goes, what happens
 * when the machine has no store and how the plaintext values written by older
 * versions are migrated.
 *
 * Rules that hold on every platform:
 *   - Nothing is written to a log, an error message or the console: only the
 *     name of the secret and the outcome are ever reported.
 *   - A read that fails, or that finds nothing, answers an empty string. A
 *     write and a delete throw, so the caller can tell the user.
 *   - Every call is synchronous. loadConfig() is synchronous and its callers
 *     are too, and the store answers in milliseconds.
 *
 * FORTIN_SECRET_STORE=file keeps every secret in the configuration file
 * (mode 0600) and skips the store entirely. It exists for machines where the
 * store is not usable and for testing the fallback.
 */

import { getProvider } from './platform/index.js';

/** Names the secrets are stored under. The account of the store item is the name. */
export const SECRET_NAMES = Object.freeze({
  password: 'password',
  totpSecret: 'totpSecret',
  cookie: 'svpnCookie',
});

/** Secrets that used to be written to the configuration file. */
export const CONFIG_SECRETS = [SECRET_NAMES.password, SECRET_NAMES.totpSecret];

/** Value of FORTIN_SECRET_STORE that disables the system store. */
const FILE_STORE = 'file';

function storeDisabled() {
  return String(process.env.FORTIN_SECRET_STORE || '').trim().toLowerCase() === FILE_STORE;
}

/** The store of the platform, or null when the platform cannot provide one. */
function activeStore() {
  try {
    return getProvider().secrets ?? null;
  } catch {
    return null;
  }
}

/**
 * Where the secrets of this machine are kept, as the window shows it:
 * {platform, id, label, available, reason}. An empty reason means "nothing to
 * report"; an unavailable store carries a short cause.
 */
export function storeInfo() {
  if (storeDisabled()) {
    return {
      platform: process.platform,
      id: 'none',
      label: 'the configuration file',
      available: false,
      reason: 'disabled with FORTIN_SECRET_STORE=file',
    };
  }

  const store = activeStore();
  if (!store) {
    return {
      platform: process.platform,
      id: 'none',
      label: 'the configuration file',
      available: false,
      reason: 'this platform has no secret store',
    };
  }

  return { platform: process.platform, ...store.info() };
}

/** True when a secret written now goes to the system store. */
export function isStoreAvailable() {
  return storeInfo().available === true;
}

/** Stored value, or an empty string when there is no secret or no store. */
export function getSecret(name) {
  const store = storeDisabled() ? null : activeStore();
  if (!store || !store.info().available) return '';
  try {
    return store.get(name) ?? '';
  } catch {
    // A store that cannot answer is the same as a store without the item: the
    // caller decides (loadConfig falls back to the file, the window asks again).
    return '';
  }
}

/**
 * Creates or updates a secret. Throws when the store refuses the value, so a
 * save can report the failure instead of pretending the secret is safe. Without
 * a store the secret is left to the caller (the configuration file).
 */
export function setSecret(name, value) {
  const info = storeInfo();
  if (!info.available) {
    const error = new Error(`Secrets cannot be stored in ${info.label}: ${info.reason}`);
    error.code = 'SECRET_STORE_UNAVAILABLE';
    throw error;
  }
  activeStore().set(name, String(value));
}

/** Removes a secret. Deleting what is not there is not an error. */
export function deleteSecret(name) {
  if (!isStoreAvailable()) return;
  activeStore().remove(name);
}

/** True when the store holds a value for that secret. Never throws. */
export function hasSecret(name) {
  const store = storeDisabled() ? null : activeStore();
  if (!store || !store.info().available) return false;
  try {
    return store.has(name) === true;
  } catch {
    return false;
  }
}
