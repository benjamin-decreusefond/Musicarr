import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { api, fmtTime, PlayerProvider, usePlayer } from './store.jsx';
import { Icon, Cover } from './ui.jsx';
import { Home, Search, Artist, Album, Library, Favorites, Playlist, Downloads, Admin, Settings } from './views.jsx';
import './styles.css';

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
        <div className="brand"><span className="brand-mark" /> Tonearr</div>
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
    window.addEventListener('tonearr:playlists-changed', h);
    return () => window.removeEventListener('tonearr:playlists-changed', h);
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
      <div className="brand" onClick={() => nav({ view: 'home' })}><span className="brand-mark" /> Tonearr</div>
      <nav className="nav-main">
        <NavItem view="home" icon="home" label="Home" />
        <NavItem view="search" icon="search" label="Search" />
        <NavItem view="library" icon="library" label="Library" />
      </nav>
      <div className="nav-divider" />
      <nav className="nav-main">
        <NavItem view="favorites" icon="heart" label="Liked songs" />
        <NavItem view="downloads" icon="download" label="Downloads" />
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
        <Icon name="user" size={18} />
        <span className="user-name">{me.username}</span>
        <button className="icon-btn" onClick={onLogout} title="Sign out"><Icon name="logout" size={18} /></button>
      </div>
    </aside>
  );
}

/* ----------------------------------------------------------- Player bar */
function PlayerBar() {
  const p = usePlayer();
  const [seekVal, setSeekVal] = useState(null);
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
        </div>
        <div className="player-seek">
          <span className="t">{fmtTime(seekVal ?? p.time)}</span>
          <input type="range" min={0} max={p.duration || 0} step="0.5" value={seekVal ?? p.time}
            onChange={e => setSeekVal(parseFloat(e.target.value))}
            onMouseUp={e => { p.seek(parseFloat(e.target.value)); setSeekVal(null); }}
            onTouchEnd={e => { p.seek(parseFloat(e.target.value)); setSeekVal(null); }}
            style={{ '--pct': `${pct}%` }} />
          <span className="t">{fmtTime(p.duration)}</span>
        </div>
      </div>
      <div className="player-right">
        <Icon name="vol" size={18} />
        <input className="vol" type="range" min={0} max={1} step="0.01" value={p.volume}
          onChange={e => p.setVolume(parseFloat(e.target.value))} style={{ '--pct': `${p.volume * 100}%` }} />
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ App */
function App() {
  const [me, setMe] = useState(undefined); // undefined = loading
  const [route, setRoute] = useState({ view: 'home' });
  const [history, setHistory] = useState([]);

  useEffect(() => { api.get('/api/auth/me').then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => {
    const h = () => setMe(null);
    window.addEventListener('tonearr:unauth', h);
    return () => window.removeEventListener('tonearr:unauth', h);
  }, []);

  const nav = useCallback((r) => {
    setRoute(prev => { setHistory(h => [...h, prev]); return r; });
    document.querySelector('.main-scroll')?.scrollTo(0, 0);
  }, []);
  const back = useCallback(() => {
    setHistory(h => { if (!h.length) return h; const prev = h[h.length - 1]; setRoute(prev); return h.slice(0, -1); });
  }, []);

  const logout = async () => { await api.post('/api/auth/logout'); setMe(null); };

  if (me === undefined) return <div className="login"><Icon name="spinner" size={32} /></div>;
  if (me === null) return <Login onLogin={setMe} />;

  let page;
  switch (route.view) {
    case 'home': page = <Home nav={nav} />; break;
    case 'search': page = <Search nav={nav} />; break;
    case 'artist': page = <Artist id={route.id} nav={nav} />; break;
    case 'album': page = <Album id={route.id} nav={nav} />; break;
    case 'library': page = <Library />; break;
    case 'favorites': page = <Favorites />; break;
    case 'playlist': page = <Playlist id={route.id} />; break;
    case 'downloads': page = <Downloads />; break;
    case 'admin': page = <Admin me={me} />; break;
    case 'settings': page = <Settings />; break;
    default: page = <Home nav={nav} />;
  }

  return (
    <div className="app">
      <Sidebar route={route} nav={nav} me={me} onLogout={logout} />
      <main className="main">
        <div className="topbar">
          <button className="round-btn" onClick={back} disabled={!history.length} title="Back">‹</button>
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
