#!/usr/bin/env node
/**
 * Keeps the Homebrew cask in step with a build.
 *
 * The cask names a version and two disk images, and Homebrew checks each
 * download against the sha256 that sits next to it. Both values only exist
 * after a build, so this tool reads the version of package.json, hashes the
 * disk images of that version and writes the result into the cask.
 *
 *   node scripts/update-cask.mjs                  # dist/ and the cask of this repository
 *   node scripts/update-cask.mjs --dist out       # another build directory
 *   node scripts/update-cask.mjs --check          # report only, for a pipeline
 *
 * A missing disk image or an unexpected cask fails before anything is
 * written, and the file is replaced in one step, so a half updated cask never
 * reaches the tap.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CASK = path.join(ROOT, 'packaging', 'homebrew', 'Casks', 'fortin.rb');

/** The two blocks of the cask and the image each one installs. */
const ARCHES = [
  { block: 'on_arm', image: (version) => `Fortin-${version}-arm64.dmg` },
  { block: 'on_intel', image: (version) => `Fortin-${version}-x64.dmg` },
];

const USAGE = `usage: node scripts/update-cask.mjs [--dist DIR] [--check]

  --dist DIR   directory that holds the disk images of the build (default: dist)
  --check      write nothing and exit 1 when the cask does not match the images
  -h, --help   print this text`;

function fail(message) {
  process.stderr.write(`update-cask: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { dist: path.join(ROOT, 'dist'), check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--check') options.check = true;
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (argument === '--dist') {
      const value = argv[i + 1];
      if (!value) fail('--dist needs a directory');
      options.dist = path.resolve(value);
      i += 1;
    } else fail(`unknown argument: ${argument}`);
  }
  return options;
}

/** The sha256 of a file, read in chunks so a disk image never lands in memory. */
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function versionOfPackage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.version) fail('package.json carries no version');
  return pkg.version;
}

/**
 * Index of the sha256 line of each block. A checksum belongs to the block
 * that opens above it, so the block is left behind as soon as one is found and
 * a checksum outside any block is an error, not a guess.
 */
function checksumLines(lines) {
  const found = new Map();
  let block = null;
  lines.forEach((line, index) => {
    const open = /^\s*on_(arm|intel) do\s*$/.exec(line);
    if (open) block = `on_${open[1]}`;
    if (!/^\s*sha256\s/.test(line)) return;
    if (!block) fail(`the sha256 of line ${index + 1} belongs to no block`);
    if (found.has(block)) fail(`the ${block} block carries two checksums`);
    found.set(block, index);
    block = null;
  });
  return found;
}

/** The cask text with the version and the two checksums of this build. */
function withBuild(text, version, digests) {
  const lines = text.split('\n');
  const at = checksumLines(lines);
  for (const { block } of ARCHES) {
    if (!at.has(block)) fail(`the cask carries no ${block} block with a sha256 line`);
  }

  const versionLine = lines.findIndex((line) => /^\s*version\s+"/.test(line));
  if (versionLine === -1) fail('the cask carries no version line');
  lines[versionLine] = lines[versionLine].replace(/"([^"]*)"/, `"${version}"`);

  for (const { block } of ARCHES) {
    const index = at.get(block);
    const indent = /^\s*/.exec(lines[index])[0];
    lines[index] = `${indent}sha256 "${digests.get(block)}"`;
  }
  return lines.join('\n');
}

const options = parseArguments(process.argv.slice(2));
const version = versionOfPackage();
const current = fs.readFileSync(CASK, 'utf8');

const digests = new Map();
const images = [];
for (const { block, image } of ARCHES) {
  const file = path.join(options.dist, image(version));
  if (!fs.existsSync(file)) {
    fail(`${image(version)} is not in ${options.dist}: build it with npm run dist:mac`);
  }
  const digest = await sha256(file);
  digests.set(block, digest);
  images.push({ block, name: path.basename(file), digest });
}

const updated = withBuild(current, version, digests);

for (const { block, name, digest } of images) {
  process.stdout.write(`${block.padEnd(9)} ${name}  ${digest}\n`);
}

if (updated === current) {
  process.stdout.write(`Fortin ${version}: the cask already matches these images\n`);
  process.exit(0);
}

if (options.check) {
  process.stderr.write(`update-cask: the cask does not match the images of ${version}\n`);
  process.exit(1);
}

// One replacement: the tap never sees a cask that names one wheel and two
// checksums of the other.
const temporary = `${CASK}.${process.pid}.tmp`;
fs.writeFileSync(temporary, updated);
fs.renameSync(temporary, CASK);
process.stdout.write(`Fortin ${version}: cask updated, ${path.relative(ROOT, CASK)}\n`);
