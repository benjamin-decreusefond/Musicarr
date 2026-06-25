import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';

async function req(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (r.status === 401) { window.dispatchEvent(new Event('musicarr:unauth')); throw new Error('Unauthorized'); }
  const txt = await r.text();
  const data = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b),
  put: (u, b) => req('PUT', u, b),
  del: (u) => req('DELETE', u),
};

export { fmtTime } from './util.js';

/* ---------------------------------------------------------- Player store */
const PlayerCtx = createContext(null);
export const usePlayer = () => useContext(PlayerCtx);

// Current signed-in user (id, username, is_admin), so any component (e.g. a
// track row) can adapt to permissions without prop-drilling.
export const MeContext = createContext(null);
export const useMe = () => useContext(MeContext);

// Functional graphic EQ (Web Audio BiquadFilters). Shelf at the ends, peaking
// in between. Gains in dB, clamped to ±12 in the UI.
export const EQ_BANDS = [60, 170, 350, 1000, 3500, 10000];
export const EQ_LABELS = ['60', '170', '350', '1k', '3.5k', '10k'];
export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0],
  'Bass boost': [7, 5, 2, 0, 0, 0],
  'Treble boost': [0, 0, 0, 2, 5, 7],
  Vocal: [-3, -1, 3, 4, 2, 0],
  Rock: [5, 3, -1, -1, 3, 5],
};
const EQ_ZERO = EQ_BANDS.map(() => 0);
const loadGains = () => {
  try {
    const g = JSON.parse(localStorage.getItem('musicarr:eq:gains'));
    if (Array.isArray(g) && g.length === EQ_BANDS.length) return g.map(Number);
  } catch { /* ignore */ }
  return [...EQ_ZERO];
};
// User-saved equalizer presets: { name: number[] }. Synced via /api/preferences.
const loadPresets = () => {
  try {
    const p = JSON.parse(localStorage.getItem('musicarr:eq:presets'));
    if (p && typeof p === 'object' && !Array.isArray(p)) return p;
  } catch { /* ignore */ }
  return {};
};

export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  const audioCtxRef = useRef(null);
  const filtersRef = useRef(null);
  // Separate audio element for 30s previews of not-yet-downloaded tracks, kept
  // independent of the main queue/player but surfaced in the player bar.
  const previewRef = useRef(null);
  const [previewId, setPreviewId] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTrackObj, setPreviewTrackObj] = useState(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [repeat, setRepeat] = useState(() => {
    const r = localStorage.getItem('musicarr:repeat');
    return r === 'all' || r === 'one' ? r : 'off';
  });
  // Bumped when the user explicitly starts playback (playList/playAt), so the
  // playback effect re-runs even if the track id happens to be unchanged.
  const [playNonce, setPlayNonce] = useState(0);
  const [volume, setVolumeState] = useState(() => {
    const v = parseFloat(localStorage.getItem('musicarr:volume'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  });
  const [eqEnabled, setEqEnabled] = useState(() => localStorage.getItem('musicarr:eq:on') === '1');
  const [eqGains, setEqGains] = useState(loadGains);
  const [eqPresets, setEqPresets] = useState(loadPresets);

  const current = index >= 0 ? queue[index] : null;

  // The audio-element listeners are attached exactly once; they read the live
  // state through this ref, which avoids the whole stale-closure class of bugs
  // (e.g. "queue stops advancing after the first song").
  const stateRef = useRef({ queue, index, repeat });
  stateRef.current = { queue, index, repeat };
  const skipFailsRef = useRef(0);  // consecutive stream failures, to stop skip loops
  const endedGuardRef = useRef(false); // de-dupe ended vs near-end fallback per track

  // Persist volume across reboots.
  const setVolume = useCallback((v) => {
    setVolumeState(v);
    localStorage.setItem('musicarr:volume', String(v));
  }, []);

  const cycleRepeat = useCallback(() => {
    setRepeat(r => {
      const next = r === 'off' ? 'all' : r === 'all' ? 'one' : 'off';
      localStorage.setItem('musicarr:repeat', next);
      return next;
    });
  }, []);

  // Build the Web Audio graph lazily on first playback (needs a user gesture
  // to start the AudioContext). source -> [filters] -> destination.
  const ensureGraph = useCallback(() => {
    if (audioCtxRef.current || !audioRef.current) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(audioRef.current);
      const filters = EQ_BANDS.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1;
        f.gain.value = eqEnabled ? eqGains[i] : 0;
        return f;
      });
      let node = src;
      for (const f of filters) { node.connect(f); node = f; }
      node.connect(ctx.destination);
      audioCtxRef.current = ctx;
      filtersRef.current = filters;
    } catch { /* MediaElementSource already created or unsupported */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Push gains into the filters and persist whenever they change.
  useEffect(() => {
    const filters = filtersRef.current;
    if (filters) filters.forEach((f, i) => { f.gain.value = eqEnabled ? eqGains[i] : 0; });
    localStorage.setItem('musicarr:eq:on', eqEnabled ? '1' : '0');
    localStorage.setItem('musicarr:eq:gains', JSON.stringify(eqGains));
  }, [eqEnabled, eqGains]);

  useEffect(() => {
    localStorage.setItem('musicarr:eq:presets', JSON.stringify(eqPresets));
  }, [eqPresets]);

  /* --------------------------------------------- Server-synced preferences */
  // localStorage above stays the instant local cache / offline fallback; the
  // server copy syncs these settings across all of a user's clients. We hydrate
  // once when signed in, then debounce writes back. `hydratedRef` makes the
  // save effect skip the burst of state updates that hydration itself causes.
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef(null);
  useEffect(() => {
    const hydrate = () => {
      if (hydratedRef.current) return;
      api.get('/api/preferences').then(p => {
        if (hydratedRef.current) return;
        if (p && typeof p === 'object') {
          if (Number.isFinite(p.volume)) setVolume(Math.min(1, Math.max(0, p.volume)));
          if (typeof p.eqEnabled === 'boolean') setEqEnabled(p.eqEnabled);
          if (Array.isArray(p.eqGains) && p.eqGains.length === EQ_BANDS.length) setEqGains(p.eqGains.map(Number));
          if (p.eqPresets && typeof p.eqPresets === 'object' && !Array.isArray(p.eqPresets)) setEqPresets(p.eqPresets);
          if (p.repeat === 'all' || p.repeat === 'one' || p.repeat === 'off') {
            setRepeat(p.repeat);
            localStorage.setItem('musicarr:repeat', p.repeat);
          }
        }
        // Flip the guard only after the hydration setters have flushed and the
        // save effect has run (and bailed) for them — deferring past the render
        // tick avoids a redundant write-back of the values we just loaded.
        setTimeout(() => { hydratedRef.current = true; }, 0);
      }).catch(() => {
        // Leave the guard false (e.g. a 401 before sign-in) so a later
        // `musicarr:authed` retries and the save-back stays disabled until we've
        // actually loaded the server copy — avoids clobbering it with defaults.
      });
    };
    window.addEventListener('musicarr:authed', hydrate);
    // Also attempt immediately in case we mounted already authenticated.
    hydrate();
    return () => window.removeEventListener('musicarr:authed', hydrate);
  }, [setVolume]);

  // Debounce-coalesce changes to volume / EQ / repeat into a single PUT. Errors
  // are swallowed: a sync failure must never affect playback (localStorage holds
  // the value regardless).
  useEffect(() => {
    if (!hydratedRef.current) return; // skip the hydration write-back
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      api.put('/api/preferences', { volume, eqEnabled, eqGains, repeat, eqPresets }).catch(() => {});
    }, 600);
    return () => clearTimeout(saveTimerRef.current);
  }, [volume, eqEnabled, eqGains, repeat, eqPresets]);

  /** Advance to the next track. Reads live state from stateRef so it is safe
   *  to call from the once-attached audio listeners.
   *  `manual` skips repeat-one (pressing Next always moves on, like Spotify). */
  const advance = useCallback((manual = false) => {
    const a = audioRef.current;
    const { queue: q, index: i, repeat: r } = stateRef.current;
    if (!q.length || i < 0) return;
    const replay = () => {
      a.currentTime = 0;
      // Re-arm end detection: replaying keeps the same track, so the playback
      // effect won't reset the guard for us (this is what made repeat-one
      // play only once and then stall).
      endedGuardRef.current = false;
      a.play().catch(e => console.warn('[player] replay failed:', e));
    };
    if (!manual && r === 'one') return replay();
    let ni = i + 1;
    if (ni >= q.length) {
      if (r === 'all') ni = 0;
      else { setPlaying(false); return; } // end of queue
    }
    if (ni === i) return replay(); // single-track queue with repeat all
    setIndex(ni);
  }, []);

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }
    const a = audioRef.current;
    const onTime = () => {
      setTime(a.currentTime);
      const d = a.duration;
      // Keep the OS media UI's scrubber in sync (lock screen / media keys).
      if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && Number.isFinite(d) && d > 0) {
        try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(a.currentTime, d), playbackRate: a.playbackRate || 1 }); }
        catch { /* some browsers reject odd values mid-seek */ }
      }
      // Fallback for formats/streams where 'ended' doesn't fire reliably:
      // if we're at the very end and playback has stopped progressing, advance.
      if (Number.isFinite(d) && d > 0 && a.currentTime >= d - 0.25 && !endedGuardRef.current) {
        endedGuardRef.current = true;
        skipFailsRef.current = 0;
        advance(false);
      }
    };
    const onDur = () => setDuration(a.duration || 0);
    const onEnd = () => { skipFailsRef.current = 0; if (!endedGuardRef.current) { endedGuardRef.current = true; advance(false); } };
    const onPlay = () => {
      skipFailsRef.current = 0; setPlaying(true);
      // Real playback wins over a preview — never play both at once.
      if (previewRef.current) { previewRef.current.pause(); previewRef.current.removeAttribute('src'); }
      setPreviewId(null); setPreviewLoading(false); setPreviewTrackObj(null); setPreviewPlaying(false);
    };
    const onPause = () => setPlaying(false);
    // A track whose file is missing/broken must not silently stop the queue:
    // log it and skip ahead, but give up after a full lap of failures.
    const onError = () => {
      const { queue: q, index: i } = stateRef.current;
      console.warn(`[player] stream failed for "${q[i]?.title ?? '?'}" (${a.src}) — skipping`);
      skipFailsRef.current += 1;
      if (skipFailsRef.current >= Math.max(1, q.length)) { setPlaying(false); return; }
      advance(true);
    };
    // Seeking away from the end re-arms end detection (e.g. the prev-button
    // restart, or scrubbing backwards after the track already finished).
    const onSeeking = () => {
      const d = a.duration;
      if (Number.isFinite(d) && d > 0 && a.currentTime < d - 1) endedGuardRef.current = false;
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onDur);
    a.addEventListener('ended', onEnd);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('error', onError);
    a.addEventListener('seeking', onSeeking);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('durationchange', onDur);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('error', onError);
      a.removeEventListener('seeking', onSeeking);
    };
  }, [advance]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (previewRef.current) previewRef.current.volume = volume; }, [volume]);

  /* ------------------------------------------------------- 30s previews */
  const stopPreview = useCallback(() => {
    const a = previewRef.current;
    if (a) { a.pause(); a.removeAttribute('src'); }
    setPreviewId(null); setPreviewLoading(false); setPreviewTrackObj(null);
    setPreviewPlaying(false); setPreviewTime(0); setPreviewDuration(0);
  }, []);

  // Lazily create the preview element and wire its state into the player bar.
  const ensurePreview = useCallback(() => {
    if (previewRef.current) return previewRef.current;
    const a = new Audio();
    a.volume = volume;
    a.addEventListener('timeupdate', () => setPreviewTime(a.currentTime || 0));
    a.addEventListener('durationchange', () => setPreviewDuration(Number.isFinite(a.duration) ? a.duration : 0));
    a.addEventListener('play', () => setPreviewPlaying(true));
    a.addEventListener('pause', () => setPreviewPlaying(false));
    a.addEventListener('playing', () => setPreviewLoading(false));
    a.addEventListener('ended', () => { setPreviewPlaying(false); });
    a.addEventListener('error', () => { setPreviewLoading(false); setPreviewPlaying(false); });
    previewRef.current = a;
    return a;
  }, [volume]);

  // Start (or restart) a 30s Deezer preview for a track, proxied via
  // /api/preview. Pauses the main player; the preview shows in the player bar
  // with its own play/pause + seek. Previewing the same track again stops it.
  const previewTrack = useCallback((track) => {
    const id = track?.deezer_id || track?.id;
    if (!id) return;
    if (previewId === id) { stopPreview(); return; }
    const a = ensurePreview();
    audioRef.current?.pause(); // silence the main player
    a.src = `/api/preview/${id}`;
    setPreviewId(id); setPreviewTrackObj(track); setPreviewLoading(true);
    setPreviewTime(0); setPreviewDuration(0);
    a.play().catch(() => { setPreviewLoading(false); setPreviewPlaying(false); });
  }, [previewId, stopPreview, ensurePreview]);

  // Pause/resume the active preview (used by the player-bar play button).
  const previewToggle = useCallback(() => {
    const a = previewRef.current;
    if (!a || !previewId) return;
    if (a.paused) { audioRef.current?.pause(); a.play().catch(() => {}); } else a.pause();
  }, [previewId]);

  const previewSeek = useCallback((t) => { if (previewRef.current) previewRef.current.currentTime = t; }, []);

  const currentId = current ? (current.deezer_id || current.id) : null;
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!current) { a.pause(); a.removeAttribute('src'); return; } // queue emptied
    ensureGraph();
    audioCtxRef.current?.resume?.();
    endedGuardRef.current = false; // new track: re-arm end detection
    a.src = `/api/stream/${currentId}`;
    a.play().catch(e => console.warn('[player] play failed:', e));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: current.title, artist: current.artist, album: current.album || '',
        artwork: current.cover ? [{ src: current.cover, sizes: '250x250', type: 'image/jpeg' }] : [],
      });
    }
    // Record the play for history + recommendations (fire-and-forget).
    if (currentId) api.post('/api/plays', { track_id: currentId }).catch(() => {});
    // Keyed on the track identity (not the queue index) so reordering the
    // queue around the playing track doesn't restart it.
  }, [currentId, playNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live "now playing" heartbeat so other users see what we're listening to.
  useEffect(() => {
    if (!playing || !currentId) return;
    const beat = () => api.post('/api/social/heartbeat', { track_id: currentId }).catch(() => {});
    beat();
    const t = setInterval(beat, 20000);
    return () => clearInterval(t);
  }, [playing, currentId]);

  const trackId = (t) => t?.deezer_id || t?.id;
  const playable = (tracks) => tracks.filter(t => t.available || t.file_path);

  const playList = useCallback((tracks, start = 0, { shuffle = false } = {}) => {
    let avail = playable(tracks);
    if (!avail.length) return;
    const startTrack = tracks[start];
    if (shuffle) {
      // Fisher–Yates, then float the clicked track to the front if it's in the set.
      for (let i = avail.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [avail[i], avail[j]] = [avail[j], avail[i]]; }
      const si = avail.findIndex(t => trackId(t) === trackId(startTrack));
      if (si > 0) { const [t] = avail.splice(si, 1); avail.unshift(t); }
      setQueue(avail); setIndex(0); setPlayNonce(n => n + 1); return;
    }
    const startIdx = Math.max(0, avail.findIndex(t => trackId(t) === trackId(startTrack)));
    setQueue(avail);
    setIndex(startIdx);
    setPlayNonce(n => n + 1);
  }, []);

  const playTrack = useCallback((track) => playList([track], 0), [playList]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || index < 0) return;
    audioCtxRef.current?.resume?.(); // honour autoplay policy on user gesture
    if (a.paused) a.play(); else a.pause();
  }, [index]);

  // Spacebar toggles play/pause (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // Play a track in the context of a list, but if it's already the current
  // track just toggle play/pause (so clicking the playing row pauses it).
  const playOrToggle = useCallback((track, tracks, i = 0) => {
    if (current && trackId(current) === trackId(track)) { toggle(); return; }
    if (tracks) playList(tracks, i); else playTrack(track);
  }, [current, toggle, playList, playTrack]);

  // Append tracks to the queue (starts playback if nothing is playing).
  const enqueue = useCallback((tracks) => {
    const avail = playable(Array.isArray(tracks) ? tracks : [tracks]);
    if (!avail.length) return;
    const { queue: q, index: i } = stateRef.current;
    const existing = new Set(q.map(trackId));
    const fresh = avail.filter(t => !existing.has(trackId(t)));
    if (!fresh.length) return;
    setQueue([...q, ...fresh]);
    if (i < 0) { setIndex(q.length); setPlayNonce(n => n + 1); } // start on the first added track
  }, []);

  // Insert tracks right after the currently-playing one ("Play next").
  const playNext = useCallback((tracks) => {
    const avail = playable(Array.isArray(tracks) ? tracks : [tracks]);
    if (!avail.length) return;
    const { queue: q, index: i } = stateRef.current;
    const existing = new Set(q.map(trackId));
    const fresh = avail.filter(t => !existing.has(trackId(t)));
    if (!fresh.length) return;
    if (i < 0) { setQueue([...q, ...fresh]); setIndex(q.length); setPlayNonce(n => n + 1); return; }
    const nq = [...q.slice(0, i + 1), ...fresh, ...q.slice(i + 1)];
    setQueue(nq);
  }, []);

  /* ------------------------------------------------------------ Radio mode */
  // Because we can only play files on disk, radio works by pre-downloading
  // upcoming tracks and appending them to the queue as they land. Deezer's
  // artist radio supplies the candidate list.
  const PREFETCH_AHEAD = 4;
  const [radioActive, setRadioActive] = useState(false);
  const radioRef = useRef({ pool: [], requested: new Set(), seed: null });

  // One pass: top up downloads for the next few missing tracks, and append any
  // that have finished downloading to the play queue.
  const radioTick = useCallback(async () => {
    const st = radioRef.current;
    if (!st.pool.length) return;
    const toRequest = st.pool.filter(t => !t.available && !st.requested.has(t.id)).slice(0, PREFETCH_AHEAD);
    for (const t of toRequest) {
      st.requested.add(t.id);
      api.post('/api/download', { kind: 'track', deezer_id: t.id }).catch(() => {});
    }
    const pending = st.pool.filter(t => !t.available && st.requested.has(t.id)).map(t => t.id);
    if (!pending.length) return;
    try {
      const status = await api.get(`/api/track-status?ids=${pending.join(',')}`);
      let changed = false;
      for (const t of st.pool) if (!t.available && status[t.id]?.available) { t.available = true; changed = true; }
      if (changed) enqueue(st.pool.filter(t => t.available)); // enqueue de-dupes
    } catch { /* ignore a poll miss */ }
  }, [enqueue]);

  const startRadio = useCallback(async (seed) => {
    const r = await api.get(`/api/radio?seed=${encodeURIComponent(seed)}`);
    radioRef.current = { pool: (r.tracks || []).slice(0, 40), requested: new Set(), seed };
    setRadioActive(true);
    const ready = radioRef.current.pool.filter(t => t.available);
    if (ready.length) playList(ready, 0);
    radioTick();
    return radioRef.current.pool.length;
  }, [playList, radioTick]);

  const stopRadio = useCallback(() => {
    setRadioActive(false);
    radioRef.current = { pool: [], requested: new Set(), seed: null };
  }, []);

  useEffect(() => {
    if (!radioActive) return;
    const t = setInterval(() => radioTick(), 6000);
    return () => clearInterval(t);
  }, [radioActive, radioTick]);

  // Reorder/remove keep `index` pointing at the currently-playing track.
  const moveInQueue = useCallback((from, to) => {
    const { queue: q, index: i } = stateRef.current;
    if (from < 0 || from >= q.length || to < 0 || to >= q.length || from === to) return;
    const nq = [...q];
    const [m] = nq.splice(from, 1);
    nq.splice(to, 0, m);
    let ni = i;
    if (from === i) ni = to;
    else if (from < i && to >= i) ni = i - 1;
    else if (from > i && to <= i) ni = i + 1;
    setQueue(nq);
    setIndex(ni);
  }, []);

  const removeFromQueue = useCallback((pos) => {
    const { queue: q, index: i } = stateRef.current;
    if (pos < 0 || pos >= q.length) return;
    const nq = q.filter((_, k) => k !== pos);
    setQueue(nq);
    // Same index now points at the following track (or the new last/none),
    // which is exactly "removed current -> play next".
    if (pos < i) setIndex(i - 1);
    else if (pos === i) setIndex(Math.min(i, nq.length - 1));
  }, []);

  const playAt = useCallback((pos) => {
    const { queue: q } = stateRef.current;
    if (pos < 0 || pos >= q.length) return;
    setIndex(pos);
    setPlayNonce(n => n + 1);
  }, []);

  // Explicit play/pause (used by Listen Together to follow the host's state).
  const play = useCallback(() => { audioCtxRef.current?.resume?.(); audioRef.current?.play().catch(() => {}); }, []);
  const pause = useCallback(() => audioRef.current?.pause(), []);

  const next = useCallback(() => advance(true), [advance]);
  const prev = useCallback(() => {
    const a = audioRef.current;
    if (a && a.currentTime > 3) { a.currentTime = 0; return; }
    setIndex(i => (i > 0 ? i - 1 : i));
  }, []);
  const seek = useCallback((t) => { if (audioRef.current) audioRef.current.currentTime = t; }, []);

  // Media keys / lock-screen controls.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => audioRef.current?.play());
      ms.setActionHandler('pause', () => audioRef.current?.pause());
      ms.setActionHandler('nexttrack', () => advance(true));
      ms.setActionHandler('previoustrack', () => prev());
      ms.setActionHandler('stop', () => { const a = audioRef.current; if (a) { a.pause(); a.currentTime = 0; } });
      ms.setActionHandler('seekbackward', (d) => { const a = audioRef.current; if (a) a.currentTime = Math.max(0, a.currentTime - (d.seekOffset || 10)); });
      ms.setActionHandler('seekforward', (d) => { const a = audioRef.current; if (a) a.currentTime = Math.min(a.duration || 0, a.currentTime + (d.seekOffset || 10)); });
      ms.setActionHandler('seekto', (d) => { const a = audioRef.current; if (a && d.seekTime != null) a.currentTime = d.seekTime; });
    } catch { /* some handlers unsupported */ }
  }, [advance, prev]);

  const setEqBand = useCallback((i, dB) => {
    setEqGains(prev => { const next = [...prev]; next[i] = dB; return next; });
    if (!eqEnabled) setEqEnabled(true);
  }, [eqEnabled]);
  const applyPreset = useCallback((name) => {
    const preset = EQ_PRESETS[name] || eqPresets[name];
    if (!preset) return;
    setEqGains(preset.slice(0, EQ_BANDS.length).map(Number));
    setEqEnabled(true);
  }, [eqPresets]);
  const resetEq = useCallback(() => setEqGains([...EQ_ZERO]), []);
  // Save the current band gains as a named preset (overwrites a same-named one).
  const savePreset = useCallback((name) => {
    const key = (name || '').trim().slice(0, 40);
    if (!key) return;
    setEqPresets(prev => ({ ...prev, [key]: [...eqGains] }));
  }, [eqGains]);
  const deletePreset = useCallback((name) => {
    setEqPresets(prev => { const next = { ...prev }; delete next[name]; return next; });
  }, []);

  const value = { queue, index, current, playing, time, duration, volume, setVolume,
    playList, playTrack, playOrToggle, toggle, play, pause, next, prev, seek,
    enqueue, playNext, moveInQueue, removeFromQueue, playAt,
    previewTrack, stopPreview, previewToggle, previewSeek,
    previewId, previewLoading, previewTrackObj, previewTime, previewDuration, previewPlaying,
    startRadio, stopRadio, radioActive,
    repeat, cycleRepeat,
    hasNext: index < queue.length - 1 || (repeat !== 'off' && queue.length > 0),
    hasPrev: index > 0,
    eqEnabled, setEqEnabled, eqGains, setEqBand, applyPreset, resetEq,
    eqPresets, savePreset, deletePreset };
  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}
