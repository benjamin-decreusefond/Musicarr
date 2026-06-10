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
  const [volume, setVolume] = useState(1);
  const [eqEnabled, setEqEnabled] = useState(() => localStorage.getItem('musicarr:eq:on') === '1');
  const [eqGains, setEqGains] = useState(loadGains);

  const current = index >= 0 ? queue[index] : null;

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
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }
    const a = audioRef.current;
    const onTime = () => setTime(a.currentTime);
    const onDur = () => setDuration(a.duration || 0);
    const onEnd = () => next();
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onDur);
    a.addEventListener('ended', onEnd);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('durationchange', onDur);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
    };
  }, [queue, index]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  useEffect(() => {
    if (!current) return;
    const a = audioRef.current;
    ensureGraph();
    audioCtxRef.current?.resume?.();
    a.src = `/api/stream/${current.deezer_id || current.id}`;
    a.play().catch(() => {});
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: current.title, artist: current.artist, album: current.album || '',
        artwork: current.cover ? [{ src: current.cover, sizes: '250x250', type: 'image/jpeg' }] : [],
      });
    }
  }, [index]);

  const playList = useCallback((tracks, start = 0) => {
    const avail = tracks.filter(t => t.available || t.file_path);
    if (!avail.length) return;
    // Map start index from full list to the filtered list.
    const startTrack = tracks[start];
    const startIdx = Math.max(0, avail.findIndex(t => (t.deezer_id || t.id) === (startTrack?.deezer_id || startTrack?.id)));
    setQueue(avail);
    setIndex(startIdx);
  }, []);

  const playTrack = useCallback((track) => playList([track], 0), [playList]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || index < 0) return;
    audioCtxRef.current?.resume?.(); // honour autoplay policy on user gesture
    if (a.paused) a.play(); else a.pause();
  }, [index]);

  const next = useCallback(() => setIndex(i => (i < queue.length - 1 ? i + 1 : i)), [queue.length]);
  const prev = useCallback(() => {
    const a = audioRef.current;
    if (a && a.currentTime > 3) { a.currentTime = 0; return; }
    setIndex(i => (i > 0 ? i - 1 : i));
  }, []);
  const seek = useCallback((t) => { if (audioRef.current) audioRef.current.currentTime = t; }, []);

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

  const value = { queue, current, playing, time, duration, volume, setVolume,
    playList, playTrack, toggle, next, prev, seek, hasNext: index < queue.length - 1, hasPrev: index > 0,
    eqEnabled, setEqEnabled, eqGains, setEqBand, applyPreset, resetEq };
  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}
