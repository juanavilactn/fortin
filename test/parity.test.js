/**
 * The window and the terminal answer the same core.
 *
 * src/core/api.js is the table of the contract: every operation with the
 * channel the window uses for it and the command the terminal uses. This test
 * reads the channel lists of src/main/preload.cjs (the bridge the renderer
 * sees) and fails when a channel is in neither list, when a channel is in both
 * of them, or when a command of the table does not exist in src/cli.js.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EVENTS, OPERATIONS, WINDOW_ONLY_CHANNELS, WINDOW_ONLY_EVENTS } from '../src/core/api.js';
import { CLI_COMMANDS } from '../src/cli.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PRELOAD_FILE = path.join(REPO_ROOT, 'src', 'main', 'preload.cjs');

/**
 * The literal array of a `const NAME = [...]` of the preload, as text. The preload
 * is CommonJS and the only file outside the module graph, so it is read and not
 * imported. An empty or missing list fails here instead of silently passing.
 */
function literalList(source, name) {
  const declaration = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(source);
  assert.ok(declaration, `src/main/preload.cjs does not declare ${name}`);

  const values = [...declaration[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  assert.ok(values.length > 0, `${name} is empty in src/main/preload.cjs`);
  return values;
}

const preloadSource = fs.readFileSync(PRELOAD_FILE, 'utf8');
const preloadInvokeChannels = literalList(preloadSource, 'INVOKE_CHANNELS');
const preloadEventChannels = literalList(preloadSource, 'EVENT_CHANNELS');

const operationsWithChannel = OPERATIONS.filter((operation) => operation.ipc !== null);
const operationChannels = operationsWithChannel.map((operation) => operation.ipc);
const windowOnlyChannels = Object.keys(WINDOW_ONLY_CHANNELS);
const eventChannels = EVENTS.map((event) => event.ipc);
const windowOnlyEvents = Object.keys(WINDOW_ONLY_EVENTS);

/** The entry of CLI_COMMANDS a command name of the table resolves to, or null. */
function cliEntry(command) {
  const [name, subcommand] = String(command).split(' ');
  const entry = CLI_COMMANDS[name];
  if (!entry) return null;
  if (subcommand === undefined) return typeof entry.run === 'function' ? entry : null;
  const nested = entry.subcommands?.[subcommand];
  return typeof nested?.run === 'function' ? nested : null;
}

test('every invoke channel of the window is an operation with a terminal command, or a window only channel', () => {
  const covered = new Set([...operationChannels, ...windowOnlyChannels]);
  const uncovered = preloadInvokeChannels.filter((channel) => !covered.has(channel));
  assert.deepEqual(
    uncovered,
    [],
    'each of these channels needs an entry in OPERATIONS (with a cli) or in WINDOW_ONLY_CHANNELS',
  );
});

test('the contract and the preload agree on the invoke channels, with no channel in two places', () => {
  const inBothLists = operationChannels.filter((channel) => windowOnlyChannels.includes(channel));
  assert.deepEqual(inBothLists, [], 'a channel cannot be an operation and a window only channel at once');

  const missingFromPreload = operationChannels.filter((channel) => !preloadInvokeChannels.includes(channel));
  assert.deepEqual(missingFromPreload, [], 'these operations have a channel the preload does not expose');

  const missingFromBridge = windowOnlyChannels.filter((channel) => !preloadInvokeChannels.includes(channel));
  assert.deepEqual(missingFromBridge, [], 'a window only channel the preload does not expose');
});

// A push event is not an invoke channel, so the two maps never name the same
// thing. 'ui:focus' is the case: the tray pushes it, nothing invokes it.
test('a window only event is not listed among the invoke channels of the window', () => {
  const events = [...eventChannels, ...windowOnlyEvents];
  const listedAsChannel = windowOnlyChannels.filter((channel) => events.includes(channel));
  assert.deepEqual(listedAsChannel, [], 'an event is not an invoke channel of the window');
});

test('every operation of the table has the terminal command it names', () => {
  const missing = OPERATIONS
    .filter((operation) => cliEntry(operation.cli) === null)
    .map((operation) => `${operation.name} names the command "${operation.cli}"`);
  assert.deepEqual(missing, [], 'these commands are absent from CLI_COMMANDS or have no run function');
});

test('every operation has a name, a channel of its own and at least one front end', () => {
  const names = OPERATIONS.map((operation) => operation.name);
  assert.equal(new Set(names).size, names.length, 'two operations share a name');
  assert.equal(new Set(operationChannels).size, operationChannels.length, 'two operations share an invoke channel');

  const unreachable = OPERATIONS
    .filter((operation) => operation.ipc === null && !operation.cli)
    .map((operation) => operation.name);
  assert.deepEqual(unreachable, [], 'an operation with no channel and no command cannot be reached');
});

test('the contract and the preload agree on the event channels', () => {
  const inBothLists = eventChannels.filter((channel) => windowOnlyEvents.includes(channel));
  assert.deepEqual(inBothLists, [], 'an event cannot be a core event and a window only event at once');

  const contract = [...eventChannels, ...windowOnlyEvents].sort();
  assert.deepEqual(contract, [...preloadEventChannels].sort(), 'the preload subscribes to a different set of events');
});
