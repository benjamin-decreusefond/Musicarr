// Pure, framework-free helpers — no React/DOM, so they're unit-testable under
// the Node test runner (see web/test/). Re-exported from store.jsx for existing
// import sites.

/** Format a number of seconds as m:ss, or "--:--" for unknown/empty input. */
export function fmtTime(sec) {
  if (!sec && sec !== 0) return '--:--';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
