import { useState, useEffect, useCallback } from 'react';
import { api, usePlayer } from './store.jsx';
import { Icon, Cover, TrackRow, CardRow, TileCard, DownloadButton, HeartButton, AddToPlaylist } from './ui.jsx';

function useAsync(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    fn().then(d => { if (alive) { setData(d); setLoading(false); } })
        .catch(e => { if (alive) { setErr(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, deps);
  return { data, err, loading, setData };
}

const Loading = () => <div className="state"><Icon name="spinner" size={28} /></div>;
const ErrState = ({ msg }) => <div className="state err">{msg}</div>;

/* ----------------------------------------------------------------- Home */
/** "+" button on a Deezer playlist tile: imports it as a local playlist and
 *  queues downloads for whatever isn't on disk yet. */
function ImportPlaylistButton({ playlist, nav }) {
  const [state, setState] = useState('idle'); // idle | busy | done
  const go = async (e) => {
    e.stopPropagation();
    setState('busy');
    try {
      const r = await api.post('/api/playlists/import-deezer', { deezer_playlist_id: playlist.id });
      window.dispatchEvent(new Event('musicarr:playlists-changed'));
      setState('done');
      nav({ view: 'playlist', id: r.id });
    } catch (err) {
      alert(err.message);
      setState('idle');
    }
  };
  return (
    <button className="icon-btn" onClick={go} disabled={state !== 'idle'}
      title={`Add "${playlist.title}" to your playlists and download missing tracks`}>
      <Icon name={state === 'busy' ? 'spinner' : state === 'done' ? 'check' : 'plus'} size={18} />
    </button>
  );
}

export function Home({ nav }) {
  const { data, err, loading } = useAsync(() => api.get('/api/home'), []);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="page">
      <h1 className="page-h1">{greet}</h1>
      <CardRow title="Trending artists">
        {data.artists.map(a => (
          <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Artist"
            onClick={() => nav({ view: 'artist', id: a.id })} />
        ))}
      </CardRow>
      <CardRow title="Popular albums">
        {data.albums.map(a => (
          <TileCard key={a.id} cover={a.cover} title={a.title} sub={a.artist}
            onClick={() => nav({ view: 'album', id: a.id })}
            actions={<DownloadButton kind="album" id={a.id} label={a.title} />} />
        ))}
      </CardRow>
      {!!data.playlists?.length && (
        <CardRow title="Trending playlists">
          {data.playlists.map(p => (
            <TileCard key={p.id} cover={p.cover} title={p.title} sub={`${p.nb_tracks} tracks · ${p.by}`}
              actions={<ImportPlaylistButton playlist={p} nav={nav} />} />
          ))}
        </CardRow>
      )}
      <section className="page-block">
        <h2 className="row-title">Charts</h2>
        <div className="track-list">
          {data.tracks.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={data.tracks} showAlbum />)}
        </div>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- Search */
const SEARCH_HISTORY_KEY = 'musicarr:search:history';
const loadHistory = () => { try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY)) || []; } catch { return []; } };

export function Search({ nav }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [trending, setTrending] = useState(null);

  // Suggestions for the empty state (server-side cached, so this is cheap).
  useEffect(() => { api.get('/api/home').then(setTrending).catch(() => {}); }, []);

  const remember = useCallback((term) => {
    const t = term.trim();
    if (!t) return;
    setHistory(prev => {
      const next = [t, ...prev.filter(x => x.toLowerCase() !== t.toLowerCase())].slice(0, 10);
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const clearHistory = () => { localStorage.removeItem(SEARCH_HISTORY_KEY); setHistory([]); };

  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    setLoading(true);
    const id = setTimeout(async () => {
      try {
        const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
        setRes(r);
        if ((r.artists.length || r.albums.length || r.tracks.length)) remember(q);
      } catch {}
      setLoading(false);
    }, 350);
    return () => clearTimeout(id);
  }, [q, remember]);

  return (
    <div className="page">
      <div className="search-box">
        <Icon name="search" size={20} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder="Artists, albums, or tracks to find and download" />
      </div>
      {!q.trim() && !!history.length && (
        <section className="page-block">
          <div className="recent-head">
            <h2 className="row-title">Recent searches</h2>
            <button className="btn-ghost sm" onClick={clearHistory}>Clear</button>
          </div>
          <div className="chip-row">
            {history.map(term => (
              <button key={term} className="chip" onClick={() => setQ(term)}>
                <Icon name="search" size={14} /> {term}
              </button>
            ))}
          </div>
        </section>
      )}
      {loading && <Loading />}
      {res && !loading && (
        <>
          {!!res.artists.length && (
            <CardRow title="Artists">
              {res.artists.map(a => (
                <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Artist"
                  onClick={() => nav({ view: 'artist', id: a.id })} />
              ))}
            </CardRow>
          )}
          {!!res.albums.length && (
            <CardRow title="Albums">
              {res.albums.map(a => (
                <TileCard key={a.id} cover={a.cover} title={a.title}
                  sub={`${a.artist} · ${a.nb_tracks} tracks`} badge={a.available ? 'In library' : null}
                  onClick={() => nav({ view: 'album', id: a.id })}
                  actions={<DownloadButton kind="album" id={a.id} label={a.title} />} />
              ))}
            </CardRow>
          )}
          {!!res.tracks.length && (
            <section className="page-block">
              <h2 className="row-title">Tracks</h2>
              <div className="track-list">
                {res.tracks.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={res.tracks} showAlbum />)}
              </div>
            </section>
          )}
          {!res.artists.length && !res.albums.length && !res.tracks.length && (
            <div className="state">No results for "{q}"</div>
          )}
        </>
      )}
      {!q.trim() && !loading && trending && (
        <>
          {!!trending.artists?.length && (
            <CardRow title="Trending on Deezer">
              {trending.artists.slice(0, 12).map(a => (
                <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Artist"
                  onClick={() => nav({ view: 'artist', id: a.id })} />
              ))}
            </CardRow>
          )}
          {!!trending.albums?.length && (
            <CardRow title="Popular albums right now">
              {trending.albums.slice(0, 12).map(a => (
                <TileCard key={a.id} cover={a.cover} title={a.title} sub={a.artist}
                  onClick={() => nav({ view: 'album', id: a.id })}
                  actions={<DownloadButton kind="album" id={a.id} label={a.title} />} />
              ))}
            </CardRow>
          )}
        </>
      )}
      {!res && !loading && !history.length && !trending && (
        <div className="state faint">Search anything — if it's not downloaded yet, you can grab it.</div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Artist */
export function Artist({ id, nav }) {
  const { data, err, loading } = useAsync(() => api.get(`/api/artist/${id}`), [id]);
  const player = usePlayer();
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const { artist, top, albums, related } = data;
  const playable = top.filter(t => t.available);
  return (
    <div className="page">
      <header className="hero">
        <Cover src={artist.picture} size={200} round alt={artist.name} />
        <div className="hero-meta">
          <span className="hero-kind">Artist</span>
          <h1 className="hero-title">{artist.name}</h1>
          <span className="hero-sub">{artist.nb_fan?.toLocaleString()} fans</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!playable.length}
              onClick={() => player.playList(top, 0)}>
              <Icon name="play" size={18} fill="currentColor" /> Play
            </button>
          </div>
        </div>
      </header>
      <section className="page-block">
        <h2 className="row-title">Popular</h2>
        <div className="track-list">
          {top.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={top} />)}
        </div>
      </section>
      <CardRow title="Discography">
        {albums.map(a => (
          <TileCard key={a.id} cover={a.cover} title={a.title}
            sub={`${a.record_type === 'single' ? 'Single' : 'Album'} · ${(a.release_date || '').slice(0, 4)}`}
            badge={a.available ? 'In library' : null}
            onClick={() => nav({ view: 'album', id: a.id })}
            actions={<DownloadButton kind="album" id={a.id} label={a.title} />} />
        ))}
      </CardRow>
      {!!related.length && (
        <CardRow title="Fans also like">
          {related.map(a => (
            <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Artist"
              onClick={() => nav({ view: 'artist', id: a.id })} />
          ))}
        </CardRow>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Album */
export function Album({ id, nav }) {
  const { data, err, loading } = useAsync(() => api.get(`/api/album/${id}`), [id]);
  const player = usePlayer();
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const tracks = data.tracks.map(t => ({ ...t, cover: data.cover, album: data.title }));
  const anyAvailable = tracks.some(t => t.available);
  return (
    <div className="page">
      <header className="hero">
        <Cover src={data.cover} size={200} alt={data.title} />
        <div className="hero-meta">
          <span className="hero-kind">Album</span>
          <h1 className="hero-title">{data.title}</h1>
          <span className="hero-sub link" onClick={() => nav({ view: 'artist', id: data.artist_id })}>{data.artist}</span>
          <span className="hero-sub faint">{(data.release_date || '').slice(0, 4)} · {data.nb_tracks} tracks</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!anyAvailable} onClick={() => player.playList(tracks, 0)}>
              <Icon name="play" size={18} fill="currentColor" /> Play
            </button>
            <button className="btn-ghost" onClick={async (e) => {
              const btn = e.currentTarget; btn.disabled = true;
              try { await api.post('/api/download', { kind: 'album', deezer_id: data.id }); btn.textContent = 'Queued ✓'; } catch {}
            }}>
              <Icon name="download" size={18} /> Download album
            </button>
          </div>
        </div>
      </header>
      <p className="settings-hint" style={{ maxWidth: 720 }}>
        Heads up: indexers publish full albums rather than single tracks, so downloading a single
        song actually fetches this whole album. Only the song you pick is added to your library —
        the rest wait under <strong>Available</strong>, ready to add anytime without re-downloading.
      </p>
      <section className="page-block">
        <div className="track-list">
          {tracks.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={tracks} />)}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------- Library */
export function Library({ nav }) {
  const player = usePlayer();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api.get('/api/library').then(setData).catch(e => setErr(e.message)); }, []);
  // Poll so freshly-queued downloads and their status changes show up live.
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  if (err) return <ErrState msg={err} />;
  if (!data) return <Loading />;
  const playable = data.filter(t => t.available);
  return (
    <div className="page">
      <div className="list-head">
        <h1 className="page-h1">Your library</h1>
        <div className="list-head-actions">
          <button className="btn-ghost" onClick={() => nav?.({ view: 'available' })}>Available tracks</button>
          <button className="btn-primary" disabled={!playable.length} onClick={() => player.playList(playable, 0, { shuffle: true })}>
            <Icon name="shuffle" size={18} /> Shuffle play
          </button>
        </div>
      </div>
      {data.length ? (
        <div className="track-list">
          {data.map((t, i) => <TrackRow key={t.deezer_id} track={t} i={i} tracks={data} showAlbum />)}
        </div>
      ) : <div className="state faint">Nothing downloaded yet. Search for music and hit the download button.</div>}
    </div>
  );
}

/* ------------------------------------------------------------ Available */
export function Available() {
  const player = usePlayer();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api.get('/api/available').then(setData).catch(e => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <ErrState msg={err} />;
  if (!data) return <Loading />;
  const addToLibrary = async (ids) => {
    try { await api.post('/api/library', Array.isArray(ids) ? { track_ids: ids } : { track_id: ids }); load(); } catch {}
  };
  return (
    <div className="page">
      <div className="list-head">
        <h1 className="page-h1">Available tracks</h1>
        <div className="list-head-actions">
          {!!data.length && <button className="btn-ghost" onClick={() => addToLibrary(data.map(t => t.deezer_id))}>Add all to library</button>}
          <button className="btn-primary" disabled={!data.length} onClick={() => player.playList(data, 0, { shuffle: true })}>
            <Icon name="shuffle" size={18} /> Shuffle play
          </button>
        </div>
      </div>
      <p className="settings-hint" style={{ maxWidth: 720 }}>
        Indexers almost never publish single tracks — they publish whole albums. So when you download
        one song, Musicarr grabs the album it belongs to and adds only the song you asked for to your
        library. The album's other tracks land here, already downloaded: add any of them to your
        library instantly, with no extra download.
      </p>
      {data.length ? (
        <div className="track-list">
          {data.map((t, i) => (
            <div key={t.deezer_id} className="pl-row">
              <TrackRow track={t} i={i} tracks={data} showAlbum />
              <button className="icon-btn pl-del" title="Add to library" onClick={() => addToLibrary(t.deezer_id)}>
                <Icon name="plus" size={18} />
              </button>
            </div>
          ))}
        </div>
      ) : <div className="state faint">No extra tracks yet. They appear when a single-track download pulls in a full album.</div>}
    </div>
  );
}

/* ------------------------------------------------------------ Favorites */
export function Favorites() {
  const player = usePlayer();
  const { data, err, loading } = useAsync(() => api.get('/api/favorites'), []);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const tracks = (data || []).map(t => ({ ...t, available: !!t.file_path, favorite: true }));
  const playable = tracks.filter(t => t.available);
  return (
    <div className="page">
      <header className="hero">
        <div className="fav-art"><Icon name="heart" size={72} fill="var(--accent-ink)" /></div>
        <div className="hero-meta">
          <span className="hero-kind">Playlist</span>
          <h1 className="hero-title">Liked songs</h1>
          <span className="hero-sub faint">{tracks.length} tracks</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!playable.length} onClick={() => player.playList(playable, 0, { shuffle: true })}>
              <Icon name="shuffle" size={18} /> Shuffle play
            </button>
          </div>
        </div>
      </header>
      <section className="page-block">
        <div className="track-list">
          {tracks.map((t, i) => <TrackRow key={t.deezer_id} track={t} i={i} tracks={tracks} showAlbum />)}
          {!tracks.length && <div className="state faint">Tap the heart on any track to save it here.</div>}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- Playlist */
export function Playlist({ id }) {
  const { data, err, loading, setData } = useAsync(() => api.get(`/api/playlists/${id}`), [id]);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const player = usePlayer();
  const tracks = (data.tracks || []).map(t => ({ ...t, available: !!t.file_path }));
  const playable = tracks.filter(t => t.available);
  const remove = async (trackId) => {
    await api.del(`/api/playlists/${id}/tracks/${trackId}`);
    setData({ ...data, tracks: data.tracks.filter(t => t.deezer_id !== trackId) });
    window.dispatchEvent(new Event('musicarr:playlists-changed'));
  };
  return (
    <div className="page">
      <header className="hero">
        <Cover src={tracks[0]?.cover} size={200} alt={data.name} />
        <div className="hero-meta">
          <span className="hero-kind">Playlist</span>
          <h1 className="hero-title">{data.name}</h1>
          <span className="hero-sub faint">{tracks.length} tracks</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!playable.length}
              onClick={() => player.playList(playable, 0, { shuffle: true })}>
              <Icon name="shuffle" size={18} /> Shuffle play
            </button>
          </div>
        </div>
      </header>
      <section className="page-block">
        <div className="track-list">
          {tracks.map((t, i) => (
            <div key={t.deezer_id} className="pl-row">
              <TrackRow track={t} i={i} tracks={tracks} showAlbum shuffle />
              <button className="icon-btn pl-del" onClick={() => remove(t.deezer_id)} title="Remove"><Icon name="close" size={16} /></button>
            </div>
          ))}
          {!tracks.length && <div className="state faint">This playlist is empty.</div>}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ Downloads */
export function Downloads() {
  const [items, setItems] = useState([]);
  const load = useCallback(async () => { try { setItems(await api.get('/api/downloads')); } catch {} }, []);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  const remove = async (id) => { await api.del(`/api/downloads/${id}`); load(); };
  const statusLabel = { searching: 'Searching', downloading: 'Downloading', importing: 'Importing', done: 'Done', not_found: 'Not found', error: 'Error' };
  return (
    <div className="page">
      <h1 className="page-h1">Downloads</h1>
      <div className="dl-list">
        {items.map(d => (
          <div key={d.id} className="dl-item">
            <Cover src={d.cover} size={52} />
            <div className="dl-main">
              <div className="dl-label">{d.label}</div>
              <div className="dl-detail">{d.detail || statusLabel[d.status]}</div>
              {d.status === 'downloading' && (
                <div className="dl-bar"><div className="dl-bar-fill" style={{ width: `${Math.round(d.progress * 100)}%` }} /></div>
              )}
            </div>
            <span className={`dl-status s-${d.status}`}>{statusLabel[d.status] || d.status}</span>
            <button className="icon-btn" onClick={() => remove(d.id)} title="Dismiss"><Icon name="trash" size={16} /></button>
          </div>
        ))}
        {!items.length && <div className="state faint">No downloads yet.</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Profile */
export function Profile({ me }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (next.length < 4) return setMsg({ err: true, text: 'New password must be at least 4 characters' });
    if (next !== confirm) return setMsg({ err: true, text: 'New passwords do not match' });
    setBusy(true);
    try {
      await api.post('/api/auth/password', { current: cur, next });
      setMsg({ err: false, text: 'Password changed.' });
      setCur(''); setNext(''); setConfirm('');
    } catch (e) { setMsg({ err: true, text: e.message }); }
    setBusy(false);
  };
  return (
    <div className="page">
      <h1 className="page-h1">Profile</h1>
      <section className="page-block settings-section">
        <h2 className="row-title">Account</h2>
        <div className="profile-id">
          <div className="profile-avatar"><Icon name="user" size={28} /></div>
          <div>
            <div className="profile-name">{me.username}</div>
            <div className="settings-fieldhint">{me.is_admin ? 'Administrator' : 'User'}</div>
          </div>
        </div>
      </section>
      <section className="page-block settings-section">
        <h2 className="row-title">Change password</h2>
        <form className="profile-form" onSubmit={submit}>
          <input className="settings-input" type="password" placeholder="Current password"
            autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} />
          <input className="settings-input" type="password" placeholder="New password"
            autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
          <input className="settings-input" type="password" placeholder="Confirm new password"
            autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          <button className="btn-primary" disabled={busy || !cur || !next}>{busy ? 'Saving…' : 'Update password'}</button>
        </form>
        {msg && <p className={`settings-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</p>}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- Settings */
const SETTING_FIELDS = [
  'root_folder', 'jackett_url', 'jackett_api_key', 'jackett_indexer', 'search_categories',
  'transmission_url', 'transmission_user', 'transmission_pass', 'transmission_download_dir',
];

function Field({ label, hint, type = 'text', value, onChange }) {
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <input className="settings-input" type={type} value={value ?? ''} spellCheck={false}
        autoComplete="off" onChange={e => onChange(e.target.value)} />
      {hint && <span className="settings-fieldhint">{hint}</span>}
    </label>
  );
}

export function Settings() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(null);
  const [tested, setTested] = useState({});
  useEffect(() => {
    api.get('/api/settings').then(setS).catch(e => setMsg({ err: true, text: e.message }));
  }, []);
  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload = Object.fromEntries(SETTING_FIELDS.map(k => [k, s[k] ?? '']));
      const next = await api.put('/api/settings', payload);
      setS(next);
      setMsg({ err: false, text: 'Settings saved. Changes apply immediately — no restart needed.' });
    } catch (e) {
      setMsg({ err: true, text: e.message });
    }
    setBusy(false);
  };

  const test = async (section) => {
    setTesting(section); setTested(t => ({ ...t, [section]: null }));
    const body = section === 'jackett'
      ? { section, jackett_url: s.jackett_url, jackett_api_key: s.jackett_api_key, jackett_indexer: s.jackett_indexer }
      : { section, transmission_url: s.transmission_url, transmission_user: s.transmission_user, transmission_pass: s.transmission_pass };
    try {
      await api.post('/api/settings/test', body);
      setTested(t => ({ ...t, [section]: { ok: true, text: 'Connection successful' } }));
    } catch (e) {
      setTested(t => ({ ...t, [section]: { ok: false, text: e.message } }));
    }
    setTesting(null);
  };

  if (!s) return msg ? <ErrState msg={msg.text} /> : <Loading />;
  const TestResult = ({ section }) => {
    const r = tested[section];
    if (!r) return null;
    return <span className={`settings-msg ${r.ok ? 'ok' : 'err'}`}>{r.text}</span>;
  };

  return (
    <div className="page">
      <h1 className="page-h1">Settings</h1>

      <section className="page-block settings-section">
        <h2 className="row-title">Media management</h2>
        <p className="settings-hint">
          Works like Radarr/Sonarr: Transmission downloads into the download directory; when a
          download finishes, Musicarr hardlinks the files into the root folder (Artist/Album/Track)
          and the library plays everything from the root folder. Keep both paths on the same volume
          so hardlinks work — instant, no extra disk space, and torrents keep seeding. On different
          volumes, files are copied instead.
        </p>
        <Field label="Root folder"
          hint="The library: files are hardlinked here and streamed from here, e.g. /data/media/music."
          value={s.root_folder} onChange={v => set('root_folder', v)} />
        <Field label="Transmission download directory"
          hint="Where Transmission saves downloads, e.g. /data/downloads/music. Only scanned when importing finished downloads; mount the shared volume at the same path in both containers."
          value={s.transmission_download_dir} onChange={v => set('transmission_download_dir', v)} />
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Jackett</h2>
        <p className="settings-hint">Indexer aggregator used to find releases.</p>
        <Field label="URL" hint="e.g. http://jackett:9117 (no trailing slash)" value={s.jackett_url} onChange={v => set('jackett_url', v)} />
        <Field label="API key" type="password" value={s.jackett_api_key} onChange={v => set('jackett_api_key', v)} />
        <Field label="Indexer" hint='Indexer id, or "all" to query every configured one' value={s.jackett_indexer} onChange={v => set('jackett_indexer', v)} />
        <Field label="Search categories" hint="Torznab categories, comma-separated (3000 = Audio)" value={s.search_categories} onChange={v => set('search_categories', v)} />
        <div className="settings-actions">
          <button className="btn-ghost" onClick={() => test('jackett')} disabled={testing === 'jackett'}>
            {testing === 'jackett' ? 'Testing…' : 'Test connection'}
          </button>
          <TestResult section="jackett" />
        </div>
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Transmission</h2>
        <p className="settings-hint">BitTorrent client that performs the downloads.</p>
        <Field label="RPC URL" hint="e.g. http://transmission:9091/transmission/rpc" value={s.transmission_url} onChange={v => set('transmission_url', v)} />
        <Field label="Username" hint="Leave blank if RPC auth is disabled" value={s.transmission_user} onChange={v => set('transmission_user', v)} />
        <Field label="Password" type="password" value={s.transmission_pass} onChange={v => set('transmission_pass', v)} />
        <div className="settings-actions">
          <button className="btn-ghost" onClick={() => test('transmission')} disabled={testing === 'transmission'}>
            {testing === 'transmission' ? 'Testing…' : 'Test connection'}
          </button>
          <TestResult section="transmission" />
        </div>
      </section>

      <div className="settings-save">
        <button className="btn-primary lg" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save all settings'}</button>
        {msg && <span className={`settings-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Admin */
export function Admin({ me }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', is_admin: false });
  const load = async () => { try { setUsers(await api.get('/api/users')); } catch {} };
  useEffect(() => { load(); }, []);
  const create = async () => {
    if (!form.username || !form.password) return;
    try { await api.post('/api/users', form); setForm({ username: '', password: '', is_admin: false }); load(); }
    catch (e) { alert(e.message); }
  };
  const del = async (id) => { if (confirm('Delete this user?')) { await api.del(`/api/users/${id}`); load(); } };
  return (
    <div className="page">
      <h1 className="page-h1">Users</h1>
      <div className="admin-form">
        <input placeholder="Username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
        <input placeholder="Password" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
        <label className="chk"><input type="checkbox" checked={form.is_admin} onChange={e => setForm({ ...form, is_admin: e.target.checked })} /> Admin</label>
        <button className="btn-primary" onClick={create}>Add user</button>
      </div>
      <div className="admin-list">
        {users.map(u => (
          <div key={u.id} className="admin-row">
            <Icon name="user" size={18} />
            <span className="admin-name">{u.username}</span>
            {!!u.is_admin && <span className="badge accent">Admin</span>}
            {u.id !== me.id && <button className="icon-btn" onClick={() => del(u.id)}><Icon name="trash" size={16} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}
