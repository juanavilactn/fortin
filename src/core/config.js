import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_SECRETS, SECRET_NAMES, getSecret, hasSecret, setSecret, storeInfo } from './secrets.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Where the line that names the file just read goes. It is the console by
 * default; the CLI sends it to stderr while it prints machine readable output,
 * so `--json` leaves the standard output for the JSON document.
 */
let configLog = (line) => console.log(line);

export function setConfigLog(write) {
  configLog = typeof write === 'function' ? write : (line) => console.log(line);
}

/** How the secrets are named in the log, never by value. */
const SECRET_LABELS = { password: 'password', totpSecret: 'TOTP secret' };

export function getConfigDir() {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    throw new Error('Cannot determine the home directory (HOME or USERPROFILE)');
  }
  return path.join(homeDir, '.fortin');
}

export function getPaths() {
  const dir = getConfigDir();
  return {
    dir,
    configFile: path.join(dir, 'config.json'),
    logsDir: path.join(dir, 'logs'),
    screenshotsDir: path.join(dir, 'screenshots'),
    pidFile: path.join(dir, 'vpn.pid'),
    stopFile: path.join(dir, 'vpn.stop'),
    cookieFile: path.join(dir, '.last_cookie'),
  };
}

/**
 * File the app reads and writes. FORTIN_CONFIG retargets it, exactly as the
 * CLI does, so a save never lands in a different file than the one loaded.
 */
export function getActiveConfigFile() {
  return process.env.FORTIN_CONFIG || getPaths().configFile;
}

function getConfigFileCandidates() {
  return [
    process.env.FORTIN_CONFIG,
    getPaths().configFile,
    path.join(PACKAGE_ROOT, 'config.json'),
  ].filter(Boolean);
}

function firstConfigFile() {
  for (const configPath of getConfigFileCandidates()) {
    if (!fs.existsSync(configPath)) continue;
    try {
      return { config: JSON.parse(fs.readFileSync(configPath, 'utf8')), loadedFrom: configPath };
    } catch (error) {
      console.error(`Error parsing ${configPath}: ${error.message}`);
    }
  }
  return { config: {}, loadedFrom: null };
}

export function loadConfig() {
  const { config: fileConfig, loadedFrom } = firstConfigFile();
  if (loadedFrom) {
    configLog(`Loaded config from: ${loadedFrom}`);
  }

  return {
    vpnServer: process.env.VPN_SERVER || fileConfig.vpnServer || '',
    vpnPort: process.env.VPN_PORT || fileConfig.vpnPort || '443',
    vpnRealm: process.env.VPN_REALM || fileConfig.vpnRealm || '',
    username: process.env.VPN_USERNAME || fileConfig.username || '',
    // The environment wins, then the system store, then the file. The file is
    // only reached when the machine has no store, or when the value is still
    // there because the store refused it during the migration.
    password: process.env.VPN_PASSWORD || getSecret(SECRET_NAMES.password) || fileConfig.password || '',
    totpSecret: process.env.VPN_TOTP_SECRET || getSecret(SECRET_NAMES.totpSecret) || fileConfig.totpSecret || '',
    authMethod: process.env.VPN_AUTH_METHOD || fileConfig.authMethod || 'push',
    headless: process.env.VPN_HEADLESS !== 'false' && fileConfig.headless !== false,
    trustedCert: process.env.VPN_TRUSTED_CERT || fileConfig.trustedCert || 'any',
    chromePath: process.env.CHROME_PATH || fileConfig.chromePath || '',
    debugScreenshots: process.env.VPN_DEBUG_SCREENSHOTS
      ? process.env.VPN_DEBUG_SCREENSHOTS === 'true'
      : fileConfig.debugScreenshots === true,
    keepAwake: process.env.VPN_KEEP_AWAKE
      ? process.env.VPN_KEEP_AWAKE !== 'false'
      : fileConfig.keepAwake !== false,
    autoReconnect: process.env.VPN_AUTO_RECONNECT
      ? process.env.VPN_AUTO_RECONNECT !== 'false'
      : fileConfig.autoReconnect !== false,
    startAtLogin: process.env.VPN_START_AT_LOGIN
      ? process.env.VPN_START_AT_LOGIN === 'true'
      : fileConfig.startAtLogin === true,
  };
}

/** The configuration file is written in full, always private to the user. */
function writeConfigFile(configFile, config) {
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
}

/**
 * Removes the named keys from the configuration file, and nothing else. Used
 * when a secret is deleted: taking the store item away is not enough while a
 * copy written by an older version, or by a machine without a store, still sits
 * in the file. A file without those keys is left untouched.
 */
export function deleteConfigKeys(keys = []) {
  const configFile = getActiveConfigFile();
  const result = { file: configFile, removed: [] };

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return result;
  }
  if (!existing || typeof existing !== 'object') return result;

  for (const key of keys) {
    if (Object.hasOwn(existing, key)) result.removed.push(key);
  }
  if (result.removed.length === 0) return result;

  for (const key of result.removed) delete existing[key];
  writeConfigFile(configFile, existing);
  return result;
}

/**
 * Writes the configuration. Password and TOTP secret never land in the file
 * while the system store is available: they go to the store, and an empty
 * string still means "keep the stored value". Without a store the secrets are
 * written to the file (mode 0600) and 'log' receives the warning that says so.
 */
export function saveConfig(patch = {}, { log } = {}) {
  const configFile = getActiveConfigFile();
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });

  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    existing = {};
  }

  const store = storeInfo();
  const secrets = {};
  for (const name of CONFIG_SECRETS) {
    const value = patch[name];
    // An empty field means "keep what is already stored", never "erase it":
    // the UI never renders stored secrets, so it always submits them empty.
    if (typeof value !== 'string' || value.trim() === '') continue;
    secrets[name] = value;
  }

  // Secrets are stored before the file is written: a store that refuses the
  // value fails the save instead of leaving half of the change behind.
  if (store.available) {
    for (const [name, value] of Object.entries(secrets)) setSecret(name, value);
  } else if (Object.keys(secrets).length > 0) {
    log?.(`Secrets are kept in ${store.label} (mode 0600): ${store.reason}. They are not protected by the system.`);
  }

  const merged = { ...existing };
  // With a store in use the file keeps no secret at all, not even one written
  // by an older version of the application, but only for a secret the store
  // really holds: a value it refused stays in the file until it can move.
  if (store.available) {
    for (const name of CONFIG_SECRETS) {
      if (merged[name] === undefined) continue;
      if (Object.hasOwn(secrets, name) || hasSecret(name)) delete merged[name];
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (CONFIG_SECRETS.includes(key) && store.available) continue;
    merged[key] = value;
  }

  writeConfigFile(configFile, merged);
  return merged;
}

/**
 * Moves the secrets an older version wrote in clear to the system store. Runs
 * once at startup, in the application and in the CLI. The plaintext value is
 * removed from the file only after the store accepted it, so a store that is
 * unavailable, or that refuses the write, leaves everything as it was and says
 * so in the log. Never reports a value, only the name of the secret.
 */
export function migrateSecretsToStore({ log } = {}) {
  const store = storeInfo();
  const result = { store, migrated: [], cleared: [], cookie: false };

  const configFile = getActiveConfigFile();
  let fileConfig = null;
  try {
    if (fs.existsSync(configFile)) fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    log?.(`The stored secrets could not be migrated, ${configFile} could not be read: ${error.message}`);
  }

  const { cookieFile } = getPaths();
  let cookie = '';
  try {
    if (fs.existsSync(cookieFile)) cookie = fs.readFileSync(cookieFile, 'utf8').trim();
  } catch (error) {
    log?.(`The session cookie could not be read from ${cookieFile}: ${error.message}`);
  }

  const pending = CONFIG_SECRETS.filter(
    (name) => typeof fileConfig?.[name] === 'string' && fileConfig[name].trim() !== '',
  );

  // Nothing to move and nothing to protect: a machine without a store says
  // nothing at startup, and only speaks when a secret is really left behind.
  if (!store.available) {
    if (pending.length > 0 || cookie !== '') {
      log?.(`Secrets stay in the configuration file: ${store.reason}. They are not protected by the system.`);
    }
    return result;
  }

  if (fileConfig && typeof fileConfig === 'object') {
    for (const name of pending) {
      const value = fileConfig[name];
      try {
        // The store wins over the file: a value already stored is the one in
        // use, and the plaintext copy is an older one that only has to go.
        if (hasSecret(name)) {
          delete fileConfig[name];
          result.cleared.push(name);
          continue;
        }
        setSecret(name, value);
        delete fileConfig[name];
        result.migrated.push(name);
      } catch (error) {
        log?.(`The ${SECRET_LABELS[name] ?? name} stays in ${configFile}: ${error.message}`);
      }
    }

    if (result.migrated.length > 0 || result.cleared.length > 0) {
      try {
        writeConfigFile(configFile, fileConfig);
        if (result.migrated.length > 0) {
          const names = result.migrated.map((name) => SECRET_LABELS[name] ?? name).join(' and the ');
          log?.(`Moved the ${names} to ${store.label}`);
        }
        if (result.cleared.length > 0) {
          const names = result.cleared.map((name) => SECRET_LABELS[name] ?? name).join(' and the ');
          log?.(`Removed the ${names} from ${configFile}: ${store.label} already holds a value`);
        }
      } catch (error) {
        log?.(`The configuration file could not be rewritten, the secrets are still in ${configFile}: ${error.message}`);
      }
    }
  }

  // The session cookie was the other secret kept in clear on disk.
  try {
    if (cookie !== '') {
      setSecret(SECRET_NAMES.cookie, cookie);
      result.cookie = true;
    }
    if (cookie !== '' || fs.existsSync(cookieFile)) {
      fs.rmSync(cookieFile, { force: true });
      if (result.cookie) log?.(`Moved the last session cookie to ${store.label}`);
    }
  } catch (error) {
    log?.(`The session cookie stays in ${cookieFile}: ${error.message}`);
  }

  return result;
}
export const CONFIG_FIELDS = [
  { key: 'vpnServer', label: 'VPN server', type: 'text', secret: false, required: true, default: '' },
  { key: 'vpnPort', label: 'Port', type: 'text', secret: false, required: true, default: '443' },
  { key: 'vpnRealm', label: 'Realm', type: 'text', secret: false, required: false, default: '' },
  { key: 'username', label: 'Username (Microsoft email)', type: 'text', secret: false, required: true, default: '' },
  { key: 'password', label: 'Password', type: 'password', secret: true, required: false, default: '' },
  { key: 'totpSecret', label: 'TOTP secret', type: 'password', secret: true, required: false, default: '' },
  {
    key: 'authMethod',
    label: 'Authentication method',
    type: 'select',
    secret: false,
    required: true,
    default: 'push',
    options: [
      { value: 'push', label: 'Push notification' },
      { value: 'totp', label: 'TOTP code' },
    ],
  },
  { key: 'headless', label: 'Headless browser', type: 'boolean', secret: false, required: false, default: true },
  { key: 'trustedCert', label: 'Trusted certificate', type: 'text', secret: false, required: false, default: 'any' },
  { key: 'chromePath', label: 'Chrome path', type: 'text', secret: false, required: false, default: '' },
  {
    key: 'debugScreenshots',
    label: 'Debug screenshots',
    type: 'boolean',
    secret: false,
    required: false,
    default: false,
  },
  {
    key: 'keepAwake',
    label: 'Keep the machine awake while connected',
    type: 'boolean',
    secret: false,
    required: false,
    default: true,
  },
  {
    key: 'autoReconnect',
    label: 'Reconnect automatically if the tunnel drops',
    type: 'boolean',
    secret: false,
    required: false,
    default: true,
  },
  {
    key: 'startAtLogin',
    label: 'Start Fortin when I log in',
    type: 'boolean',
    secret: false,
    required: false,
    default: false,
  },
];
