/**
 * Login item of the application, without Electron.
 *
 * The window used to register the login item through `app.setLoginItemSettings`,
 * which only exists while the desktop application is running. The descriptor and
 * the write live here instead, so the same code answers the window and the
 * terminal: the platform provider owns the mechanism (a LaunchAgent on macOS, an
 * XDG autostart entry on Linux, a `Run` value on Windows) and this module owns
 * the contract.
 *
 * Contract, unchanged from the version that used Electron:
 *   - the result is `{ok, enabled, mechanism, message}` and never throws;
 *     `ok` false means the system refused the change, and `message` is a short
 *     note for the window and the log (empty when there is nothing to say);
 *   - `enabled` is what was applied, not what was asked for;
 *   - the stored value is `config.startAtLogin`, and a failure here never fails
 *     the configuration save.
 *
 * Two extra fields travel for the terminal and are ignored by the window:
 * `target`, the executable the entry launches, and `reason`, why nothing was
 * written or read: 'not-authorized' (the adapter said no), 'unsupported' (this
 * platform cannot offer one), 'no-application' (no packaged application to
 * launch), 'absent' (no entry right now) or 'failed' (the mechanism threw).
 *
 * Development protection: the entry always launches an application bundle, so a
 * development run (`electron .` from the repository, `node src/cli.js`) never
 * registers the Electron binary of `node_modules` nor the interpreter. The
 * desktop adapter passes its own authorization (`app.isPackaged`) and the CLI
 * leaves the decision to the resolution of the platform provider.
 */

import fs from 'node:fs';
import os from 'node:os';

import { STARTED_AT_LOGIN_FLAG, getProvider } from './platform/index.js';

export { STARTED_AT_LOGIN_FLAG };

/**
 * True when the system started this process at login. The argument its login
 * entry passes is the source of truth on every platform, because every entry
 * this code writes passes it.
 */
export function wasStartedAtLogin(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(STARTED_AT_LOGIN_FLAG);
}

/** The login item capability of a provider, or null when it cannot offer one. */
export function loginItemCapability({ provider = getProvider() } = {}) {
  const capability = provider?.loginItem;
  if (!capability || capability.supported !== true) return null;
  return capability;
}

/**
 * Where the login item lives and how it is written, resolved once per call so a
 * test can point it at a temporary home directory, an executable of its own and
 * a fake `launchctl`.
 */
export function loginItemEnv(overrides = {}) {
  const source = overrides ?? {};
  return {
    execPath: source.execPath ?? process.execPath,
    homeDir: source.homeDir ?? os.homedir(),
    uid: source.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null),
    exists: source.exists ?? defaultExists,
    run: source.run ?? null,
  };
}

/** What the system holds right now. Never throws. */
export function loginItemStatus({ provider, env } = {}) {
  const capability = loginItemCapability({ provider });
  if (!capability) {
    return { ok: true, enabled: false, mechanism: 'none', message: '', reason: 'unsupported' };
  }

  try {
    return normalise(capability.status(loginItemEnv(env)), capability);
  } catch (error) {
    return {
      ok: false,
      enabled: false,
      mechanism: capability.mechanism ?? 'none',
      message: messageOf(error),
      reason: 'failed',
    };
  }
}

/**
 * Makes the system match `enabled`. Never throws.
 *
 * `allow` is the explicit authorization of the adapter: the desktop application
 * passes `app.isPackaged`, the terminal leaves it true and lets the platform
 * provider decide whether a packaged application exists to launch.
 */
export function applyLoginItem({ enabled, log, provider, env, allow = true } = {}) {
  const wanted = enabled === true;
  const requested = { ok: true, enabled: false, mechanism: 'none', message: '' };

  if (allow !== true) {
    return { ...requested, reason: 'not-authorized' };
  }

  const capability = loginItemCapability({ provider });
  if (!capability) {
    return { ...requested, reason: 'unsupported' };
  }

  let outcome;
  try {
    outcome = normalise(capability.set(wanted, loginItemEnv(env)), capability);
  } catch (error) {
    outcome = {
      ok: false,
      enabled: false,
      mechanism: capability.mechanism ?? 'none',
      message: messageOf(error),
      reason: 'failed',
    };
  }

  if (log) {
    if (outcome.ok === false) log.error('Start at login: ' + outcome.message);
    else if (outcome.message) log.log('Start at login: ' + outcome.message);
  }
  return outcome;
}

/* ------------------------------------------------------------------ internals */

function normalise(result, capability) {
  const outcome = result && typeof result === 'object' ? result : {};
  const normalised = {
    ok: outcome.ok === true,
    enabled: outcome.enabled === true,
    mechanism: typeof outcome.mechanism === 'string' ? outcome.mechanism : capability.mechanism ?? 'none',
    message: typeof outcome.message === 'string' ? outcome.message : '',
  };
  if (typeof outcome.target === 'string' && outcome.target !== '') normalised.target = outcome.target;
  if (typeof outcome.reason === 'string' && outcome.reason !== '') normalised.reason = outcome.reason;
  if (typeof outcome.loaded === 'boolean') normalised.loaded = outcome.loaded;
  return normalised;
}

function defaultExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function messageOf(error) {
  return error?.message ?? String(error);
}
