/** Follow the shared log without overlapping reads or replaying consumed lines. */
export function createLogFeed({
  read,
  onLines,
  onReset = () => {},
  onError = () => {},
  lines = 500,
  intervalMs = 1000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let cursor;
  let timer;
  let started = false;
  let stopped = false;
  let generation = 0;
  let lastError;
  let firstRead;

  async function poll() {
    const readGeneration = generation;
    try {
      const payload = await read(cursor === undefined ? { lines } : { lines, cursor });
      if (stopped) return;
      if (payload?.ok !== true || !payload.cursor || !Array.isArray(payload.lines)) {
        throw new Error(payload?.message || 'The shared log is not available.');
      }
      // Even a batch hidden by Clear is consumed, so the next read cannot replay it.
      cursor = payload.cursor;
      lastError = undefined;
      if (readGeneration === generation) {
        if (payload.reset) onReset();
        onLines(payload.lines);
      }
    } catch (error) {
      if (stopped) return;
      const message = error?.message ?? String(error);
      if (message !== lastError) {
        lastError = message;
        onError(error);
      }
    } finally {
      // Scheduling only after completion keeps a slow IPC read from overlapping.
      if (!stopped) timer = schedule(poll, intervalMs);
    }
  }

  return {
    start() {
      if (stopped) return Promise.resolve();
      if (!started) {
        started = true;
        firstRead = poll();
      }
      return firstRead;
    },
    clear() {
      generation += 1;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) cancel(timer);
    },
  };
}
