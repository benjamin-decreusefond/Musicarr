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

export function fmtTime(sec) {
  if (!sec && sec !== 0) return '--:--';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------------------------------------------------------- Player store */
const PlayerCtx = createContext(null);
export const usePlayer = () => useContext(PlayerCtx);

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

export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  const audioCtxRef = useRef(null);
  const filtersRef = useRef(null);
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
      // Fallback for formats/streams where 'ended' doesn't fire reliably:
      // if we're at the very end and playback has stopped progressing, advance.
      const d = a.duration;
      if (Number.isFinite(d) && d > 0 && a.currentTime >= d - 0.25 && !endedGuardRef.current) {
        endedGuardRef.current = true;
        skipFailsRef.current = 0;
        advance(false);
      }
    };
    const onDur = () => setDuration(a.duration || 0);
    const onEnd = () => { skipFailsRef.current = 0; if (!endedGuardRef.current) { endedGuardRef.current = true; advance(false); } };
    const onPlay = () => { skipFailsRef.current = 0; setPlaying(true); };
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
    } catch { /* some handlers unsupported */ }
  }, [advance, prev]);

  const setEqBand = useCallback((i, dB) => {
    setEqGains(prev => { const next = [...prev]; next[i] = dB; return next; });
    if (!eqEnabled) setEqEnabled(true);
  }, [eqEnabled]);
  const applyPreset = useCallback((name) => {
    const preset = EQ_PRESETS[name];
    if (!preset) return;
    setEqGains([...preset]);
    setEqEnabled(true);
  }, []);
  const resetEq = useCallback(() => setEqGains([...EQ_ZERO]), []);

  const value = { queue, index, current, playing, time, duration, volume, setVolume,
    playList, playTrack, playOrToggle, toggle, next, prev, seek,
    enqueue, moveInQueue, removeFromQueue, playAt,
    startRadio, stopRadio, radioActive,
    repeat, cycleRepeat,
    hasNext: index < queue.length - 1 || (repeat !== 'off' && queue.length > 0),
    hasPrev: index > 0,
    eqEnabled, setEqEnabled, eqGains, setEqBand, applyPreset, resetEq };
  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}
