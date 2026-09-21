/**
 * The command line tool of the installed application, as the window sees it.
 *
 * Linking the tool into a directory of the PATH is one of the optional steps of
 * the initial setup. The implementation is already there and already tested:
 * the launcher the build ships inside the bundle answers `cli status` and
 * `cli install` (resources/cli, wired in electron-builder.yml). This module
 * asks the launcher for that answer instead of writing a second linker, so the
 * window, the assistant and a terminal all install the same link with the same
 * code, and a bundle can never drift from the copy a terminal writes.
 *
 * The process is the only part of the core that starts another program to do
 * its work, and it is safe to call: `cli status` writes nothing, `cli install`
 * writes one link in a directory the user owns, and neither asks for
 * administrator rights. A window never raises a password dialog of its own, so
 * when the directory the tool picks is not in the PATH, the answer carries the
 * alternative a terminal uses to put the command where every terminal searches
 * it, together with the `sudo` command that directory needs.
 *
 * A checkout has no launcher: isPackagedExecutable() answers false and the
 * status says 'no-application', which is the same thing `cli status` prints in
 * a terminal. FORTIN_LAUNCHER names one directly, exactly as it does for
 * the terminal, and that is how a checkout exercises the step.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundleOf, isPackagedExecutable, run } from './platform/index.js';

/** Name of the command the build ships, and of the file it links. */
const LAUNCHER_NAME = 'fortin';
const COMMAND_FILE = process.platform === 'win32' ? `${LAUNCHER_NAME}.cmd` : LAUNCHER_NAME;

/** A launcher that hangs never holds a window. */
const LAUNCHER_TIMEOUT_MS = 30000;

/**
 * Launcher of this build, or null when this process is not an installed
 * application. FORTIN_LAUNCHER wins, which is what a checkout uses.
 */
export function launcherPath({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const override = String(env.FORTIN_LAUNCHER ?? '').trim();
  if (override) return path.resolve(override);
  if (!isPackagedExecutable(execPath)) return null;
  if (platform === 'darwin') {
    const bundle = bundleOf(execPath);
    return bundle ? path.join(bundle, 'Contents', 'Resources', 'cli', LAUNCHER_NAME) : null;
  }
  return path.join(path.dirname(execPath), 'resources', 'cli', COMMAND_FILE);
}

/** Directory a new terminal of every machine searches, and that needs admin rights. */
const ADMIN_DIRECTORY = '/usr/local/bin';

/**
 * What the command line tool is in this build, without writing anything:
 * where the launcher is, which directory would take the command, whether that
 * directory is in the PATH, which copy a new terminal runs and, when it is not
 * in the PATH, the alternative a terminal uses.
 */
export async function commandLineStatus({ launcher = launcherPath() } = {}) {
  if (!launcher) return unavailable();

  const answer = await askLauncher(launcher, 'status');
  if (answer.ok !== true) {
    return { ok: false, available: true, launcher, directory: null, message: answer.message };
  }

  const result = answer.result ?? {};
  const directory = result.link?.dir ?? null;
  return {
    ok: true,
    available: true,
    launcher,
    command: result.command ?? COMMAND_FILE,
    directory,
    entry: result.link ? { path: result.link.path, state: result.link.state, target: result.link.target } : null,
    onPath: result.onPath === true,
    runs: result.runs ?? null,
    alternative: alternativeOf(launcher, directory, result.onPath === true),
    message: '',
  };
}

/**
 * Links the command into the directory the tool picks, and reports what is left
 * there. It never replaces an entry of another program and never asks for
 * administrator rights: a directory that needs them answers the `sudo` command
 * to run in a terminal instead.
 */
export async function installCommandLine({ launcher = launcherPath() } = {}) {
  if (!launcher) return { ...unavailable(), installed: false };

  const before = await commandLineStatus({ launcher });
  const answer = await askLauncher(launcher, 'install');
  const result = answer.result ?? {};
  const after = await commandLineStatus({ launcher });

  const state = answer.ok === true ? (after.entry?.state ?? null) : (before.entry?.state ?? null);
  const installed = state === 'ours';
  const directory = after.directory ?? before.directory ?? null;
  const onPath = after.onPath === true;
  const alternative = after.alternative ?? before.alternative ?? null;

  let message = '';
  if (answer.ok !== true) message = answer.message;
  else if (installed) message = 'The command is linked into ' + (directory ?? 'the PATH');

  return {
    ok: answer.ok === true && installed === true,
    available: true,
    installed,
    launcher,
    command: after.command ?? COMMAND_FILE,
    directory,
    entry: after.entry ?? before.entry ?? null,
    onPath,
    runs: after.runs ?? null,
    alternative,
    message,
  };
}

/* ------------------------------------------------------------------ internals */

function unavailable() {
  return {
    ok: true,
    available: false,
    launcher: null,
    command: COMMAND_FILE,
    directory: null,
    entry: null,
    onPath: false,
    runs: null,
    alternative: null,
    reason: 'no-application',
    message: 'The command line tool ships with the installed application. Install it, then run this step from it.',
  };
}

/** Runs the launcher with one of the two `cli` subcommands and reads its answer. */
async function askLauncher(launcher, subcommand) {
  if (!fs.existsSync(launcher)) {
    return { ok: false, message: `The launcher of this application is not there: ${launcher}` };
  }

  const args = ['cli', subcommand, '--json'];
  try {
    const { stdout } = process.platform === 'win32'
      ? await run(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', launcher, ...args], { timeout: LAUNCHER_TIMEOUT_MS })
      : await run(launcher, args, { timeout: LAUNCHER_TIMEOUT_MS });
    return readEnvelope(stdout);
  } catch (error) {
    // A command that fails still answers the envelope on the standard output.
    const envelope = readEnvelope(error?.stdout ?? '');
    if (envelope.ok === false || envelope.result) return envelope;
    return { ok: false, message: error?.message ?? String(error) };
  }
}

/** {ok, command, result} and {ok:false, command, error} of src/cli.js. */
function readEnvelope(text) {
  let document = null;
  try {
    document = JSON.parse(String(text ?? '').trim());
  } catch {
    document = null;
  }
  if (!document || typeof document !== 'object') {
    return { ok: false, message: 'The command line tool did not answer a JSON document' };
  }
  if (document.ok === false) {
    return { ok: false, message: document.error?.message ?? 'The command line tool refused the command', code: document.error?.code };
  }
  return { ok: true, result: document.result ?? {} };
}

/**
 * The command that puts the tool in a directory a terminal already searches,
 * or null when the directory the tool picked is already one of them. The window
 * never runs it: it needs administrator rights, and the step says so.
 */
function alternativeOf(launcher, directory, onPath) {
  if (!directory || onPath === true || directory === ADMIN_DIRECTORY) return null;
  if (process.platform === 'win32') return null;
  return { directory: ADMIN_DIRECTORY, command: sudoCommand(launcher, ADMIN_DIRECTORY) };
}

/** The command a user runs in a terminal when the directory needs admin rights. */
function sudoCommand(launcher, directory) {
  const home = os.homedir();
  const shown = launcher.startsWith(home) ? `~${launcher.slice(home.length)}` : launcher;
  return `sudo "${shown}" cli install --dir "${directory}"`;
}
