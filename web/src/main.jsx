import { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { api, fmtTime, PlayerProvider, usePlayer, EQ_LABELS, EQ_PRESETS } from './store.jsx';
import { Icon, Cover } from './ui.jsx';
import { Home, Search, Explore, Genre, Artist, Album, Library, Available, Favorites, Playlist, DeezerPlaylist, Downloads, Admin, Settings, Profile } from './views.jsx';
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
        <NavItem view="library" icon="library" label="Library" />
        <NavItem view="available" icon="check" label="Available" />
      </nav>
      <div className="nav-divider" />
      <nav className="nav-main">
        <NavItem view="favorites" icon="heart" label="Liked songs" />
        <NavItem view="downloads" icon="download" label="Downloads" />
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
              <div className="pl-link-sub">{pl.count} tracks</div>
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

/* ----------------------------------------------------------- Player bar */
function PlayerBar() {
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
const VIEWS_WITH_ID = new Set(['artist', 'album', 'playlist', 'dplaylist', 'genre']);

function routeToPath({ view, id }) {
  if (view === 'home') return '/';
  return VIEWS_WITH_ID.has(view) && id != null ? `/${view}/${id}` : `/${view}`;
}

function parsePath(pathname) {
  const [, view, rawId] = pathname.split('/');
  if (!view) return { view: 'home' };
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

  let page;
  switch (route.view) {
    case 'home': page = <Home nav={nav} />; break;
    case 'search': page = <Search nav={nav} />; break;
    case 'explore': page = <Explore nav={nav} />; break;
    case 'genre': page = <Genre id={route.id} nav={nav} />; break;
    case 'dplaylist': page = <DeezerPlaylist id={route.id} nav={nav} />; break;
    case 'artist': page = <Artist id={route.id} nav={nav} />; break;
    case 'album': page = <Album id={route.id} nav={nav} />; break;
    case 'library': page = <Library nav={nav} />; break;
    case 'available': page = <Available />; break;
    case 'favorites': page = <Favorites />; break;
    case 'playlist': page = <Playlist id={route.id} />; break;
    case 'downloads': page = <Downloads />; break;
    case 'admin': page = <Admin me={me} />; break;
    case 'settings': page = <Settings />; break;
    case 'profile': page = <Profile me={me} />; break;
    case 'equalizer': page = <EqualizerPage />; break;
    default: page = <Home nav={nav} />;
  }

  return (
    <div className="app">
      <Sidebar route={route} nav={nav} me={me} onLogout={logout} />
      <main className="main">
        <div className="topbar">
          <button className="round-btn" onClick={back} disabled={!depth} title="Back">‹</button>
        </div>
        <div className="main-scroll" key={route.view + (route.id || '')}>{page}</div>
      </main>
      <PlayerBar />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <PlayerProvider><App /></PlayerProvider>
);
