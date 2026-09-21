#!/usr/bin/env node
/** Release phases used by CI. Authentication comes only from GH_TOKEN. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;

export function compareVersions(left, right) {
  if (!STABLE.test(left) || !STABLE.test(right)) throw new Error('Versions must use stable X.Y.Z format');
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function assetNames(version) {
  return ['arm64', 'x64'].flatMap((arch) => ['dmg', 'zip'].map((extension) => `Fortin-${version}-${arch}.${extension}`));
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function createReleaseTools({ cwd = process.cwd(), env = process.env, run = spawnSync } = {}) {
  function command(binary, args, input) {
    const result = run(binary, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    if (result.error) throw new Error(`Could not run ${binary}: ${result.error.code || 'process failed'}`);
    return result;
  }

  function git(args) {
    const result = command('git', args);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed; checkout must include the push's previous commit`);
    return result.stdout.trim();
  }

  function context(remote = false) {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
    if (!STABLE.test(pkg.version)) throw new Error('package.json version must use stable X.Y.Z format');
    if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
      throw new Error('package-lock.json must carry the same version as package.json');
    }
    const sha = env.GITHUB_SHA;
    if (!SHA.test(sha || '') || git(['rev-parse', 'HEAD']) !== sha) throw new Error('Checkout HEAD must equal GITHUB_SHA');
    const repo = env.GITHUB_REPOSITORY;
    if (remote && (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !env.GH_TOKEN)) {
      throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
    }
    return { version: pkg.version, tag: `v${pkg.version}`, sha, repo };
  }

  function output(values) {
    if (env.GITHUB_OUTPUT) {
      fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
    }
    return values;
  }

  function api(endpoint, { method = 'GET', body, missing = false } = {}) {
    const args = ['api', endpoint, '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
    if (body !== undefined) args.push('--input', '-');
    const result = command('gh', args, body === undefined ? undefined : JSON.stringify(body));
    let data;
    try { data = JSON.parse(result.stdout); } catch { /* CLI transport failures need not contain JSON. */ }
    if (result.status !== 0) {
      const status = String(data?.status || /HTTP (\d{3})/.exec(result.stderr || '')?.[1] || 'unknown');
      if (missing && method === 'GET' && status === '404') return null;
      throw new Error(`GitHub API ${method} ${endpoint} failed (HTTP ${status})`);
    }
    if (data === undefined) throw new Error(`GitHub API returned invalid JSON for ${endpoint}`);
    return data;
  }

  function tagCommit(info) {
    const ref = api(`repos/${info.repo}/git/ref/tags/${info.tag}`, { missing: true });
    if (!ref) return null;
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 10; depth += 1) {
      if (!SHA.test(object.sha)) throw new Error('Tag has an invalid object SHA');
      object = api(`repos/${info.repo}/git/tags/${object.sha}`).object;
    }
    if (object?.type !== 'commit' || !SHA.test(object.sha)) throw new Error('Tag does not resolve to a commit');
    return object.sha;
  }

  function validateAssets(release, names, { complete = true } = {}) {
    const assets = release.assets || [];
    if (assets.some((asset) => !names.includes(asset.name))) throw new Error('Release contains unexpected assets');
    for (const name of names) {
      const matches = assets.filter((asset) => asset.name === name);
      if (matches.length > 1 || (complete && matches.length !== 1)) throw new Error(`Release needs exactly one ${name}`);
      if (complete && (matches[0].state !== 'uploaded' || matches[0].size <= 0)) throw new Error(`Release asset ${name} is incomplete`);
    }
  }

  function inspectState(info) {
    const commit = tagCommit(info);
    let release = api(`repos/${info.repo}/releases/tags/${info.tag}`, { missing: true });
    // The tag endpoint only finds published releases. Listing also finds a
    // draft left by a failed upload, including one without a Git tag yet.
    for (let page = 1; !release; page += 1) {
      const releases = api(`repos/${info.repo}/releases?per_page=100&page=${page}`);
      release = releases.find((entry) => entry.tag_name === info.tag) || null;
      if (releases.length < 100) break;
    }
    if (commit && commit !== info.sha) throw new Error(`${info.tag} already points to a different commit`);
    if (release) {
      if (release.tag_name !== info.tag || release.prerelease) throw new Error('Existing release is not the expected stable release');
      if (!commit && (!release.draft || release.target_commitish !== info.sha)) {
        throw new Error('Existing release does not identify the expected commit');
      }
      validateAssets(release, [...assetNames(info.version), 'SHA256SUMS'], { complete: !release.draft });
    }
    return { commit, release, published: Boolean(release && !release.draft) };
  }

  function plan() {
    const info = context();
    if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required');
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (event.ref !== 'refs/heads/main' || event.deleted || event.after !== info.sha) {
      throw new Error('Release planning requires a push to main at GITHUB_SHA');
    }
    if (!SHA.test(event.before || '')) throw new Error('Push event is missing its previous commit');
    let changed = true;
    if (!/^0{40}$/.test(event.before)) {
      const previous = JSON.parse(git(['show', `${event.before}:package.json`])).version;
      const comparison = compareVersions(info.version, previous);
      if (comparison < 0) throw new Error('package.json version must increase');
      changed = comparison > 0;
    }
    return output({ changed, version: info.version, tag: info.tag });
  }

  function inspect() {
    const info = context(true);
    return output({ published: inspectState(info).published, version: info.version, tag: info.tag });
  }

  async function publish() {
    const info = context(true);
    const state = inspectState(info);
    if (state.published) return output({ published: true, version: info.version, tag: info.tag });
    const dist = path.join(cwd, 'dist');
    const names = assetNames(info.version);
    const sums = [];
    for (const name of names) {
      const file = path.join(dist, name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`Missing build asset: ${name}`);
      sums.push(`${await sha256(file)}  ${name}\n`);
    }
    fs.writeFileSync(path.join(dist, 'SHA256SUMS'), sums.join(''));
    names.push('SHA256SUMS');
    if (!state.commit) {
      api(`repos/${info.repo}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${info.tag}`, sha: info.sha } });
    }
    const release = state.release || api(`repos/${info.repo}/releases`, {
      method: 'POST',
      body: { tag_name: info.tag, target_commitish: info.sha, name: `Fortin ${info.version}`, draft: true, prerelease: false, generate_release_notes: true },
    });
    const upload = command('gh', ['release', 'upload', info.tag, ...names.map((name) => path.join(dist, name)), '--repo', info.repo, '--clobber']);
    if (upload.status !== 0) throw new Error('Release upload failed; the draft can be retried');
    const uploaded = api(`repos/${info.repo}/releases/${release.id}`);
    if (!uploaded.draft) throw new Error('Release was published while uploading; refusing to modify it');
    if (tagCommit(info) !== info.sha) throw new Error('Release tag changed while uploading');
    validateAssets(uploaded, names);
    for (const asset of uploaded.assets) {
      if (asset.digest && asset.digest !== `sha256:${await sha256(path.join(dist, asset.name))}`) {
        throw new Error(`Uploaded asset checksum differs: ${asset.name}`);
      }
    }
    // CI serializes publication across versions, so the comparison remains
    // valid until publication and an older retry cannot replace latest.
    const latest = api(`repos/${info.repo}/releases/latest`, { missing: true });
    const latestVersion = latest?.tag_name?.replace(/^v/, '');
    const makeLatest = !latest || (STABLE.test(latestVersion) && compareVersions(info.version, latestVersion) >= 0);
    const published = api(`repos/${info.repo}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: String(makeLatest) } });
    if (published.draft !== false) throw new Error('GitHub did not publish the release');
    return output({ published: true, version: info.version, tag: info.tag });
  }

  async function download() {
    const info = context(true);
    const state = inspectState(info);
    if (!state.published) throw new Error('Homebrew requires a published release');
    const dist = path.join(cwd, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(dist, '.release-'));
    const images = assetNames(info.version).filter((name) => name.endsWith('.dmg'));
    try {
      const args = ['release', 'download', info.tag, '--repo', info.repo, '--dir', temporary];
      for (const name of [...images, 'SHA256SUMS']) args.push('--pattern', name);
      if (command('gh', args).status !== 0) throw new Error('Could not download the published release assets');
      const manifest = fs.readFileSync(path.join(temporary, 'SHA256SUMS'), 'utf8').trim().split('\n');
      const expected = new Map();
      for (const line of manifest) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        if (!match || expected.has(match[2]) || !assetNames(info.version).includes(match[2])) throw new Error('Invalid SHA256SUMS manifest');
        expected.set(match[2], match[1]);
      }
      if (expected.size !== 4) throw new Error('SHA256SUMS must describe all four build assets');
      for (const name of [...images, 'SHA256SUMS']) {
        const digest = await sha256(path.join(temporary, name));
        const asset = state.release.assets.find((entry) => entry.name === name);
        if ((name !== 'SHA256SUMS' && expected.get(name) !== digest) || (asset.digest && asset.digest !== `sha256:${digest}`)) {
          throw new Error(`Published asset checksum differs: ${name}`);
        }
      }
      for (const name of images) fs.renameSync(path.join(temporary, name), path.join(dist, name));
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    return output({ version: info.version, tag: info.tag });
  }

  return { plan, inspect, publish, download };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const phase = process.argv[2];
    if (process.argv.length !== 3 || !['plan', 'inspect', 'publish', 'download'].includes(phase)) {
      throw new Error('usage: node scripts/release.mjs plan|inspect|publish|download');
    }
    const result = await createReleaseTools()[phase]();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`release: ${error.message}\n`);
    process.exitCode = 1;
  }
}
