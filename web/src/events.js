// Shared SSE client: one EventSource for all live updates (downloads, Listen
// Together), with per-event subscriptions. Connects lazily on first use (the
// app only subscribes once signed in), reconnects on the `musicarr:authed`
// signal, and closes on `musicarr:unauth`. Consumers keep a slow polling
// fallback and can check `events.connected` to decide how often to poll.

let es = null;
let connectedFlag = false;
const listeners = new Map(); // event name -> Set<cb>
const attached = new Set();  // event names already wired onto the EventSource

function dispatch(event, e) {
  let data;
  try { data = JSON.parse(e.data); } catch { return; }
  for (const cb of listeners.get(event) || []) {
    try { cb(data); } catch (err) { console.warn('[events] handler failed:', err); }
  }
}

function attach(event) {
  if (!es || attached.has(event)) return;
  attached.add(event);
  es.addEventListener(event, (e) => dispatch(event, e));
}

function connect() {
  // A 401 (or server restart) closes the source permanently in some browsers;
  // recreate it when asked again.
  if (es && es.readyState !== EventSource.CLOSED) return;
  try { es?.close(); } catch { /* ignore */ }
  attached.clear();
  es = new EventSource('/api/events');
  es.onopen = () => { connectedFlag = true; };
  es.onerror = () => { connectedFlag = false; };
  for (const ev of listeners.keys()) attach(ev);
}

function disconnect() {
  connectedFlag = false;
  try { es?.close(); } catch { /* ignore */ }
  es = null;
  attached.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('musicarr:authed', connect);
  window.addEventListener('musicarr:unauth', disconnect);
  // Revive a permanently-closed source when the tab comes back to life.
  window.addEventListener('focus', () => { if (listeners.size) connect(); });
}

export const events = {
  /** Subscribe to a named server event. Returns an unsubscribe function. */
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    connect();
    attach(event);
    return () => {
      const set = listeners.get(event);
      if (set) { set.delete(cb); if (!set.size) listeners.delete(event); }
    };
  },
  /** True while the SSE stream is live (used to slow polling fallbacks). */
  get connected() { return connectedFlag && es?.readyState === EventSource.OPEN; },
};
