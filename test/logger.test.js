import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { Logger, sanitizeLine } from '../src/core/logger.js';

const loggerUrl = new URL('../src/core/logger.js', import.meta.url).href;

function temporaryLogs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fortin-logger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'logs');
}

function writeFromProcess(logDir, message, { exitImmediately = false } = {}) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Logger } from ${JSON.stringify(loggerUrl)};
    const logger = new Logger({ logDir: process.argv[1], mirror: 'none' });
    logger.log(process.argv[2]);
    ${exitImmediately ? 'process.exit(0);' : 'logger.dispose();'}
  `, logDir, message], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
}

test('separate CLI and GUI processes append to the same history', (t) => {
  const logDir = temporaryLogs(t);
  writeFromProcess(logDir, 'CLI configuration saved');
  writeFromProcess(logDir, 'GUI ready');
  writeFromProcess(logDir, 'CLI helper installed');

  const history = fs.readFileSync(path.join(logDir, 'latest.log'), 'utf8');
  assert.match(history, /CLI configuration saved/);
  assert.match(history, /GUI ready/);
  assert.match(history, /CLI helper installed/);
  assert.equal(history.trim().split('\n').length, 3);
  assert.deepEqual(fs.readdirSync(logDir), ['latest.log']);
  assert.equal(fs.lstatSync(path.join(logDir, 'latest.log')).isFile(), true);
});

test('a short command persists its last line before process.exit', (t) => {
  const logDir = temporaryLogs(t);
  writeFromProcess(logDir, 'Secret stored', { exitImmediately: true });

  assert.match(fs.readFileSync(path.join(logDir, 'latest.log'), 'utf8'), /Secret stored/);
});

test('reopening a logger preserves history and exposes a stable file path', (t) => {
  const logDir = temporaryLogs(t);
  const first = new Logger({ logDir, mirror: 'none' });
  first.log('Existing history');
  first.dispose();
  const previous = fs.readFileSync(first.filePath, 'utf8');

  const second = new Logger({ logDir, mirror: 'none' });
  t.after(() => second.dispose());
  assert.equal(second.filePath, first.filePath);
  assert.equal(second.filePath, fs.realpathSync(path.join(logDir, 'latest.log')));
  assert.equal(fs.readFileSync(second.filePath, 'utf8'), previous, 'opening does not truncate');
  second.error('New error');
  assert.match(fs.readFileSync(second.filePath, 'utf8'), /Existing history\n\[.*\] \[ERROR\] New error\n$/);
});

test('a legacy latest.log symlink keeps its target and accumulated lines', { skip: process.platform === 'win32' }, (t) => {
  const logDir = temporaryLogs(t);
  fs.mkdirSync(logDir, { recursive: true });
  const legacy = path.join(logDir, 'vpn-legacy.log');
  const latest = path.join(logDir, 'latest.log');
  fs.writeFileSync(legacy, 'Legacy connection\n');
  fs.symlinkSync('vpn-legacy.log', latest);

  const logger = new Logger({ logDir, mirror: 'none' });
  t.after(() => logger.dispose());
  logger.log('GUI ready');
  writeFromProcess(logDir, 'CLI disconnected');

  assert.equal(fs.lstatSync(latest).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(latest), 'vpn-legacy.log');
  assert.equal(logger.filePath, fs.realpathSync(legacy));
  assert.match(fs.readFileSync(legacy, 'utf8'), /^Legacy connection\n/);
  assert.match(fs.readFileSync(legacy, 'utf8'), /GUI ready[\s\S]*CLI disconnected/);
});

test('new and existing log files are private to the current user', { skip: process.platform === 'win32' }, (t) => {
  const logDir = temporaryLogs(t);
  const logger = new Logger({ logDir, mirror: 'none' });
  logger.log('Private log');
  logger.dispose();
  assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(logger.filePath).mode & 0o777, 0o600);

  fs.chmodSync(logDir, 0o755);
  fs.chmodSync(logger.filePath, 0o644);
  const reopened = new Logger({ logDir, mirror: 'none' });
  t.after(() => reopened.dispose());
  assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(reopened.filePath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(reopened.filePath, 'utf8'), /Private log/);
});

test('sanitization removes authentication credentials and ANSI sequences', () => {
  const examples = [
    ['\u001b[32mConnected\u001b[0m', 'Connected'],
    ['SVPNCOOKIE=test-cookie; Path=/', 'SVPNCOOKIE=***; Path=/'],
    ['openfortivpn --cookie=test-cookie', 'openfortivpn --cookie=***'],
    ['[OK] Captured auth_id: test-auth-id', '[OK] Captured auth_id: ***'],
    ['[OK] Captured auth_id from URL: test-auth-id', '[OK] Captured auth_id from URL: ***'],
    ['Current URL: http://127.0.0.1:8020/?id=test-auth-id', 'Current URL: http://127.0.0.1:8020/?***'],
    ['[Page] URL: https://login.example.com/saml?SAMLRequest=test-request&RelayState=test-state', '[Page] URL: https://login.example.com/saml?***'],
    ['Current URL: https://login.example.com/callback#access_token=test-token', 'Current URL: https://login.example.com/callback#***'],
    ['Generated TOTP: 123456', 'Generated TOTP: ***'],
    ['TOTP code: 12345678', 'TOTP code: ***'],
    ['Generated TOTP: ******', 'Generated TOTP: ******'],
    ['Auth: TOTP code', 'Auth: TOTP code'],
    ['Fetching SVPNCOOKIE using auth_id...', 'Fetching SVPNCOOKIE using auth_id...'],
  ];

  for (const [input, expected] of examples) assert.equal(sanitizeLine(input), expected);
});

test('disk and live events contain the same sanitized message', (t) => {
  const logDir = temporaryLogs(t);
  const logger = new Logger({ logDir, mirror: 'none' });
  t.after(() => logger.dispose());
  const lines = [];
  logger.on('line', (line) => lines.push(line));
  logger.log('Captured auth_id:', 'test-auth-id');
  logger.error(new Error('SVPNCOOKIE=test-cookie'));

  const history = fs.readFileSync(logger.filePath, 'utf8');
  assert.doesNotMatch(history, /test-auth-id|test-cookie/);
  assert.deepEqual(lines.map(({ level, message }) => ({ level, message })), [
    { level: 'info', message: 'Captured auth_id: ***' },
    { level: 'error', message: 'SVPNCOOKIE=***' },
  ]);
  for (const { message } of lines) assert.ok(history.includes(message));
});

test('dispose is idempotent and prevents further writes or events', (t) => {
  const logDir = temporaryLogs(t);
  const logger = new Logger({ logDir, mirror: 'none' });
  let events = 0;
  logger.on('line', () => events++);
  logger.log('Before dispose');
  logger.dispose();
  logger.dispose();
  logger.log('After dispose');
  logger.error('Error after dispose');

  assert.equal(events, 1);
  assert.equal(logger.listenerCount('line'), 0);
  assert.match(fs.readFileSync(logger.filePath, 'utf8'), /Before dispose/);
  assert.doesNotMatch(fs.readFileSync(logger.filePath, 'utf8'), /[Aa]fter dispose/);
});

test('a nonpersistent logger emits lines without creating a log directory', (t) => {
  const logDir = temporaryLogs(t);
  const logger = new Logger({ logDir, toFile: false, mirror: 'none' });
  t.after(() => logger.dispose());
  const messages = [];
  logger.on('line', ({ message }) => messages.push(message));
  logger.log({ action: 'saved' }, null, undefined, 3);

  assert.equal(logger.filePath, null);
  assert.equal(fs.existsSync(logDir), false);
  assert.deepEqual(messages, ['{"action":"saved"} null undefined 3']);
});
