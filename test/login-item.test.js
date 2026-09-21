/**
 * Login item: the contract of src/core/login-item.js over the platform providers.
 *
 * Every case points the mechanism at a temporary home directory, an executable
 * of its own and a fake `run`, so nothing here touches launchd, the real
 * LaunchAgents folder or the installed application.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { STARTED_AT_LOGIN_FLAG, applyLoginItem, loginItemStatus, wasStartedAtLogin } from '../src/core/login-item.js';
import { darwinProvider } from '../src/core/platform/darwin.js';
import { linuxProvider } from '../src/core/platform/linux.js';

const DEBUG_EXECUTABLE = '/usr/local/bin/node';
const PACKAGED_EXECUTABLE = '/Applications/Fortin.app/Contents/MacOS/Fortin';

const homes = [];

/** A home directory of this test, never the real one. */
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fcvpn-login-item-'));
  homes.push(home);
  return home;
}

after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

/** A launchctl that always answers; a loaded job is not needed to write the file. */
function launchctlFound() {
  return () => '';
}

function launchctlMissing() {
  return () => {
    throw new Error('launchctl: the job is not loaded');
  };
}

test('a development run registers no login item at all', () => {
  const homeDir = tempHome();
  const env = { execPath: DEBUG_EXECUTABLE, homeDir, exists: () => false, run: launchctlFound() };

  const result = applyLoginItem({ enabled: true, provider: darwinProvider, env });

  assert.deepEqual(result, { ok: true, enabled: false, mechanism: 'none', message: '', reason: 'no-application' });
  assert.equal(fs.existsSync(darwinProvider.loginItem.file(homeDir)), false, 'nothing may be written');
  assert.equal(fs.existsSync(path.dirname(darwinProvider.loginItem.file(homeDir))), false, 'not even the folder');
});

test('a packaged build leaves the launch agent the status reports', () => {
  const homeDir = tempHome();
  const file = darwinProvider.loginItem.file(homeDir);
  const env = { execPath: PACKAGED_EXECUTABLE, homeDir, exists: () => true, run: launchctlFound() };

  const enabled = applyLoginItem({ enabled: true, provider: darwinProvider, env });
  assert.deepEqual(enabled, {
    ok: true,
    enabled: true,
    mechanism: 'launch-agent',
    message: '',
    target: PACKAGED_EXECUTABLE,
  });

  const body = fs.readFileSync(file, 'utf8');
  const programArguments = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body);
  assert.ok(programArguments, 'the launch agent has no ProgramArguments');
  const values = [...programArguments[1].matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  assert.deepEqual(values, [PACKAGED_EXECUTABLE, STARTED_AT_LOGIN_FLAG], 'the entry launches the app, marked as a login start');
  assert.match(body, /<key>RunAtLoad<\/key>\s*<true\/>/, 'launchd has to run the job at login');
  assert.match(body, /<key>KeepAlive<\/key>\s*<false\/>/, 'quitting the app must not bring it back');

  const status = loginItemStatus({ provider: darwinProvider, env });
  assert.equal(status.ok, true);
  assert.equal(status.enabled, true);
  assert.equal(status.mechanism, 'launch-agent');
  assert.equal(status.target, PACKAGED_EXECUTABLE);

  // 'loaded' is what tells a job launchd holds from a job that is only written,
  // and the provider answers it without touching the machine when 'run' is a
  // fake. It does not survive the core, which is why the case below is a todo.
  assert.equal(darwinProvider.loginItem.status(env).loaded, true, 'a launchctl that answers means the job is loaded');
  assert.equal(darwinProvider.loginItem.status({ ...env, run: launchctlMissing() }).loaded, false);

  const disabled = applyLoginItem({ enabled: false, provider: darwinProvider, env });
  assert.deepEqual(disabled, { ok: true, enabled: false, mechanism: 'launch-agent', message: '' });
  assert.equal(fs.existsSync(file), false, 'disabling removes the file');
  assert.deepEqual(loginItemStatus({ provider: darwinProvider, env }), {
    ok: true,
    enabled: false,
    mechanism: 'launch-agent',
    message: '',
    reason: 'absent',
  });
});

// The provider answers 'loaded' and the CLI prints it, but the core rebuilds the
// answer without that field, so the line of launchd never appears.
test('the status keeps the loaded flag of the provider', () => {
  const homeDir = tempHome();
  const executable = '/Applications/Fortin.app/Contents/MacOS/Fortin';
  const env = { execPath: executable, homeDir, exists: () => true, run: launchctlFound() };

  applyLoginItem({ enabled: true, provider: darwinProvider, env });
  assert.equal(loginItemStatus({ provider: darwinProvider, env }).loaded, true);
});

test('the contract answers a failure instead of throwing', () => {
  const homeDir = tempHome();

  const refusing = {
    id: 'refusing',
    loginItem: {
      supported: true,
      mechanism: 'launch-agent',
      status: () => ({ ok: true, enabled: false, mechanism: 'launch-agent', message: '' }),
      set: () => {
        throw new Error('the system did not apply the login item');
      },
    },
  };
  assert.deepEqual(applyLoginItem({ enabled: true, provider: refusing, env: { homeDir } }), {
    ok: false,
    enabled: false,
    mechanism: 'launch-agent',
    message: 'the system did not apply the login item',
    reason: 'failed',
  });

  const unreadable = {
    id: 'unreadable',
    loginItem: {
      supported: true,
      mechanism: 'launch-agent',
      status: () => {
        throw new Error('launchctl cannot answer');
      },
      set: () => ({ ok: true, enabled: false, mechanism: 'launch-agent', message: '' }),
    },
  };
  assert.deepEqual(loginItemStatus({ provider: unreadable }), {
    ok: false,
    enabled: false,
    mechanism: 'launch-agent',
    message: 'launchctl cannot answer',
    reason: 'failed',
  });

  const unsupported = { id: 'unsupported', loginItem: { supported: false, mechanism: 'none' } };
  assert.deepEqual(applyLoginItem({ enabled: true, provider: unsupported }), {
    ok: true,
    enabled: false,
    mechanism: 'none',
    message: '',
    reason: 'unsupported',
  });
  assert.deepEqual(loginItemStatus({ provider: unsupported }), {
    ok: true,
    enabled: false,
    mechanism: 'none',
    message: '',
    reason: 'unsupported',
  });
});

test('a run that is not authorized to write stays out of the system', () => {
  let writes = 0;
  const provider = {
    id: 'test',
    loginItem: {
      supported: true,
      mechanism: 'launch-agent',
      status: () => ({ ok: true, enabled: false, mechanism: 'launch-agent', message: '' }),
      set: () => {
        writes += 1;
        return { ok: true, enabled: true, mechanism: 'launch-agent', message: '' };
      },
    },
  };

  const result = applyLoginItem({ enabled: true, allow: false, provider });
  assert.deepEqual(result, { ok: true, enabled: false, mechanism: 'none', message: '', reason: 'not-authorized' });
  assert.equal(writes, 0, 'a window that is not packaged must not write the login item');
});

test('the argument of the entry is the source of truth of a login start', () => {
  assert.equal(STARTED_AT_LOGIN_FLAG, '--started-at-login');
  assert.equal(wasStartedAtLogin([DEBUG_EXECUTABLE, 'src/cli.js', STARTED_AT_LOGIN_FLAG]), true);
  assert.equal(wasStartedAtLogin([DEBUG_EXECUTABLE, 'src/cli.js']), false);
  assert.equal(wasStartedAtLogin([]), false);
  assert.equal(wasStartedAtLogin(STARTED_AT_LOGIN_FLAG), false, 'argv is always a list');
  assert.equal(wasStartedAtLogin(), false, 'this process was not started by a login entry');
});

test('on Linux the mechanism writes and removes the XDG autostart file', () => {
  const homeDir = tempHome();
  const xdgConfigHome = path.join(homeDir, '.config');
  const executable = '/opt/fortin/fortin';
  const env = { homeDir, xdgConfigHome, execPath: executable, exists: () => true };
  const file = path.join(xdgConfigHome, 'autostart', 'fortin.desktop');

  assert.deepEqual(linuxProvider.loginItem.set(true, env), {
    ok: true,
    enabled: true,
    mechanism: 'autostart',
    message: '',
    target: executable,
  });

  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^\[Desktop Entry\]$/m);
  const exec = /^Exec=(.*)$/m.exec(body);
  assert.ok(exec, 'the desktop entry has no Exec line');
  assert.ok(exec[1].includes(executable), 'the entry launches the application');
  assert.ok(exec[1].includes(STARTED_AT_LOGIN_FLAG), 'the entry marks the start as a login one');

  assert.deepEqual(linuxProvider.loginItem.status({ homeDir, xdgConfigHome }), {
    ok: true,
    enabled: true,
    mechanism: 'autostart',
    message: '',
    target: executable,
  });

  assert.deepEqual(linuxProvider.loginItem.set(false, env), {
    ok: true,
    enabled: false,
    mechanism: 'autostart',
    message: '',
  });
  assert.equal(fs.existsSync(file), false, 'disabling removes the autostart file');
  assert.deepEqual(linuxProvider.loginItem.status({ homeDir, xdgConfigHome }), {
    ok: true,
    enabled: false,
    mechanism: 'autostart',
    message: '',
    reason: 'absent',
  });
});

// The usual Linux install path holds a space, and the status of the mechanism
// cannot read the executable back from the entry. The item is still enabled and
// the entry still launches the application, so this is a reporting gap.
test('the status of the XDG entry recovers an executable whose path has a space', () => {
  const homeDir = tempHome();
  const xdgConfigHome = path.join(homeDir, '.config');
  const executable = '/opt/Fortin/Fortin';
  const env = { homeDir, xdgConfigHome, execPath: executable, exists: () => true };

  linuxProvider.loginItem.set(true, env);
  assert.equal(linuxProvider.loginItem.status({ homeDir, xdgConfigHome }).target, executable);
});
