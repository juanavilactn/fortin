import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assetNames, createReleaseTools } from '../scripts/release.mjs';

const HEAD = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const VERSION = '1.2.3';
const TAG = `v${VERSION}`;
const REPO = 'example/fortin';
const hash = (content) => createHash('sha256').update(content).digest('hex');
const ok = (data) => ({ status: 0, stdout: JSON.stringify(data), stderr: '' });
const missing = () => ({ status: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)' });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fortin-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, data) => fs.writeFileSync(path.join(root, name), typeof data === 'object' ? JSON.stringify(data) : data);
  write('package.json', { version: options.version || VERSION });
  write('package-lock.json', { version: options.version || VERSION, packages: { '': { version: options.version || VERSION } } });
  write('event.json', { ref: 'refs/heads/main', before: BEFORE, after: HEAD });
  fs.mkdirSync(path.join(root, 'dist'));
  const calls = [];
  const remote = { tag: null, release: null, files: new Map(), failUpload: false, corruptUpload: false, corruptDownload: false };
  const env = { GITHUB_SHA: HEAD, GITHUB_REPOSITORY: REPO, GH_TOKEN: 'synthetic-test-token', GITHUB_EVENT_PATH: path.join(root, 'event.json'), GITHUB_OUTPUT: path.join(root, 'output') };
  const assets = () => [...remote.files].map(([name, bytes]) => ({ name, state: 'uploaded', size: bytes.length, digest: `sha256:${hash(bytes)}` }));

  function run(binary, args, commandOptions) {
    calls.push({ binary, args, input: commandOptions.input });
    assert.equal(commandOptions.cwd, root);
    assert.equal(args.some((arg) => arg.includes(env.GH_TOKEN)), false, 'authentication never appears in arguments');
    if (binary === 'git') {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n` };
      assert.deepEqual(args, ['show', `${BEFORE}:package.json`], 'the full push is compared against event.before');
      return ok({ version: options.previous || '1.2.2' });
    }
    assert.equal(binary, 'gh');
    if (args[0] === 'release' && args[1] === 'upload') {
      assert.equal(remote.release.draft, true, 'no assets are overwritten after publication');
      if (remote.failUpload) return { status: 1, stdout: '', stderr: 'upload failed' };
      assert.equal(args[2], TAG);
      assert.deepEqual(args.slice(-3), ['--repo', REPO, '--clobber']);
      for (const file of args.slice(3, -3)) remote.files.set(path.basename(file), fs.readFileSync(file));
      if (remote.corruptUpload) remote.files.set(assetNames(VERSION)[0], Buffer.from('damaged upload'));
      remote.release.assets = assets();
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const directory = args[args.indexOf('--dir') + 1];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] !== '--pattern') continue;
        const name = args[++i];
        assert.equal(remote.files.has(name), true);
        const content = remote.corruptDownload && name.endsWith('.dmg') ? 'damaged download' : remote.files.get(name);
        fs.writeFileSync(path.join(directory, name), content);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    assert.equal(args[0], 'api');
    const endpoint = args[1].replace(`repos/${REPO}/`, '');
    const method = args[args.indexOf('--method') + 1];
    const body = commandOptions.input ? JSON.parse(commandOptions.input) : undefined;
    if (options.forbidden) return { status: 1, stdout: '{"status":"403"}', stderr: 'gh: Forbidden (HTTP 403)' };
    if (method === 'GET') {
      if (endpoint === `git/ref/tags/${TAG}`) return remote.tag ? ok({ object: remote.tag }) : missing();
      if (endpoint.startsWith('git/tags/')) return ok({ object: remote.annotatedTarget });
      // GitHub's tag lookup does not return drafts. They must be found in the list.
      if (endpoint === `releases/tags/${TAG}`) return remote.release && !remote.release.draft ? ok(remote.release) : missing();
      if (endpoint === 'releases?per_page=100&page=1') return ok(remote.release ? [remote.release] : []);
      if (endpoint === 'releases/10') return ok(remote.release);
      if (endpoint === 'releases/latest') return options.latest ? ok({ tag_name: options.latest }) : missing();
    }
    if (method === 'POST' && endpoint === 'git/refs') {
      assert.deepEqual(body, { ref: `refs/tags/${TAG}`, sha: HEAD });
      remote.tag = { type: 'commit', sha: body.sha };
      return ok({ object: remote.tag });
    }
    if (method === 'POST' && endpoint === 'releases') {
      assert.equal(remote.release, null, 'a retry must reuse its draft');
      assert.equal(body.target_commitish, HEAD);
      assert.equal(body.draft, true);
      assert.equal(body.generate_release_notes, true);
      remote.release = { ...body, id: 10, assets: [] };
      return ok(remote.release);
    }
    if (method === 'PATCH' && endpoint === 'releases/10') {
      assert.equal(body.draft, false);
      assert.equal(['true', 'false'].includes(body.make_latest), true);
      assert.deepEqual(remote.release.assets.map((asset) => asset.name).sort(), [...assetNames(VERSION), 'SHA256SUMS'].sort());
      Object.assign(remote.release, body);
      return ok(remote.release);
    }
    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  }

  function build() {
    for (const name of assetNames(VERSION)) write(`dist/${name}`, `bytes of ${name}`);
    write('dist/unwanted.blockmap', 'must not be uploaded');
  }

  return { root, write, remote, calls, env, build, tools: createReleaseTools({ cwd: root, env, run }) };
}

test('plan compares both ends of a push and writes workflow outputs', (t) => {
  const box = fixture(t);
  assert.deepEqual(box.tools.plan(), { changed: true, version: VERSION, tag: TAG });
  assert.equal(fs.readFileSync(box.env.GITHUB_OUTPUT, 'utf8'), `changed=true\nversion=${VERSION}\ntag=${TAG}\n`);
  assert.equal(box.calls.every((call) => call.binary === 'git'), true, 'planning uses no GitHub credentials or API');
});

test('same version is a no-op even when other files changed', (t) => {
  const box = fixture(t, { previous: VERSION });
  assert.equal(box.tools.plan().changed, false);
});

test('first main push plans its initial version without reading a nonexistent commit', (t) => {
  const box = fixture(t);
  box.write('event.json', { ref: 'refs/heads/main', before: '0'.repeat(40), after: HEAD });
  assert.equal(box.tools.plan().changed, true);
  assert.equal(box.calls.some((call) => call.args[0] === 'show'), false);
});

test('invalid versions, downgrades and lockfile drift fail before release work', (t) => {
  const prerelease = fixture(t, { version: '1.2.3-beta.1' });
  assert.throws(() => prerelease.tools.plan(), /stable X.Y.Z/);
  const downgrade = fixture(t, { previous: '1.3.0' });
  assert.throws(() => downgrade.tools.plan(), /must increase/);
  const lock = fixture(t);
  lock.write('package-lock.json', { version: VERSION, packages: { '': { version: '1.2.2' } } });
  assert.throws(() => lock.tools.plan(), /same version/);
});

test('plan rejects a different checkout, non-main events and missing push history', (t) => {
  const box = fixture(t);
  box.env.GITHUB_SHA = BEFORE;
  assert.throws(() => box.tools.plan(), /HEAD must equal/);
  box.env.GITHUB_SHA = HEAD;
  box.write('event.json', { ref: 'refs/heads/feature', before: BEFORE, after: HEAD });
  assert.throws(() => box.tools.plan(), /push to main/);
  box.write('event.json', { ref: 'refs/heads/main', after: HEAD });
  assert.throws(() => box.tools.plan(), /previous commit/);
});

test('inspect rejects both lightweight and annotated tags at another commit', (t) => {
  const box = fixture(t);
  box.remote.tag = { type: 'commit', sha: BEFORE };
  assert.throws(() => box.tools.inspect(), /different commit/);
  box.remote.tag = { type: 'tag', sha: 'c'.repeat(40) };
  box.remote.annotatedTarget = { type: 'commit', sha: BEFORE };
  assert.throws(() => box.tools.inspect(), /different commit/);
  box.remote.annotatedTarget.sha = HEAD;
  assert.equal(box.tools.inspect().published, false);
});

test('GitHub authentication failures are not mistaken for absent releases', async (t) => {
  const box = fixture(t, { forbidden: true });
  await assert.rejects(box.tools.publish(), /HTTP 403/);
  assert.equal(box.remote.tag, null);
  assert.equal(box.remote.release, null);
});

test('missing build assets fail before creating a remote tag or draft', async (t) => {
  const box = fixture(t);
  await assert.rejects(box.tools.publish(), /Missing build asset/);
  assert.equal(box.remote.tag, null);
  assert.equal(box.remote.release, null);
});

test('publish pins the commit and publishes only complete DMG, ZIP and checksum assets', async (t) => {
  const box = fixture(t);
  box.build();
  assert.deepEqual(await box.tools.publish(), { published: true, version: VERSION, tag: TAG });
  assert.equal(box.remote.tag.sha, HEAD);
  assert.equal(box.remote.release.draft, false);
  const manifest = box.remote.files.get('SHA256SUMS').toString();
  for (const name of assetNames(VERSION)) assert.equal(manifest.includes(`${hash(box.remote.files.get(name))}  ${name}\n`), true);
  assert.equal(box.remote.files.has('unwanted.blockmap'), false);
  assert.equal(box.remote.release.make_latest, 'true');
});

test('publishing an older retried version does not replace a newer latest release', async (t) => {
  const box = fixture(t, { latest: 'v2.0.0' });
  box.build();
  await box.tools.publish();
  assert.equal(box.remote.release.make_latest, 'false');
});

test('a failed upload leaves a resumable draft found through release listing', async (t) => {
  const box = fixture(t);
  box.build();
  box.remote.failUpload = true;
  await assert.rejects(box.tools.publish(), /draft can be retried/);
  assert.equal(box.remote.release.draft, true);
  box.remote.failUpload = false;
  await box.tools.publish();
  assert.equal(box.remote.release.draft, false);
  assert.equal(box.calls.filter((call) => call.args[1] === `repos/${REPO}/releases` && call.args.includes('POST')).length, 1);
});

test('uploaded checksum failures leave the release unpublished', async (t) => {
  const box = fixture(t);
  box.build();
  box.remote.corruptUpload = true;
  await assert.rejects(box.tools.publish(), /Uploaded asset checksum differs/);
  assert.equal(box.remote.release.draft, true);
});

test('a published release is never rebuilt or overwritten on retry', async (t) => {
  const box = fixture(t);
  box.build();
  await box.tools.publish();
  fs.rmSync(path.join(box.root, 'dist'), { recursive: true });
  box.calls.length = 0;
  assert.equal(box.tools.inspect().published, true);
  assert.equal((await box.tools.publish()).published, true);
  assert.equal(box.calls.some((call) => call.args[0] === 'release' || call.args.includes('POST') || call.args.includes('PATCH')), false);
});

test('inspect refuses incomplete public releases and drafts for another commit', async (t) => {
  const box = fixture(t);
  box.remote.release = { id: 10, tag_name: TAG, target_commitish: BEFORE, draft: true, assets: [] };
  assert.throws(() => box.tools.inspect(), /expected commit/);
  box.remote.release = null;
  box.build();
  await box.tools.publish();
  box.remote.release.assets.pop();
  assert.throws(() => box.tools.inspect(), /exactly one SHA256SUMS/);
});

test('download installs only verified published DMGs for the Homebrew step', async (t) => {
  const box = fixture(t);
  box.build();
  await box.tools.publish();
  fs.rmSync(path.join(box.root, 'dist'), { recursive: true });
  await box.tools.download();
  const names = fs.readdirSync(path.join(box.root, 'dist')).sort();
  assert.deepEqual(names, assetNames(VERSION).filter((name) => name.endsWith('.dmg')).sort());
  for (const name of names) assert.deepEqual(fs.readFileSync(path.join(box.root, 'dist', name)), box.remote.files.get(name));
});

test('download detects corruption using SHA256SUMS even without GitHub asset digests', async (t) => {
  const box = fixture(t);
  box.build();
  await box.tools.publish();
  for (const asset of box.remote.release.assets) asset.digest = null;
  fs.rmSync(path.join(box.root, 'dist'), { recursive: true });
  box.remote.corruptDownload = true;
  await assert.rejects(box.tools.download(), /Published asset checksum differs/);
  assert.deepEqual(fs.readdirSync(path.join(box.root, 'dist')), []);
  box.remote.corruptDownload = false;
  await box.tools.download();
});

test('download refuses drafts before downloading or altering local files', async (t) => {
  const box = fixture(t);
  box.remote.release = { id: 10, tag_name: TAG, target_commitish: HEAD, draft: true, assets: [] };
  await assert.rejects(box.tools.download(), /published release/);
  assert.equal(box.calls.some((call) => call.args[0] === 'release'), false);
});
