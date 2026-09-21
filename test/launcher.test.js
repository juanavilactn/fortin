/**
 * The command line tool of the build: the launcher and the commands that
 * install it.
 *
 * Two halves. The first one runs the "cli status", "cli install" and
 * "cli uninstall" commands of src/cli.js as a child process, with the module
 * hook of test/doubles/ (FCVPN_FAKE_PROVIDER=1), a HOME, a configuration file
 * and a PATH inside a temporary directory. The launcher of those cases is a
 * file of that same directory, so every link the commands write stays there:
 * no case reads or writes the real PATH, the real home, the Keychain or an
 * installed application.
 *
 * The second half runs resources/cli/fortin, the launcher the build
 * ships, against synthetic layouts: a fake macOS bundle and a fake Linux
 * application folder. In both of them app.asar is a regular file, because in a
 * real build the archive is one file and the kernel cannot look inside it. The
 * program of the layout is a stub that prints its environment and its
 * arguments, so no case starts Electron, a connection or a window.
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
const SOURCE_LAUNCHER = path.join(REPO_ROOT, 'resources', 'cli', 'fortin');

/** Variables of the machine that would change the answer of a case. */
const VARIABLES_TO_DROP = [
  'FORTIN_LAUNCHER',
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
const readOnlyDirectories = [];

/**
 * A temporary root with a home and the files of the doubles. The root is
 * resolved, so the paths a case builds and the paths the commands answer are
 * the same string.
 */
function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-launcher-')));
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
    pathDirectory: path.join(root, 'bin'),
  };
}

/** A directory of a case, made on demand. */
function directory(box, name) {
  const target = path.join(box.root, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * File that stands in for the launcher of an installed application: the three
 * commands only need it to exist and to be runnable.
 */
function fakeLauncher(box) {
  const file = path.join(box.root, 'launcher');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

after(() => {
  // A directory without the write bit goes back to its mode before it goes
  // away, so the removal of a sandbox never has to force anything.
  for (const directory of readOnlyDirectories) {
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // The case already took the directory away.
    }
  }
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true });
});

function runCli(box, args, { env = {} } = {}) {
  const child = { ...process.env };
  for (const name of VARIABLES_TO_DROP) delete child[name];

  // The doubles are the last word on the environment: without
  // FCVPN_FAKE_PROVIDER the hook is inert and the child would reach the real
  // provider, which means the real Keychain and the real tunnel. The PATH is
  // the case and two system directories, so no case finds a command of the
  // machine.
  Object.assign(child, {
    HOME: box.home,
    FORTIN_CONFIG: box.configFile,
    FCVPN_FAKE_PROVIDER: '1',
    FCVPN_FAKE_STORE_FILE: box.storeFile,
    FCVPN_FAKE_LOGIN_ITEM_FILE: box.loginItemFile,
    FCVPN_FAKE_DUMP: box.dumpFile,
    PATH: [box.pathDirectory, '/usr/bin', '/bin'].join(path.delimiter),
  }, env);
  assert.equal(child.FCVPN_FAKE_PROVIDER, '1', 'the child has to run against the doubles');

  return spawnSync(process.execPath, ['--import', HOOK, CLI, ...args], {
    cwd: REPO_ROOT,
    env: child,
    encoding: 'utf8',
    timeout: 30000,
  });
}

/** The document of a command that worked: exit code 0 and the JSON envelope. */
function jsonOf(result) {
  assert.equal(result.error, undefined, 'the child could not run: ' + result.error?.message);
  assert.equal(result.status, 0, 'exit code ' + result.status + ', stderr: ' + result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.ok, true, result.stdout);
  assert.deepEqual(Object.keys(document).sort(), ['command', 'ok', 'result']);
  return document;
}

/** The document of a command that refused: exit code 1 and the same envelope. */
function errorOf(result, command) {
  assert.equal(result.error, undefined, 'the child could not run: ' + result.error?.message);
  assert.equal(result.status, 1, 'exit code ' + result.status + ', stdout: ' + result.stdout);
  const document = JSON.parse(result.stdout);
  assert.equal(document.ok, false, result.stdout);
  assert.equal(document.command, command);
  assert.deepEqual(Object.keys(document).sort(), ['command', 'error', 'ok']);
  return document;
}

/** Copy of the launcher of the build, with the mode the build gives it. */
function copyLauncher(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'fortin');
  fs.copyFileSync(SOURCE_LAUNCHER, file);
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * Program that stands in for the Electron binary of a layout: it prints its
 * environment and its arguments, and starts nothing.
 */
function writeStub(file, label) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    '#!/bin/sh',
    'echo "STUB ' + label + '"',
    'echo "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"',
    'for argument in "$@"; do echo "ARG=$argument"; done',
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.chmodSync(file, 0o755);
  return file;
}

/** Info.plist of a bundle, naming the program the bundle starts. */
function writeInfoPlist(bundle, name) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>' + name + '</string></dict></plist>',
    '',
  ];
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), lines.join('\n'));
}

/** The environment of a launcher case: the doubles never come into play. */
function runLauncher(box, program, args) {
  return spawnSync(program, args, {
    cwd: box.root,
    env: { HOME: box.home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 30000,
  });
}

/* ------------------------------------------------- install, status, uninstall */

test('cli status without a launcher names the missing application', () => {
  const box = sandbox();

  const run = runCli(box, ['cli', 'status', '--json']);

  // The command answered with what it found, so the envelope worked and the
  // result carries the failure. The exit code is the one of the result.
  assert.equal(run.status, 1);
  const document = JSON.parse(run.stdout);
  assert.equal(document.ok, true, run.stdout);
  assert.equal(document.command, 'cli status');
  assert.equal(document.result.ok, false);
  assert.equal(document.result.reason, 'no-application');
  assert.equal(document.result.launcher, null);
  assert.equal(document.result.packaged, false, 'node src/cli.js is not a packaged build');
  assert.match(run.stderr, /ships with the installed application/);
  assert.equal(fs.existsSync(path.join(box.home, '.fortin')), false, 'status is read only');

  const refused = errorOf(runCli(box, ['cli', 'install', '--json']), 'cli install');
  assert.match(refused.error.message, /ships with the installed application/);
  assert.deepEqual(fs.readdirSync(box.home), [], 'the install wrote nothing');
});

test('cli install links the launcher, repeats as a no-op and cli uninstall takes it away', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);
  const empty = directory(box, 'empty');
  const target = directory(box, 'target');
  const env = { FORTIN_LAUNCHER: launcher };

  const status = jsonOf(runCli(box, ['cli', 'status', '--json', '--dir', empty], { env }));
  assert.equal(status.result.ok, true);
  assert.equal(status.result.launcher, launcher);
  assert.equal(status.result.link.path, path.join(empty, 'fortin'));
  assert.equal(status.result.link.state, 'missing');
  assert.equal(status.result.runs, null, 'the PATH of the case holds no command');

  const installed = jsonOf(runCli(box, ['cli', 'install', '--json', '--dir', target], { env }));
  assert.equal(installed.command, 'cli install');
  assert.equal(installed.result.created, true);
  assert.equal(installed.result.replaced, null);
  assert.equal(installed.result.backup, null);
  assert.equal(installed.result.link.state, 'ours');
  assert.equal(installed.result.link.target, launcher);
  const link = path.join(target, 'fortin');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), launcher);

  const again = jsonOf(runCli(box, ['cli', 'install', '--json', '--dir', target], { env }));
  assert.equal(again.result.created, false);
  assert.equal(again.result.replaced, null);

  const removed = jsonOf(runCli(box, ['cli', 'uninstall', '--json', '--dir', target], { env }));
  assert.equal(removed.command, 'cli uninstall');
  assert.equal(removed.result.removed, true);
  assert.equal(removed.result.link.state, 'missing');
  assert.equal(fs.existsSync(link), false);

  const nothing = jsonOf(runCli(box, ['cli', 'uninstall', '--json', '--dir', target], { env }));
  assert.equal(nothing.result.removed, false);
});

test('cli install refuses a link of another program until --force replaces it', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);
  const target = directory(box, 'target');
  const env = { FORTIN_LAUNCHER: launcher };
  const link = path.join(target, 'fortin');
  fs.symlinkSync('/bin/echo', link);

  const refused = errorOf(runCli(box, ['cli', 'install', '--json', '--dir', target], { env }), 'cli install');
  assert.match(refused.error.message, /--force/);
  assert.match(refused.error.message, /another program/);
  assert.equal(fs.readlinkSync(link), '/bin/echo', 'the case left the foreign link alone');

  // The same refusal without --json goes to the error stream, and the standard
  // output stays empty.
  const human = runCli(box, ['cli', 'install', '--dir', target], { env });
  assert.equal(human.status, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /--force/);

  const forced = jsonOf(runCli(box, ['cli', 'install', '--json', '--force', '--dir', target], { env }));
  assert.equal(forced.result.created, false);
  assert.equal(forced.result.replaced, 'link');
  assert.equal(forced.result.link.state, 'ours');
  assert.equal(fs.readlinkSync(link), launcher);
});

test('cli install --force keeps the file that was there as a backup', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);
  const target = directory(box, 'target');
  const env = { FORTIN_LAUNCHER: launcher };
  const file = path.join(target, 'fortin');
  fs.writeFileSync(file, 'a file of somebody else\n');

  const refused = errorOf(runCli(box, ['cli', 'install', '--json', '--dir', target], { env }), 'cli install');
  assert.match(refused.error.message, /--force/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a file of somebody else\n');

  const forced = jsonOf(runCli(box, ['cli', 'install', '--json', '--force', '--dir', target], { env }));
  assert.equal(forced.result.created, false);
  assert.equal(forced.result.replaced, 'file');
  const backup = forced.result.backup;
  const stamp = backup.slice(file.length + '.backup-'.length);
  assert.equal(backup.startsWith(file + '.backup-'), true, backup);
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'a file of somebody else\n');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(file), launcher);
  assert.deepEqual(fs.readdirSync(target).sort(), ['fortin', path.basename(backup)].sort());
});

test('--dir without a value is a failure, not a default directory', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);

  for (const subcommand of ['status', 'install', 'uninstall']) {
    const run = runCli(box, ['cli', subcommand, '--json', '--dir'], { env: { FORTIN_LAUNCHER: launcher } });
    const document = errorOf(run, 'cli ' + subcommand);
    assert.match(document.error.message, /--dir/);
  }
  assert.deepEqual(fs.readdirSync(box.home), [], 'the cases wrote nothing');
});

test('cli status reports the copy of the PATH that comes first', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);
  const earlier = directory(box, 'earlier');
  const later = directory(box, 'later');
  const copy = path.join(earlier, 'fortin');
  const env = {
    FORTIN_LAUNCHER: launcher,
    PATH: [earlier, later, '/usr/bin', '/bin'].join(path.delimiter),
  };
  fs.symlinkSync('/bin/echo', copy);

  const shadowed = runCli(box, ['cli', 'status', '--json', '--dir', later], { env });
  const document = jsonOf(shadowed);
  assert.equal(document.result.runs.ours, false);
  assert.equal(document.result.runs.path, copy);
  assert.equal(document.result.runs.dir, earlier);
  assert.equal(document.result.runs.target, '/bin/echo');
  assert.equal(shadowed.stderr.includes(earlier), true, 'the warning names the directory of the copy');
  assert.match(shadowed.stderr, /sudo /);

  fs.unlinkSync(copy);
  fs.symlinkSync(launcher, copy);

  const own = jsonOf(runCli(box, ['cli', 'status', '--json', '--dir', later], { env }));
  assert.equal(own.result.runs.ours, true);
  assert.equal(own.result.runs.path, copy);
  assert.equal(own.result.runs.target, launcher);
});

// A directory that exists and refuses files is answered before anything is
// written: the command names the administrator rights and the line to run, and
// it does not fall back to another directory of the PATH.
test('cli install answers a directory it cannot write with an error and no file', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);
  const readOnly = path.join(box.root, 'solo-lectura');
  fs.mkdirSync(readOnly, { mode: 0o500 });
  readOnlyDirectories.push(readOnly);

  const run = runCli(box, ['cli', 'install', '--json', '--dir', readOnly], { env: { FORTIN_LAUNCHER: launcher } });

  const document = errorOf(run, 'cli install');
  assert.match(document.error.message, /administrator rights/);
  assert.match(run.stderr, /sudo "/, 'the case names the line to run with administrator rights');
  assert.deepEqual(fs.readdirSync(readOnly), [], 'the case wrote nothing');
  assert.equal(
    fs.existsSync(path.join(box.home, '.local', 'bin')),
    false,
    'the command did not fall back to another directory',
  );
});

test('cli install without --dir writes into the first directory of the PATH', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);
  const local = path.join(box.home, '.local', 'bin');
  assert.equal(fs.existsSync(local), false);

  const run = runCli(box, ['cli', 'install', '--json'], {
    env: { FORTIN_LAUNCHER: launcher, PATH: [local, '/usr/bin', '/bin'].join(path.delimiter) },
  });

  const document = jsonOf(run);
  assert.equal(document.result.link.dir, local);
  assert.equal(document.result.link.path, path.join(local, 'fortin'));
  assert.equal(document.result.onPath, true);
  assert.equal(document.result.created, true);
  assert.equal(document.result.runs.ours, true, 'a new terminal runs the copy of the case');
  assert.equal(fs.readlinkSync(path.join(local, 'fortin')), launcher);
});

test('--dir expands the home of the case and not the home of the machine', () => {
  const box = sandbox();
  const launcher = fakeLauncher(box);
  const bin = path.join(box.home, 'bin');
  assert.equal(fs.existsSync(bin), false);

  const document = jsonOf(runCli(box, ['cli', 'install', '--json', '--dir', '~/bin'], {
    env: { FORTIN_LAUNCHER: launcher },
  }));

  assert.equal(document.result.link.dir, bin);
  assert.equal(document.result.link.path, path.join(bin, 'fortin'));
  assert.equal(fs.readlinkSync(path.join(bin, 'fortin')), launcher);
});

/* ------------------------------------------------------------- the launcher */

test('the launcher starts the program of a macOS bundle with the CLI entry of the archive', () => {
  const box = sandbox();
  const bundle = path.join(box.root, 'Fake.app');
  const launcher = copyLauncher(path.join(bundle, 'Contents', 'Resources', 'cli'));
  writeStub(path.join(bundle, 'Contents', 'MacOS', 'Stub'), 'the macOS program');
  writeInfoPlist(bundle, 'Stub');
  const archive = path.join(bundle, 'Contents', 'Resources', 'app.asar');
  fs.writeFileSync(archive, 'the archive of the bundle, one file\n');

  // A link of another directory stands in for the link that "cli install"
  // writes: the launcher has to find itself again through it.
  const links = path.join(box.root, 'links');
  fs.mkdirSync(links);
  const link = path.join(links, 'fortin');
  fs.symlinkSync(launcher, link);

  const run = runLauncher(box, link, ['status', '--json']);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'STUB the macOS program',
    'RUN_AS_NODE=1',
    'ARG=' + path.join(archive, 'src', 'cli.js'),
    'ARG=status',
    'ARG=--json',
  ]);
  assert.equal(fs.statSync(archive).isFile(), true, 'the asar of a build is one file');
  assert.equal(fs.existsSync(path.join(archive, 'src', 'cli.js')), false, 'the entry lives inside the archive');
});

test('the launcher picks the program of a Linux application folder past the Chromium files', () => {
  const box = sandbox();
  const folder = path.join(box.root, 'application');
  const launcher = copyLauncher(path.join(folder, 'resources', 'cli'));
  writeStub(path.join(folder, 'zz-fortin'), 'the application');
  for (const name of [
    'chrome-sandbox',
    'chrome_crashpad_handler',
    'libEGL.so',
    'libGLESv2.so',
    'icudtl.dat',
    'v8_context_snapshot.bin',
    'snapshot_blob.bin',
    'resources.pak',
    'en-US.json',
    'index.html',
    'electron.desktop',
    'icon.png',
    'logo.svg',
  ]) {
    writeStub(path.join(folder, name), name);
  }
  writeStub(path.join(folder, 'locales', 'de.pak'), 'the locales folder');
  const archive = path.join(folder, 'resources', 'app.asar');
  fs.writeFileSync(archive, 'the archive of the application, one file\n');

  const run = runLauncher(box, launcher, ['version']);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'STUB the application',
    'RUN_AS_NODE=1',
    'ARG=' + path.join(archive, 'src', 'cli.js'),
    'ARG=version',
  ]);
});

test('a bundle whose plist names a program that is not there falls back to its only program', () => {
  const box = sandbox();
  const bundle = path.join(box.root, 'Fallback.app');
  const launcher = copyLauncher(path.join(bundle, 'Contents', 'Resources', 'cli'));
  writeInfoPlist(bundle, 'Gone');
  writeStub(path.join(bundle, 'Contents', 'MacOS', 'OnlyOne'), 'the only program');
  const archive = path.join(bundle, 'Contents', 'Resources', 'app.asar');
  fs.writeFileSync(archive, 'the archive of the bundle, one file\n');

  const run = runLauncher(box, launcher, ['status']);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), [
    'STUB the only program',
    'RUN_AS_NODE=1',
    'ARG=' + path.join(archive, 'src', 'cli.js'),
    'ARG=status',
  ]);
});

test('a launcher copied away from its application says why and nothing else', () => {
  const box = sandbox();
  const lonely = copyLauncher(path.join(box.root, 'away', 'cli'));

  const run = runLauncher(box, lonely, []);

  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /cannot find the application/);
  assert.match(run.stderr, /archive:/);
  assert.doesNotMatch(run.stderr, /Error:|^\s+at /m, 'the launcher reports the reason, not a stack trace');
});
