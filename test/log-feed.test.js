import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogFeed } from '../src/renderer/log-feed.js';

function clock() {
  let next = 0;
  const scheduled = new Map();
  return {
    schedule(callback, delay) {
      const id = ++next;
      scheduled.set(id, { callback, delay });
      return id;
    },
    cancel(id) {
      scheduled.delete(id);
    },
    get pending() {
      return scheduled.size;
    },
    tick() {
      assert.equal(scheduled.size, 1, 'one next poll must be scheduled');
      const [id, { callback, delay }] = scheduled.entries().next().value;
      assert.equal(delay, 1000);
      scheduled.delete(id);
      return callback();
    },
  };
}

function cursor(offset, identity = 'first-file') {
  return { file: '/test/latest.log', identity, offset, total: offset };
}

function batch(lines, nextCursor, reset = false) {
  return { ok: true, path: '/test/latest.log', lines, cursor: nextCursor, reset };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('the window loads history and follows new CLI lines with its last cursor', async () => {
  const timer = clock();
  const requests = [];
  const displayed = [];
  const initial = cursor(10);
  const appended = cursor(20);
  const responses = [
    batch(['GUI started', 'CLI connected'], initial),
    batch(['CLI changed configuration'], appended),
    batch([], appended),
    batch(['CLI changed configuration'], cursor(30)),
  ];
  const feed = createLogFeed({
    ...timer,
    read: async (request) => { requests.push(request); return responses.shift(); },
    onLines: (lines) => displayed.push(...lines),
  });

  await feed.start();
  await timer.tick();
  await timer.tick();
  assert.deepEqual(displayed, ['GUI started', 'CLI connected', 'CLI changed configuration']);
  await timer.tick();
  assert.deepEqual(requests, [
    { lines: 500 },
    { lines: 500, cursor: initial },
    { lines: 500, cursor: appended },
    { lines: 500, cursor: appended },
  ]);
  assert.deepEqual(displayed, [
    'GUI started', 'CLI connected', 'CLI changed configuration', 'CLI changed configuration',
  ], 'distinct entries with identical text must remain visible');
  feed.stop();
});

test('missing logs and failed reads retry from the last successful cursor', async () => {
  const timer = clock();
  const requests = [];
  const displayed = [];
  const errors = [];
  const initial = cursor(10);
  const appended = cursor(20);
  const responses = [
    { ok: false, message: 'Missing log' },
    { ok: false, message: 'Missing log' },
    batch(['old'], initial),
    new Error('IPC read failed'),
    new Error('IPC read failed'),
    batch(['new'], appended),
    new Error('IPC read failed'),
  ];
  const feed = createLogFeed({
    ...timer,
    read: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    onLines: (lines) => displayed.push(...lines),
    onError: (error) => errors.push(error.message),
  });

  await feed.start();
  for (let i = 0; i < 6; i += 1) await timer.tick();

  assert.deepEqual(requests, [
    { lines: 500 }, { lines: 500 }, { lines: 500 },
    { lines: 500, cursor: initial }, { lines: 500, cursor: initial }, { lines: 500, cursor: initial },
    { lines: 500, cursor: appended },
  ]);
  assert.deepEqual(displayed, ['old', 'new']);
  assert.deepEqual(errors, ['Missing log', 'IPC read failed', 'IPC read failed']);
  feed.stop();
});

test('replacing or truncating the file resets persisted history before new lines', async () => {
  const timer = clock();
  const displayed = [];
  const responses = [batch(['old'], cursor(10)), batch(['replacement'], cursor(1, 'replacement'), true)];
  let resets = 0;
  const feed = createLogFeed({
    ...timer,
    read: async () => responses.shift(),
    onLines: (lines) => displayed.push(...lines),
    onReset: () => { displayed.length = 0; resets += 1; },
  });

  await feed.start();
  await timer.tick();

  assert.deepEqual(displayed, ['replacement']);
  assert.equal(resets, 1);
  feed.stop();
});

test('a slow read never overlaps another read, including repeated start calls', async () => {
  const timer = clock();
  const first = deferred();
  const second = deferred();
  let reads = 0;
  const feed = createLogFeed({
    ...timer,
    read: () => { reads += 1; return reads === 1 ? first.promise : second.promise; },
    onLines: () => {},
  });

  const started = feed.start();
  assert.equal(feed.start(), started);
  assert.equal(reads, 1);
  assert.equal(timer.pending, 0, 'no timer runs while the initial read is in flight');
  first.resolve(batch(['old'], cursor(10)));
  await started;
  const next = timer.tick();
  await feed.start();
  assert.equal(reads, 2);
  assert.equal(timer.pending, 0, 'no timer runs while a later read is in flight');
  second.resolve(batch(['new'], cursor(20)));
  await next;
  assert.equal(timer.pending, 1);
  feed.stop();
});

test('Clear consumes an in-flight batch and does not replay already displayed history', async () => {
  const timer = clock();
  const pending = deferred();
  const displayed = [];
  const requests = [];
  const initial = cursor(10);
  const consumed = cursor(20);
  let reads = 0;
  const feed = createLogFeed({
    ...timer,
    read: (request) => {
      requests.push(request);
      reads += 1;
      if (reads === 1) return batch(['history'], initial);
      if (reads === 2) return pending.promise;
      return batch(['after clear'], cursor(30));
    },
    onLines: (lines) => displayed.push(...lines),
  });

  await feed.start();
  const next = timer.tick();
  displayed.length = 0;
  feed.clear();
  pending.resolve(batch(['pending before clear'], consumed));
  await next;
  assert.deepEqual(displayed, []);
  await timer.tick();
  assert.deepEqual(requests[2], { lines: 500, cursor: consumed });
  assert.deepEqual(displayed, ['after clear']);
  feed.stop();
});

test('unloading cancels a scheduled poll and never restarts it', async () => {
  const timer = clock();
  let reads = 0;
  const feed = createLogFeed({
    ...timer,
    read: async () => { reads += 1; return batch([], cursor(0)); },
    onLines: () => {},
  });

  await feed.start();
  assert.equal(timer.pending, 1);
  feed.stop();
  assert.equal(timer.pending, 0);
  await feed.start();
  assert.equal(reads, 1);
});

test('unloading during a read discards the result and does not schedule another poll', async () => {
  const timer = clock();
  const pending = deferred();
  const displayed = [];
  let resets = 0;
  const feed = createLogFeed({
    ...timer,
    read: () => pending.promise,
    onLines: (lines) => displayed.push(...lines),
    onReset: () => { resets += 1; },
  });

  const started = feed.start();
  feed.stop();
  pending.resolve(batch(['arrived after unload'], cursor(1), true));
  await started;
  assert.deepEqual(displayed, []);
  assert.equal(resets, 0);
  assert.equal(timer.pending, 0);
});
