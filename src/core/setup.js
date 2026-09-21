/**
 * Initial setup of a new installation.
 *
 * A machine that has just installed the application has no configuration, no
 * secret and no privileged helper: a window that only offers Connect is of no
 * use to it. This module owns the decision of when the window has to walk the
 * user through that minimum and the flags that remember the answer, so the
 * window and the terminal decide the same thing with the same code.
 *
 * When the assistant appears, in one sentence: while the machine is not ready
 * to connect (no configuration file, no server, or a helper that is not
 * installed) and the user has not answered yet (completed it, or postponed it
 * at this version of the assistant). A machine that is already configured is
 * never interrupted, which is what keeps the behaviour of an existing
 * installation as it was.
 *
 * The answer lives in the configuration file, next to the rest of the
 * settings, and never renames or rewrites a key that was already there:
 *
 *   setupCompleted   true when the user walked through the assistant
 *   setupSkipped     true when the user chose "later"
 *   setupVersion     version of the assistant that answered (SETUP_VERSION)
 *   setupDecidedAt   ISO-8601 instant of that answer
 *
 * One timestamp covers both answers and a later "ask me again", so the file
 * does not grow a fourth key to repeat the same instant. `setupVersion` is what
 * lets a future version of the assistant ask once more: an answer of an older
 * version does not count for the current one.
 */

import fs from 'node:fs';

import { getActiveConfigFile, saveConfig } from './config.js';

/** Version of the assistant. Bump it to ask a machine that already answered. */
export const SETUP_VERSION = 1;

/** Keys this module writes into config.json. Nothing else is touched. */
export const SETUP_KEYS = Object.freeze([
  'setupCompleted',
  'setupSkipped',
  'setupVersion',
  'setupDecidedAt',
]);

/**
 * Steps of the assistant, in order. The core owns the list because knowing how
 * many steps there are and what each one configures is what the first step
 * promises; the window paints the body of each one.
 */
export const SETUP_STEPS = Object.freeze([
  { id: 'welcome', title: 'Welcome' },
  { id: 'helper', title: 'Privileged helper' },
  { id: 'server', title: 'VPN server' },
  { id: 'authentication', title: 'Microsoft sign-in' },
  { id: 'secrets', title: 'Password and secrets' },
  { id: 'tunnel', title: 'Tunnel behaviour' },
  { id: 'command', title: 'Terminal command' },
  { id: 'summary', title: 'Summary' },
]);

/**
 * The flags of the configuration file, normalised. A file that is not there, or
 * that cannot be read, answers the flags of a machine that has never answered.
 * `decided` is the value the rest of the core uses: an answer given to this
 * version of the assistant.
 */
export function readSetupFlags(configFile = getActiveConfigFile()) {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    file = null;
  }
  const source = file && typeof file === 'object' ? file : {};
  const version = Number(source.setupVersion);

  const flags = {
    completed: source.setupCompleted === true,
    skipped: source.setupSkipped === true,
    version: Number.isFinite(version) ? version : 0,
    decidedAt: typeof source.setupDecidedAt === 'string' ? source.setupDecidedAt : '',
  };
  flags.decided = (flags.completed || flags.skipped) && flags.version >= SETUP_VERSION;
  return flags;
}

/**
 * Whether the assistant is due, and why. Pure: every input is given, so the
 * condition of a first run can be read and tested without a machine.
 *
 *   configured   the machine can connect: the file is there, it names a server
 *                and the privileged helper is ready
 *   due          the assistant has to appear: the machine is not configured and
 *                the user has not answered at this version yet
 *   reasons      which part of being configured is missing ('no-config-file',
 *                'no-server', 'helper-not-ready'); empty on a configured machine
 */
export function setupDecision({
  config = {},
  configFileExists = false,
  helperReady = false,
  flags = readSetupFlags(),
} = {}) {
  const server = String(config?.vpnServer ?? '').trim();
  const reasons = [];
  if (configFileExists !== true) reasons.push('no-config-file');
  if (server === '') reasons.push('no-server');
  if (helperReady !== true) reasons.push('helper-not-ready');

  return {
    version: SETUP_VERSION,
    due: reasons.length > 0 && flags.decided !== true,
    reasons,
    configured: reasons.length === 0,
    decided: flags.decided === true,
    flags,
  };
}

/**
 * The configuration patch that records an answer: the assistant was completed,
 * the user postponed it, or the decision is forgotten so the assistant asks
 * again. Every patch carries the version and the instant; a skip leaves a
 * previous completion alone, because postponing a repetition does not undo the
 * fact that the machine was configured once.
 */
export function setupPatch({ completed = false, skipped = false, reset = false, at = new Date().toISOString() } = {}) {
  if (reset === true) {
    return { setupCompleted: false, setupSkipped: false, setupVersion: SETUP_VERSION, setupDecidedAt: at };
  }
  if (skipped === true) {
    return { setupSkipped: true, setupVersion: SETUP_VERSION, setupDecidedAt: at };
  }
  return { setupCompleted: completed === true, setupSkipped: false, setupVersion: SETUP_VERSION, setupDecidedAt: at };
}

/**
 * Writes the answer into the configuration file and returns the flags that are
 * left. It goes through saveConfig, so the merge never drops a key that was
 * already there and a secret never lands in the file because of this call.
 */
export function writeSetupFlags({ completed = false, skipped = false, reset = false, at } = {}) {
  saveConfig(setupPatch({ completed, skipped, reset, at }));
  return readSetupFlags();
}
