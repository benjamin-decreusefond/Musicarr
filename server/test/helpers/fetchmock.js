// A tiny global-fetch stub for the external APIs the server calls (Deezer,
// slskd, LRCLIB, Deezer preview CDNs). Tests register handlers; everything else
// throws so an unexpected outbound call is loud rather than silent.

import { realFetch } from './env.js';

let routes = [];

// Register a handler. `match` is a substring or RegExp tested against the URL;
// `handler(url, opts)` returns a Response, or a plain object/string (wrapped as
// a 200 JSON/text response), or throws to simulate a network failure.
export function on(match, handler) {
  routes.push({ match, handler });
}

export function reset() {
  routes = [];
}

function toResponse(value) {
  if (value instanceof Response) return value;
  if (typeof value === 'string') return new Response(value, { status: 200 });
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

export function install() {
  routes = []; // start each install with a clean routing table
  globalThis.fetch = async (input, opts) => {
    const url = typeof input === 'string' ? input : input.url;
    for (const r of routes) {
      const hit = r.match instanceof RegExp ? r.match.test(url) : url.includes(r.match);
      if (hit) return toResponse(await r.handler(url, opts || {}));
    }
    throw new Error(`fetchmock: no route for ${url}`);
  };
}

export function uninstall() {
  globalThis.fetch = realFetch;
  reset();
}

// Convenience: a JSON Response with an explicit status.
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}
