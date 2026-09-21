#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_SOURCE = path.join(ROOT, 'packaging/homebrew/Casks/fortin.rb');
const API = 'https://api.github.com';
const ATTEMPTS = 3;
const execFileAsync = promisify(execFile);

const USAGE = `usage: node scripts/sync-cask.mjs (--repo OWNER/REPO | --checkout DIR) --path PATH [--source FILE]

  --repo OWNER/REPO  repository whose default branch receives the cask
  --checkout DIR     clean, temporary Git checkout of the target branch
  --path PATH        cask path in that repository
  --source FILE      local cask (default: packaging/homebrew/Casks/fortin.rb)
  -h, --help         print this text

--repo requires GH_TOKEN with Contents write access to the target repository.
--checkout uses the checkout's existing Git authentication and pushes to origin.`;

function caskMetadata(content) {
  if (!/^cask "fortin" do$/m.test(content)) throw new Error('expected a Fortin cask');
  const versions = [...content.matchAll(/^\s*version "([^"]+)"\s*$/gm)];
  const version = versions[0]?.[1];
  if (versions.length !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('the cask must have one stable X.Y.Z version');
  }

  const checksums = new Map();
  let block = null;
  for (const line of content.split('\n')) {
    const opening = /^\s*on_(arm|intel) do\s*$/.exec(line);
    if (opening) block = opening[1];
    if (/^\s*end\s*$/.test(line)) block = null;
    if (!/^\s*sha256\s/.test(line)) continue;
    const checksum = /^\s*sha256 "([a-fA-F0-9]{64})"\s*$/.exec(line);
    if (!block || !checksum || checksums.has(block)) {
      throw new Error('the cask must have one SHA-256 for each architecture');
    }
    checksums.set(block, checksum[1].toLowerCase());
  }
  if (!checksums.has('arm') || !checksums.has('intel')) {
    throw new Error('the cask must have one SHA-256 for each architecture');
  }
  return { version, checksums };
}

function compareVersions(left, right) {
  const rightParts = right.split('.').map(BigInt);
  const leftParts = left.split('.').map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function validateFilePath(filePath) {
  if (!filePath || filePath.startsWith('/') || filePath.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\\\x00-\x1f\x7f]/.test(filePath) || filePath.split('/').some((part) => part.toLowerCase() === '.git')) {
    throw new Error('--path must be a relative repository file path');
  }
}

function existingCaskResult(remoteContent, content, local, branch) {
  const remote = caskMetadata(remoteContent);
  const comparison = compareVersions(remote.version, local.version);
  if (comparison > 0) return { status: 'newer', version: remote.version, branch };
  if (remoteContent === content) return { status: 'unchanged', version: local.version, branch };
  if (comparison === 0 && ['arm', 'intel'].some((arch) => remote.checksums.get(arch) !== local.checksums.get(arch))) {
    throw new Error(`refusing to change the checksums of released version ${local.version}`);
  }
  return null;
}

/** Update one cask without replacing a newer release or changing released hashes. */
export async function syncCask({ repo, filePath, content, token = process.env.GH_TOKEN, fetchImpl = fetch }) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo ?? '')
    || repo.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('--repo must be OWNER/REPO');
  }
  validateFilePath(filePath);
  const local = caskMetadata(content);
  if (!token?.trim()) throw new Error('GH_TOKEN is required');

  async function request(method, endpoint, body) {
    let response;
    try {
      response = await fetchImpl(`${API}${endpoint}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fortin-cask-sync',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`GitHub ${method} request failed`);
    }
    return response;
  }

  async function jsonResponse(response, operation) {
    if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status})`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${operation} returned invalid JSON`);
    }
  }

  const repository = await jsonResponse(await request('GET', `/repos/${repo}`), 'Read repository');
  const branch = repository.default_branch;
  if (typeof branch !== 'string' || !branch) throw new Error('the repository has no default branch');
  const endpoint = `/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const response = await request('GET', `${endpoint}?ref=${encodeURIComponent(branch)}`);
    let sha;
    if (response.status !== 404) {
      const remoteFile = await jsonResponse(response, 'Read remote cask');
      if (remoteFile.type !== 'file' || remoteFile.encoding !== 'base64'
        || typeof remoteFile.content !== 'string' || typeof remoteFile.sha !== 'string' || !remoteFile.sha) {
        throw new Error('the remote cask is not a base64-encoded file with a SHA');
      }
      sha = remoteFile.sha;
      const remoteContent = Buffer.from(remoteFile.content, 'base64').toString('utf8');
      const result = existingCaskResult(remoteContent, content, local, branch);
      if (result) return result;
    }

    const updated = await request('PUT', endpoint, {
      message: `Update Fortin cask to ${local.version}`,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    });
    if (updated.ok) return { status: 'updated', version: local.version, branch };
    // A create can return 422 if another run created the same path meanwhile.
    // Reading again also prevents an older run from overwriting a newer cask.
    if (updated.status === 409 || (updated.status === 422 && !sha)) {
      if (attempt + 1 < ATTEMPTS) continue;
      throw new Error(`the remote cask kept changing after ${ATTEMPTS} attempts`);
    }
    throw new Error(`Update remote cask failed (HTTP ${updated.status})`);
  }
}

async function executeGit(args, cwd) {
  return (await execFileAsync('git', args, {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8',
  })).stdout.trim();
}

/** Publish through an isolated checkout whose origin already has write authentication. */
export async function syncCaskCheckout({ checkout, filePath, content, runGit = executeGit }) {
  validateFilePath(filePath);
  const local = caskMetadata(content);
  const directory = await fs.realpath(checkout);
  async function git(args) {
    try {
      return await runGit(args, directory);
    } catch (error) {
      // Git diagnostics may include authenticated remote URLs. Never surface them.
      const failure = new Error(`git ${args[0]} failed`);
      failure.conflict = args[0] === 'push' && /\[rejected\].*(?:fetch first|non-fast-forward)/.test(`${error.stdout}\n${error.stderr}`);
      throw failure;
    }
  }
  async function requireClean() {
    if (await git(['status', '--porcelain'])) throw new Error('the target checkout must have a clean working tree');
  }
  if (await fs.realpath(await git(['rev-parse', '--show-toplevel'])) !== directory) {
    throw new Error('--checkout must be the root of the target repository');
  }
  const branch = await git(['symbolic-ref', '--short', 'HEAD']);
  await requireClean();
  async function refresh() {
    await git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
    await git(['merge', '--ff-only', 'FETCH_HEAD']);
    if (await git(['rev-parse', 'HEAD']) !== await git(['rev-parse', 'FETCH_HEAD'])) {
      throw new Error('the target checkout must not contain unpublished commits');
    }
  }
  await refresh();

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    await requireClean();
    const destination = path.join(directory, filePath);
    // Reject symlinks in the target path before reading or writing outside the checkout.
    let current = directory;
    for (const component of filePath.split('/')) {
      current = path.join(current, component);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('the cask path must not contain symlinks');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      const result = existingCaskResult(await fs.readFile(destination, 'utf8'), content, local, branch);
      if (result) return result;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const previousHead = await git(['rev-parse', 'HEAD']);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
    await git(['add', '--', filePath]);
    await git([
      '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', `Update Fortin cask to ${local.version}`, '--', filePath,
    ]);
    const ownCommit = await git(['rev-parse', 'HEAD']);
    try {
      await git(['push', '--porcelain', 'origin', `HEAD:refs/heads/${branch}`]);
      return { status: 'updated', version: local.version, branch };
    } catch (error) {
      if (!error.conflict) throw error;
      await requireClean();
      if (await git(['rev-parse', 'HEAD']) !== ownCommit) throw new Error('the target checkout changed during publication');
      await git(['reset', '--hard', previousHead]);
      if (attempt + 1 === ATTEMPTS) throw new Error(`the remote cask kept changing after ${ATTEMPTS} attempts`);
      await refresh();
    }
  }
}

async function main(argv) {
  const options = { source: DEFAULT_SOURCE };
  const names = { '--repo': 'repo', '--checkout': 'checkout', '--path': 'filePath', '--source': 'source' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    if (!names[argument]) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value`);
    options[names[argument]] = value;
    index += 1;
  }
  if (Boolean(options.repo) === Boolean(options.checkout)) throw new Error('use exactly one of --repo or --checkout');
  const content = await fs.readFile(options.source, 'utf8');
  const result = await (options.checkout ? syncCaskCheckout : syncCask)({ ...options, content });
  process.stdout.write(`${options.repo ?? options.checkout}/${options.filePath}: ${result.status} (Fortin ${result.version})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sync-cask: ${error.message}\n`);
    process.exitCode = 1;
  });
}
