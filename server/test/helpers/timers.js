// Replace setTimeout/setInterval with no-ops so a "start the watcher/poller"
// function can be called for coverage without scheduling real background work.
// Returns a restore function and the captured callbacks.

export function stubTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const calls = { timeouts: [], intervals: [] };
  globalThis.setTimeout = (fn) => { calls.timeouts.push(fn); return { unref() {} }; };
  globalThis.setInterval = (fn) => { calls.intervals.push(fn); return { unref() {} }; };
  return {
    calls,
    restore() { globalThis.setTimeout = realSetTimeout; globalThis.setInterval = realSetInterval; },
  };
}
