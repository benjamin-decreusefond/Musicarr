import { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { api, fmtTime, PlayerProvider, usePlayer, MeContext, EQ_LABELS, EQ_PRESETS } from './store.jsx';
import { Icon, Cover } from './ui.jsx';
import { Home, Search, Explore, Genre, Mood, Artist, Album, Library, Favorites, Following, Playlist, DeezerPlaylist, Downloads, Admin, Settings, Profile, UserProfile, Stats, MadeForYou, Mix, Offline } from './views.jsx';
import './styles.css';

/* --------------------------------------------------------- EQ controls */
// The band sliders + presets, reused by the player-bar popover and the
// standalone Equalizer page (so it's usable even when nothing is playing).
function EqControls() {
  const p = usePlayer();
  return (
    <>
      <div className="eq-head">
        <span>Equalizer</span>
        <label className="eq-switch">
          <input type="checkbox" checked={p.eqEnabled} onChange={e => p.setEqEnabled(e.target.checked)} /> On
        </label>
      </div>
      <div className="eq-bands">
        {EQ_LABELS.map((label, i) => (
          <div className="eq-band" key={label}>
            <input className="eq-slider" type="range" min={-12} max={12} step={1}
              value={p.eqGains[i]} disabled={!p.eqEnabled}
              onChange={e => p.setEqBand(i, parseInt(e.target.value, 10))} />
            <span className="eq-gain">{p.eqGains[i] > 0 ? `+${p.eqGains[i]}` : p.eqGains[i]}</span>
            <span className="eq-freq">{label}</span>
          </div>
        ))}
      </div>
      <div className="eq-presets">
        <select value="" onChange={e => { if (e.target.value) p.applyPreset(e.target.value); }}>
          <option value="">Presets…</option>
          {Object.keys(EQ_PRESETS).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <button className="btn-ghost sm" onClick={p.resetEq}>Reset</button>
      </div>
    </>
  );
}

// Standalone page so the EQ is reachable from the sidebar at any time.
function EqualizerPage() {
  return (
    <div className="page">
      <h1 className="page-h1">Equalizer</h1>
      <p className="settings-hint">Adjust the sound. Changes apply live and are saved across reboots.</p>
      <div className="eq-page-panel"><EqControls /></div>
    </div>
  );
}

function Popover({ icon, title, active, className, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="eq-wrap" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen(o => !o)} title={title}
        style={{ color: active ? 'var(--accent)' : undefined }}>
        <Icon name={icon} size={18} />
      </button>
      {open && <div className={className} onClick={e => e.stopPropagation()}>{children}</div>}
    </div>
  );
}

function Equalizer() {
  const p = usePlayer();
  const active = p.eqEnabled && p.eqGains.some(g => g !== 0);
  return <Popover icon="sliders" title="Equalizer" active={active} className="eq-panel"><EqControls /></Popover>;
}

/* ------------------------------------------------------------- Queue */
function QueuePanel() {
  const p = usePlayer();
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  const onDrop = (to) => {
    if (dragFrom != null && to != null && dragFrom !== to) p.moveInQueue(dragFrom, to);
    setDragFrom(null); setDragOver(null);
  };

  return (
    <Popover icon="queue" title="Play queue" className="queue-panel">
      <div className="eq-head"><span>Queue</span><span className="queue-count">{p.queue.length} tracks</span></div>
      <div className="queue-list">
        {p.queue.map((t, i) => (
          <div key={`${t.deezer_id || t.id}-${i}`}
            className={`queue-row ${i === p.index ? 'current' : ''} ${i < p.index ? 'played' : ''} ${dragOver === i ? 'drag-over' : ''} ${dragFrom === i ? 'dragging' : ''}`}
            draggable
            onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== i) setDragOver(i); }}
            onDrop={(e) => { e.preventDefault(); onDrop(i); }}
            onDragEnd={() => { setDragFrom(null); setDragOver(null); }}>
            <span className="queue-grip" title="Drag to reorder"><Icon name="grip" size={16} /></span>
            <button className="queue-main" onClick={() => p.playAt(i)} title="Play">
              <span className="queue-idx">{i === p.index && p.playing ? <span className="eq"><i /><i /><i /></span> : i + 1}</span>
              <span className="queue-meta">
                <span className="queue-title">{t.title}</span>
                <span className="queue-artist">{t.artist}</span>
              </span>
            </button>
            <div className="queue-actions">
              <button className="icon-btn" disabled={i === 0} onClick={() => p.moveInQueue(i, i - 1)} title="Move up">↑</button>
              <button className="icon-btn" disabled={i === p.queue.length - 1} onClick={() => p.moveInQueue(i, i + 1)} title="Move down">↓</button>
              <button className="icon-btn" onClick={() => p.removeFromQueue(i)} title="Remove"><Icon name="close" size={14} /></button>
            </div>
          </div>
        ))}
        {!p.queue.length && <div className="state faint">Queue is empty.</div>}
      </div>
    </Popover>
  );
}

/* ------------------------------------------------------------- Lyrics */
// Lyrics popover for the currently-playing track. Shows time-synced lyrics with
// the active line highlighted (click a line to seek), or plain lyrics as a
// fallback. Data comes from the server's /api/lyrics (LRCLIB-backed).
function Lyrics() {
  const p = usePlayer();
  const ref = useRef(null);
  const activeRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState({ loading: false, synced: [], plain: '', err: null });
  const id = p.current ? (p.current.deezer_id || p.current.id) : null;

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    if (!open || !id) return;
    setSt({ loading: true, synced: [], plain: '', err: null });
    api.get(`/api/lyrics/${id}`)
      .then(d => setSt({ loading: false, synced: d.synced || [], plain: d.plain || '', err: null }))
      .catch(e => setSt({ loading: false, synced: [], plain: '', err: e.message }));
  }, [open, id]);

  let active = -1;
  for (let k = 0; k < st.synced.length; k++) { if (st.synced[k].time <= p.time + 0.25) active = k; else break; }
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [active]);

  return (
    <div className="eq-wrap" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen(o => !o)} title="Lyrics"
        style={{ color: open ? 'var(--accent)' : undefined }}>
        <Icon name="lyrics" size={18} />
      </button>
      {open && (
        <div className="lyrics-panel" onClick={e => e.stopPropagation()}>
          <div className="eq-head"><span>Lyrics</span>{p.current && <span className="queue-count">{p.current.title}</span>}</div>
          <div className="lyrics-body">
            {st.loading && <div className="state faint">Loading…</div>}
            {!st.loading && st.err && <div className="state faint">No lyrics found.</div>}
            {!st.loading && !st.err && st.synced.length > 0 && st.synced.map((l, k) => (
              <p key={k} ref={k === active ? activeRef : null}
                className={`lyrics-line ${k === active ? 'active' : ''} ${k < active ? 'past' : ''}`}
                onClick={() => p.seek(l.time)}>{l.text || '♪'}</p>
            ))}
            {!st.loading && !st.err && !st.synced.length && st.plain && <pre className="lyrics-plain">{st.plain}</pre>}
            {!st.loading && !st.err && !st.synced.length && !st.plain && <div className="state faint">No lyrics.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------- Listen Together */
// Synchronized group playback. The host's player drives the session; guests
// poll and follow the host's current track / position / play-state. Polling
// (every ~2.5s) keeps everyone loosely in sync without any realtime transport.
const parseUTC = (s) => (s ? Date.parse(s.replace(' ', 'T') + 'Z') : 0);

function ListenTogether() {
  const p = usePlayer();
  const [session, setSession] = useState(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  // Live player snapshot for the sync loops (avoids stale closures in intervals).
  const liveRef = useRef({});
  liveRef.current = { id: p.current ? (p.current.deezer_id || p.current.id) : null, time: p.time, playing: p.playing };
  const loadedTrackRef = useRef(null);
  const isHost = !!session?.is_host;

  const gone = useCallback(() => { setSession(null); loadedTrackRef.current = null; }, []);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // Resume an in-progress session after a reload.
  useEffect(() => { api.get('/api/listen/active').then(r => { if (r.active) setSession(r.session); }).catch(() => {}); }, []);

  // HOST: push playback state on a timer and refresh the member list.
  useEffect(() => {
    if (!session || !isHost) return;
    const push = () => {
      const { id, time, playing } = liveRef.current;
      api.post(`/api/listen/${session.id}/state`, { track_id: id, position: time, is_playing: playing }).catch(() => {});
    };
    push();
    const t = setInterval(push, 2500);
    const m = setInterval(() => api.get(`/api/listen/${session.id}`).then(setSession).catch(gone), 5000);
    return () => { clearInterval(t); clearInterval(m); };
  }, [session?.id, isHost, gone]);

  // Push immediately when the host's track or play/pause state changes.
  useEffect(() => {
    if (!session || !isHost) return;
    const { id, time, playing } = liveRef.current;
    api.post(`/api/listen/${session.id}/state`, { track_id: id, position: time, is_playing: playing }).catch(() => {});
  }, [liveRef.current.id, p.playing, session?.id, isHost]);

  // GUEST: poll and follow the host.
  useEffect(() => {
    if (!session || isHost) return;
    let alive = true;
    const tick = async () => {
      let st;
      try { st = await api.get(`/api/listen/${session.id}`); } catch { gone(); return; }
      if (!alive) return;
      setSession(st);
      const tr = st.track;
      if (st.track_id && tr && (tr.available || tr.file_path)) {
        if (loadedTrackRef.current !== st.track_id) {
          loadedTrackRef.current = st.track_id;
          p.playTrack({ deezer_id: tr.deezer_id, title: tr.title, artist: tr.artist, album: tr.album,
            album_id: tr.album_id, cover: tr.cover, duration: tr.duration, available: true });
        }
        const drift = st.is_playing ? Math.max(0, (parseUTC(st.server_time) - parseUTC(st.updated_at)) / 1000) : 0;
        const target = (st.position || 0) + drift;
        const { time: ctime, playing: cplaying } = liveRef.current;
        if (Math.abs((ctime || 0) - target) > 2.5) p.seek(target);
        if (st.is_playing && !cplaying) p.play();
        if (!st.is_playing && cplaying) p.pause();
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [session?.id, isHost, gone]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => { setBusy(true); setErr(''); try { setSession(await api.post('/api/listen/start')); } catch (e) { setErr(e.message); } setBusy(false); };
  const join = async () => { setBusy(true); setErr(''); try { setSession(await api.post('/api/listen/join', { code: code.trim() })); setCode(''); } catch (e) { setErr(e.message); } setBusy(false); };
  const leave = async () => { if (session) { try { await api.post(`/api/listen/${session.id}/leave`); } catch { /* ignore */ } } gone(); };

  const active = !!session;
  return (
    <div className="eq-wrap" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen(o => !o)} title="Listen together"
        style={{ color: active || open ? 'var(--accent)' : undefined }}>
        <Icon name="users" size={18} />
      </button>
      {open && (
        <div className="listen-panel" onClick={e => e.stopPropagation()}>
          <div className="eq-head"><span>Listen together</span>{active && <span className="np-live"><span className="np-dot" /> live</span>}</div>
          {!active ? (
            <div className="listen-body">
              <p className="settings-fieldhint">Play music in sync with friends on this server.</p>
              <button className="btn-primary" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start a session'}</button>
              <div className="listen-or">or join with a code</div>
              <div className="listen-join">
                <input className="settings-input mono" placeholder="CODE" maxLength={8}
                  value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
                <button className="btn-ghost" onClick={join} disabled={busy || !code.trim()}>Join</button>
              </div>
              {err && <p className="settings-msg err">{err}</p>}
            </div>
          ) : (
            <div className="listen-body">
              {isHost ? (
                <>
                  <p className="settings-fieldhint">Share this code so others can join:</p>
                  <div className="listen-code mono">{session.code}</div>
                </>
              ) : (
                <p className="settings-fieldhint">Listening with <b>{session.host_name}</b>.</p>
              )}
              {session.track
                ? <div className="listen-now">♪ {session.track.title} · {session.track.artist}{!session.track.available && !isHost ? ' (not on your disk)' : ''}</div>
                : <div className="settings-fieldhint">Nothing playing yet{isHost ? ' — start a track to share it.' : '.'}</div>}
              <div className="listen-members">
                {session.members?.map(m => (
                  <div key={m.id} className="listen-member">
                    <Icon name="user" size={14} /> {m.username}{m.is_host ? <span className="listen-host">host</span> : null}
                  </div>
                ))}
              </div>
              <button className="btn-ghost" onClick={leave}>{isHost ? 'End session' : 'Leave session'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Login */
function Login({ onLogin }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { const me = await api.post('/api/auth/login', { username: u, password: p }); onLogin(me); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" /> Musicarr</div>
        <p className="login-tag">Your music, your server.</p>
        <input placeholder="Username" value={u} onChange={e => setU(e.target.value)} autoFocus />
        <input placeholder="Password" type="password" value={p} onChange={e => setP(e.target.value)} />
        {err && <div className="login-err">{err}</div>}
        <button className="btn-primary lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

/* ------------------------------------------- Forced password change */
// Shown when a user (the seeded default-credential admin) must rotate their
// password before using the app.
function ForcePasswordChange({ onDone }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (next.length < 8) return setErr('New password must be at least 8 characters');
    if (next !== confirm) return setErr('Passwords do not match');
    setBusy(true);
    try { await api.post('/api/auth/password', { current: cur, next }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" /> Musicarr</div>
        <p className="login-tag">Choose a new password to continue</p>
        <p className="settings-hint" style={{ textAlign: 'center' }}>
          You're using the default password. Set a new one (at least 8 characters) to secure your server.
        </p>
        <input type="password" placeholder="Current password" value={cur} onChange={e => setCur(e.target.value)} autoFocus />
        <input type="password" placeholder="New password" value={next} onChange={e => setNext(e.target.value)} />
        <input type="password" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} />
        {err && <div className="login-err">{err}</div>}
        <button className="btn-primary lg" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------- Sidebar */
function Sidebar({ route, nav, me, onLogout }) {
  const [playlists, setPlaylists] = useState([]);
  const load = useCallback(async () => { try { setPlaylists(await api.get('/api/playlists')); } catch {} }, []);
  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener('musicarr:playlists-changed', h);
    return () => window.removeEventListener('musicarr:playlists-changed', h);
  }, [load]);

  const createPlaylist = async () => {
    const name = prompt('New playlist name');
    if (!name) return;
    const pl = await api.post('/api/playlists', { name });
    load(); nav({ view: 'playlist', id: pl.id });
  };

  const NavItem = ({ view, icon, label }) => (
    <button className={`nav-item ${route.view === view ? 'active' : ''}`} onClick={() => nav({ view })}>
      <Icon name={icon} size={22} /> {label}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="brand" onClick={() => nav({ view: 'home' })}><span className="brand-mark" /> Musicarr</div>
      <nav className="nav-main">
        <NavItem view="home" icon="home" label="Home" />
        <NavItem view="search" icon="search" label="Search" />
        <NavItem view="explore" icon="compass" label="Explore" />
        <NavItem view="mixes" icon="sparkles" label="Made for you" />
        <NavItem view="library" icon="library" label="Library" />
        <NavItem view="favorites" icon="heart" label="Liked songs" />
        <NavItem view="following" icon="user" label="Following" />
        <NavItem view="offline" icon="save" label="Offline" />
        <NavItem view="downloads" icon="download" label="Downloads" />
      </nav>
      <div className="nav-divider" />
      <nav className="nav-main">
        <NavItem view="stats" icon="chart" label="Your stats" />
        <NavItem view="equalizer" icon="sliders" label="Equalizer" />
        <NavItem view="profile" icon="user" label="Profile" />
        {!!me.is_admin && <NavItem view="admin" icon="user" label="Users" />}
        {!!me.is_admin && <NavItem view="settings" icon="settings" label="Settings" />}
      </nav>
      <div className="pl-head">
        <span>Playlists</span>
        <button className="icon-btn" onClick={createPlaylist} title="New playlist"><Icon name="plus" size={18} /></button>
      </div>
      <div className="pl-scroll">
        {playlists.map(pl => (
          <button key={pl.id} className={`pl-link ${route.view === 'playlist' && route.id === pl.id ? 'active' : ''}`}
            onClick={() => nav({ view: 'playlist', id: pl.id })}>
            <Cover src={pl.cover} size={40} />
            <div className="pl-link-meta">
              <div className="pl-link-name">{pl.name}</div>
              <div className="pl-link-sub">{pl.shared ? `Shared by ${pl.owner_name}` : `${pl.count} tracks`}</div>
            </div>
          </button>
        ))}
      </div>
      <div className="user-foot">
        <button className={`user-link ${route.view === 'profile' ? 'active' : ''}`} onClick={() => nav({ view: 'profile' })} title="Profile">
          <Icon name="user" size={18} />
          <span className="user-name">{me.username}</span>
        </button>
        <button className="icon-btn" onClick={onLogout} title="Sign out"><Icon name="logout" size={18} /></button>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------- Friend activity */
// Persistent right-hand panel showing what the people you follow are playing
// (like Spotify's Friend Activity). Polls the following feed.
function ActivityPanel({ nav, onClose }) {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    const load = () => api.get('/api/social/following').then(setPeople).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  return (
    <aside className="activity">
      <div className="activity-head"><span>Friend activity</span>
        <button className="icon-btn" onClick={onClose} title="Hide"><Icon name="close" size={16} /></button>
      </div>
      {people.length ? people.map(u => (
        <button key={u.id} className="activity-row" onClick={() => nav({ view: 'user', id: u.id })}>
          <div className="user-avatar sm"><Icon name="user" size={16} /></div>
          <div className="activity-meta">
            <div className="activity-name">{u.username}</div>
            <div className="activity-sub">
              {u.nowPlaying
                ? <span className="np-live"><span className="np-dot" /> {u.nowPlaying.title} · {u.nowPlaying.artist}</span>
                : (u.lastPlayed ? `${u.lastPlayed.title} · ${u.lastPlayed.artist || ''}` : 'Not listening')}
            </div>
          </div>
        </button>
      )) : <div className="state faint">Follow people (from Search or their profile) to see their activity here.</div>}
    </aside>
  );
}

/* ----------------------------------------------------------- Player bar */
function PlayerBar({ onToggleActivity, activityOpen }) {
  const p = usePlayer();
  const [seekVal, setSeekVal] = useState(null);
  const scrubbing = useRef(false);
  // Commit the scrub on release anywhere on the page, so the time display can
  // never get stuck frozen if the pointer is released off the slider.
  useEffect(() => {
    const end = () => {
      if (!scrubbing.current) return;
      scrubbing.current = false;
      setSeekVal(v => { if (v != null) p.seek(v); return null; });
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, [p.seek]);
  if (!p.current) return <footer className="player empty">Nothing playing</footer>;
  const t = p.current;
  const pct = p.duration ? ((seekVal ?? p.time) / p.duration) * 100 : 0;
  return (
    <footer className="player">
      <div className="player-track">
        <Cover src={t.cover} size={56} />
        <div className="player-meta">
          <div className="player-title">{t.title}</div>
          <div className="player-artist">{t.artist}</div>
        </div>
      </div>
      <div className="player-center">
        <div className="player-controls">
          <button className="icon-btn" onClick={p.prev} disabled={!p.hasPrev}><Icon name="prev" size={20} fill="currentColor" /></button>
          <button className="play-btn" onClick={p.toggle}><Icon name={p.playing ? 'pause' : 'play'} size={22} fill="currentColor" /></button>
          <button className="icon-btn" onClick={p.next} disabled={!p.hasNext}><Icon name="next" size={20} fill="currentColor" /></button>
          <button className={`icon-btn repeat-btn ${p.repeat !== 'off' ? 'on' : ''}`} onClick={p.cycleRepeat}
            title={p.repeat === 'off' ? 'Repeat: off' : p.repeat === 'all' ? 'Repeat: queue' : 'Repeat: this track'}>
            <Icon name="repeat" size={16} />
            {p.repeat === 'one' && <span className="repeat-badge">1</span>}
          </button>
        </div>
        <div className="player-seek">
          <span className="t">{fmtTime(seekVal ?? p.time)}</span>
          <input type="range" min={0} max={p.duration || 0} step="0.5" value={seekVal ?? p.time}
            onPointerDown={() => { scrubbing.current = true; }}
            onChange={e => { const v = parseFloat(e.target.value); if (scrubbing.current) setSeekVal(v); else p.seek(v); }}
            style={{ '--pct': `${pct}%` }} />
          <span className="t">{fmtTime(p.duration)}</span>
        </div>
      </div>
      <div className="player-right">
        <button className="icon-btn" onClick={onToggleActivity} title="Friend activity"
          style={{ color: activityOpen ? 'var(--accent)' : undefined }}>
          <Icon name="user" size={18} />
        </button>
        <ListenTogether />
        <Lyrics />
        <QueuePanel />
        <Equalizer />
        <Icon name="vol" size={18} />
        <input className="vol" type="range" min={0} max={1} step="0.01" value={p.volume}
          onChange={e => p.setVolume(parseFloat(e.target.value))} style={{ '--pct': `${p.volume * 100}%` }} />
      </div>
    </footer>
  );
}

/* ----------------------------------------------------------- URL routing */
// Keep the current view in the address bar so a refresh restores it (the
// server serves index.html for any non-API path, so deep links work too).
const VIEWS_WITH_ID = new Set(['artist', 'album', 'playlist', 'dplaylist', 'genre', 'user']);
const VIEWS_WITH_SLUG = new Set(['mood', 'mix']); // string id rather than numeric

function routeToPath({ view, id }) {
  if (view === 'home') return '/';
  return (VIEWS_WITH_ID.has(view) || VIEWS_WITH_SLUG.has(view)) && id != null ? `/${view}/${id}` : `/${view}`;
}

function parsePath(pathname) {
  const [, view, rawId] = pathname.split('/');
  if (!view) return { view: 'home' };
  if (VIEWS_WITH_SLUG.has(view)) return rawId ? { view, id: decodeURIComponent(rawId) } : { view: 'home' };
  if (VIEWS_WITH_ID.has(view)) {
    const id = Number(rawId);
    return Number.isFinite(id) ? { view, id } : { view: 'home' };
  }
  return { view };
}

/* ------------------------------------------------------------------ App */
function App() {
  const [me, setMe] = useState(undefined); // undefined = loading
  const [route, setRoute] = useState(() => parsePath(window.location.pathname));
  const [depth, setDepth] = useState(0); // in-app history depth, for the back button
  const [activityOpen, setActivityOpen] = useState(() => localStorage.getItem('musicarr:activity') !== '0');
  const toggleActivity = useCallback(() => setActivityOpen(o => { localStorage.setItem('musicarr:activity', o ? '0' : '1'); return !o; }), []);

  useEffect(() => { api.get('/api/auth/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => {
    const h = () => setMe(null);
    window.addEventListener('musicarr:unauth', h);
    return () => window.removeEventListener('musicarr:unauth', h);
  }, []);

  // Seed history state for the initial route, and follow browser back/forward.
  useEffect(() => {
    window.history.replaceState({ route }, '', routeToPath(route));
    const onPop = (e) => {
      setRoute(e.state?.route || parsePath(window.location.pathname));
      setDepth(d => Math.max(0, d - 1));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const nav = useCallback((r) => {
    window.history.pushState({ route: r }, '', routeToPath(r));
    setRoute(r);
    setDepth(d => d + 1);
    document.querySelector('.main-scroll')?.scrollTo(0, 0);
  }, []);
  const back = useCallback(() => { window.history.back(); }, []);

  const logout = async () => { await api.post('/api/auth/logout'); setMe(null); };

  if (me === undefined) return <div className="login"><Icon name="spinner" size={32} /></div>;
  if (me === null) return <Login onLogin={setMe} />;
  if (me.must_change_password) return <ForcePasswordChange onDone={() => setMe({ ...me, must_change_password: false })} />;

  let page;
  switch (route.view) {
    case 'home': page = <Home nav={nav} />; break;
    case 'search': page = <Search nav={nav} />; break;
    case 'explore': page = <Explore nav={nav} />; break;
    case 'mixes': page = <MadeForYou nav={nav} />; break;
    case 'mix': page = <Mix id={route.id} nav={nav} />; break;
    case 'stats': page = <Stats nav={nav} />; break;
    case 'offline': page = <Offline nav={nav} />; break;
    case 'genre': page = <Genre id={route.id} nav={nav} />; break;
    case 'mood': page = <Mood slug={route.id} nav={nav} />; break;
    case 'dplaylist': page = <DeezerPlaylist id={route.id} nav={nav} />; break;
    case 'artist': page = <Artist id={route.id} nav={nav} />; break;
    case 'album': page = <Album id={route.id} nav={nav} />; break;
    case 'library': page = <Library me={me} nav={nav} />; break;
    case 'favorites': page = <Favorites nav={nav} />; break;
    case 'following': page = <Following nav={nav} />; break;
    case 'playlist': page = <Playlist id={route.id} nav={nav} />; break;
    case 'downloads': page = <Downloads nav={nav} />; break;
    case 'user': page = <UserProfile id={route.id} nav={nav} />; break;
    case 'admin': page = <Admin me={me} nav={nav} />; break;
    case 'settings': page = <Settings />; break;
    case 'profile': page = <Profile me={me} nav={nav} />; break;
    case 'equalizer': page = <EqualizerPage />; break;
    default: page = <Home nav={nav} />;
  }

  return (
    <MeContext.Provider value={me}>
      <div className={`app ${activityOpen ? 'with-activity' : ''}`}>
        <Sidebar route={route} nav={nav} me={me} onLogout={logout} />
        <main className="main">
          <div className="topbar">
            <button className="round-btn" onClick={back} disabled={!depth} title="Back">‹</button>
            <button className={`round-btn topbar-activity ${activityOpen ? 'on' : ''}`} onClick={toggleActivity}
              title="Friend activity"><Icon name="user" size={18} /></button>
          </div>
          <div className="main-scroll" key={route.view + (route.id || '')}>{page}</div>
        </main>
        {activityOpen && <ActivityPanel nav={nav} onClose={toggleActivity} />}
        <PlayerBar onToggleActivity={toggleActivity} activityOpen={activityOpen} />
      </div>
    </MeContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <PlayerProvider><App /></PlayerProvider>
);

// Register the service worker for offline support / installable PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('[sw] registration failed:', err));
  });
}
