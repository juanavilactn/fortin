import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { syncCask, syncCaskCheckout } from '../scripts/sync-cask.mjs';

const SHA_ARM = 'a'.repeat(64);
const SHA_INTEL = 'b'.repeat(64);

function cask(version, { arm = SHA_ARM, intel = SHA_INTEL, description = 'Fortin VPN' } = {}) {
  return `cask "fortin" do
  version "${version}"
  on_arm do
    sha256 "${arm}"
  end
  on_intel do
    sha256 "${intel}"
  end
  desc "${description}"
end
`;
}

function remote(content, sha = 'remote-sha') {
  return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha };
}

function api(responses) {
  const requests = [];
  return {
    requests,
    async fetchImpl(url, options) {
      requests.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      assert.ok(responses.length, `unexpected request: ${options.method} ${url}`);
      const next = responses.shift();
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
    },
  };
}

function run(mock, content = cask('1.2.0'), options = {}) {
  return syncCask({
    repo: 'example/homebrew-tap', filePath: 'Casks/fortin.rb', content,
    token: 'test-token', fetchImpl: mock.fetchImpl, ...options,
  });
}

test('updates the discovered default branch using the current file SHA', async () => {
  const content = cask('1.2.0');
  const mock = api([
    { body: { default_branch: 'release/main' } },
    { body: remote(cask('1.1.0')) },
    {},
  ]);
  assert.deepEqual(await run(mock, content), { status: 'updated', version: '1.2.0', branch: 'release/main' });
  assert.equal(mock.requests[1].url, 'https://api.github.com/repos/example/homebrew-tap/contents/Casks/fortin.rb?ref=release%2Fmain');
  assert.deepEqual(mock.requests[2].body, {
    message: 'Update Fortin cask to 1.2.0', content: Buffer.from(content).toString('base64'),
    branch: 'release/main', sha: 'remote-sha',
  });
  assert.equal(mock.requests[2].method, 'PUT');
  assert.equal(mock.requests[2].headers.Authorization, 'Bearer test-token');
  assert.equal(mock.requests[2].redirect, 'error');
});

test('skips an identical cask and a semantically newer release', async () => {
  for (const [remoteVersion, status] of [['1.2.0', 'unchanged'], ['1.10.0', 'newer'], ['2.0.0', 'newer']]) {
    const mock = api([{ body: { default_branch: 'main' } }, { body: remote(cask(remoteVersion)) }]);
    assert.equal((await run(mock)).status, status);
    assert.equal(mock.requests.length, 2);
  }
});

test('refuses changed checksums for the same released version', async () => {
  for (const architecture of ['arm', 'intel']) {
    const mock = api([
      { body: { default_branch: 'main' } },
      { body: remote(cask('1.2.0', { [architecture]: 'c'.repeat(64) })) },
    ]);
    await assert.rejects(run(mock), /refusing to change the checksums of released version 1\.2\.0/);
    assert.equal(mock.requests.length, 2);
  }
});

test('updates canonical cask text when a version and its checksums are unchanged', async () => {
  const mock = api([
    { body: { default_branch: 'main' } },
    { body: remote(cask('1.2.0', { description: 'Previous description' })) },
    {},
  ]);
  assert.equal((await run(mock)).status, 'updated');
});

test('retries a conflict with the fresh SHA', async () => {
  const mock = api([
    { body: { default_branch: 'main' } },
    { body: remote(cask('1.0.0'), 'first-sha') },
    { status: 409 },
    { body: remote(cask('1.1.0'), 'second-sha') },
    {},
  ]);
  assert.equal((await run(mock)).status, 'updated');
  assert.equal(mock.requests[2].body.sha, 'first-sha');
  assert.equal(mock.requests[4].body.sha, 'second-sha');
});

test('does not downgrade a newer release after a conflict', async () => {
  const mock = api([
    { body: { default_branch: 'main' } },
    { body: remote(cask('1.1.0')) },
    { status: 409 },
    { body: remote(cask('1.3.0')) },
  ]);
  assert.equal((await run(mock)).status, 'newer');
  assert.equal(mock.requests.length, 4);
});

test('stops retrying after three conflicts', async () => {
  const mock = api([
    { body: { default_branch: 'main' } },
    ...Array.from({ length: 3 }, () => [{ body: remote(cask('1.1.0')) }, { status: 409 }]).flat(),
  ]);
  await assert.rejects(run(mock), /kept changing after 3 attempts/);
  assert.equal(mock.requests.filter((request) => request.method === 'PUT').length, 3);
});

test('creates a missing cask without a SHA', async () => {
  const mock = api([{ body: { default_branch: 'main' } }, { status: 404 }, { status: 201 }]);
  assert.equal((await run(mock)).status, 'updated');
  assert.equal(Object.hasOwn(mock.requests[2].body, 'sha'), false);
});

test('rechecks a concurrently created cask on HTTP 422', async () => {
  const mock = api([
    { body: { default_branch: 'main' } }, { status: 404 }, { status: 422 },
    { body: remote(cask('1.2.0')) },
  ]);
  assert.equal((await run(mock)).status, 'unchanged');
});

test('rejects invalid source casks before contacting GitHub', async () => {
  for (const content of [cask('1.2.0-beta.1'), cask('01.2.0'), cask('1.2.0', { arm: 'invalid' }), cask('1.2.0').replace('on_intel', 'on_arm')]) {
    const mock = api([]);
    await assert.rejects(run(mock, content), /cask must have/);
    assert.equal(mock.requests.length, 0);
  }
});

test('rejects invalid remote casks before writing', async () => {
  const mock = api([{ body: { default_branch: 'main' } }, { body: remote(cask('unknown')) }]);
  await assert.rejects(run(mock), /cask must have one stable/);
  assert.equal(mock.requests.length, 2);
});

test('requires a token and safe repository paths before contacting GitHub', async () => {
  for (const options of [{ token: '' }, { repo: '../tap' }, { filePath: '../fortin.rb' }, { filePath: '/Casks/fortin.rb' }]) {
    const mock = api([]);
    await assert.rejects(run(mock, cask('1.2.0'), options));
    assert.equal(mock.requests.length, 0);
  }
});

test('does not print API response bodies or request errors containing credentials', async () => {
  const mock = api([{ status: 403, body: { message: 'test-token private diagnostic' } }]);
  await assert.rejects(run(mock), { message: 'Read repository failed (HTTP 403)' });
  await assert.rejects(run(mock, cask('1.2.0'), {
    fetchImpl: async () => { throw new Error('test-token private diagnostic'); },
  }), { message: 'GitHub GET request failed' });
});

const execFileAsync = promisify(execFile);
async function git(args, cwd) {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

async function gitFixture(t, initial = cask('1.0.0')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fortin-cask-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin.git');
  const writer = path.join(directory, 'writer');
  const checkout = path.join(directory, 'checkout');
  await git(['init', '--bare', '--initial-branch=main', origin], directory);
  await git(['clone', origin, writer], directory);
  await git(['config', 'user.name', 'Test'], writer);
  await git(['config', 'user.email', 'test@example.invalid'], writer);
  async function publish(content, extraFile) {
    await git(['pull', '--ff-only', 'origin', 'main'], writer);
    await fs.writeFile(path.join(writer, 'Casks/fortin.rb'), content);
    if (extraFile) await fs.writeFile(path.join(writer, extraFile), 'another change\n');
    await git(['add', '.'], writer);
    await git(['commit', '-m', 'Concurrent change'], writer);
    await git(['push', 'origin', 'main'], writer);
  }
  await fs.mkdir(path.join(writer, 'Casks'));
  if (initial) await fs.writeFile(path.join(writer, 'Casks/fortin.rb'), initial);
  await fs.writeFile(path.join(writer, 'README.md'), 'Tap\n');
  await git(['add', '.'], writer);
  await git(['commit', '-m', 'Initial tap'], writer);
  await git(['push', 'origin', 'main'], writer);
  await git(['clone', origin, checkout], directory);
  return {
    checkout, writer, publish,
    run: (content = cask('1.2.0'), options = {}) => syncCaskCheckout({ checkout, filePath: 'Casks/fortin.rb', content, ...options }),
    remote: (file = 'Casks/fortin.rb') => git(['--git-dir', origin, 'show', `main:${file}`], directory),
  };
}

test('Git checkout creates and publishes the canonical cask with the bot author', async (t) => {
  const fixture = await gitFixture(t, null);
  assert.deepEqual(await fixture.run(), { status: 'updated', version: '1.2.0', branch: 'main' });
  assert.equal(await fixture.remote(), cask('1.2.0').trim());
  assert.equal(await git(['log', '-1', '--format=%an <%ae>'], fixture.checkout), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
  assert.equal(await git(['status', '--porcelain'], fixture.checkout), '');
});

test('Git checkout refreshes before deciding and skips identical or newer releases', async (t) => {
  const fixture = await gitFixture(t);
  await fixture.publish(cask('1.2.0'));
  assert.equal((await fixture.run()).status, 'unchanged');
  await fixture.publish(cask('1.3.0'));
  assert.equal((await fixture.run()).status, 'newer');
  assert.equal(await fixture.remote(), cask('1.3.0').trim());
});

test('Git checkout preserves released checksums while permitting canonical text updates', async (t) => {
  const fixture = await gitFixture(t, cask('1.2.0'));
  await assert.rejects(fixture.run(cask('1.2.0', { arm: 'c'.repeat(64) })), /refusing to change the checksums/);
  const updated = cask('1.2.0', { description: 'Updated description' });
  assert.equal((await fixture.run(updated)).status, 'updated');
  assert.equal(await fixture.remote(), updated.trim());
});

test('Git checkout retries rejected pushes without replacing concurrent changes', async (t) => {
  const fixture = await gitFixture(t);
  let pushes = 0;
  const result = await fixture.run(cask('1.2.0'), {
    runGit: async (args, cwd) => {
      if (args[0] === 'push' && pushes++ === 0) await fixture.publish(cask('1.1.0'), 'another-cask.rb');
      return git(args, cwd);
    },
  });
  assert.equal(result.status, 'updated');
  assert.equal(pushes, 2);
  assert.equal(await fixture.remote(), cask('1.2.0').trim());
  assert.equal(await fixture.remote('another-cask.rb'), 'another change');
});

test('Git checkout does not downgrade a release published during a rejected push', async (t) => {
  const fixture = await gitFixture(t);
  let pushes = 0;
  const result = await fixture.run(cask('1.2.0'), {
    runGit: async (args, cwd) => {
      if (args[0] === 'push' && pushes++ === 0) await fixture.publish(cask('1.3.0'));
      return git(args, cwd);
    },
  });
  assert.equal(result.status, 'newer');
  assert.equal(pushes, 1);
  assert.equal(await fixture.remote(), cask('1.3.0').trim());
  assert.equal(await git(['status', '--porcelain'], fixture.checkout), '');
});

test('Git checkout stops after three rejected pushes and discards only its own commits', async (t) => {
  const fixture = await gitFixture(t);
  let pushes = 0;
  await assert.rejects(fixture.run(cask('1.2.0'), {
    runGit: async (args, cwd) => {
      if (args[0] === 'push') await fixture.publish(cask(`1.0.${++pushes}`));
      return git(args, cwd);
    },
  }), /kept changing after 3 attempts/);
  assert.equal(pushes, 3);
  assert.equal(await fixture.remote(), cask('1.0.3').trim());
  assert.equal(await git(['log', '-1', '--format=%s'], fixture.checkout), 'Concurrent change');
  assert.equal(await git(['status', '--porcelain'], fixture.checkout), '');
});

test('Git checkout refuses to overwrite local work or publish unrelated local commits', async (t) => {
  const fixture = await gitFixture(t);
  const note = path.join(fixture.checkout, 'note.txt');
  await fs.writeFile(note, 'local work\n');
  await assert.rejects(fixture.run(), /clean working tree/);
  assert.equal(await fs.readFile(note, 'utf8'), 'local work\n');
  await git(['add', '.'], fixture.checkout);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Local work'], fixture.checkout);
  await assert.rejects(fixture.run(), /unpublished commits/);
  assert.equal(await fixture.remote(), cask('1.0.0').trim());
});

test('Git checkout reports authentication errors without leaking Git diagnostics', async (t) => {
  const fixture = await gitFixture(t);
  await assert.rejects(fixture.run(cask('1.2.0'), {
    runGit: async (args, cwd) => {
      if (args[0] === 'push') throw Object.assign(new Error('private diagnostic'), { stderr: 'private-token' });
      return git(args, cwd);
    },
  }), { message: 'git push failed' });
});
