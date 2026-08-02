// The user's own collection: Library tabs, Liked songs, and followed artists.
import { useState, useEffect, useCallback } from 'react';
import { api, usePlayer } from '../store.jsx';
import { Icon, TrackTable, CardRow, TileCard, RadioButton, AlphaCardGrid } from '../ui.jsx';
import { useAsync, Loading, ErrState } from './shared.jsx';

// Name accessors for the A–Z index (module-level so they stay referentially
// stable across renders and don't churn AlphaCardGrid's memo).
const artistName = (a) => a.name;
const albumName = (a) => a.title;

function PlaylistsGrid({ playlists, nav, onCreate }) {
  return (
    <div className="card-grid">
      <button className="tile create-tile" onClick={onCreate}>
        <div className="tile-art"><div className="create-art"><Icon name="plus" size={32} /></div></div>
        <div className="tile-title">Create playlist</div>
      </button>
      {playlists.map(pl => (
        <TileCard key={pl.id} cover={pl.cover} title={pl.name} sub={`${pl.count || 0} tracks`}
          onClick={() => nav({ view: 'playlist', id: pl.id })} />
      ))}
    </div>
  );
}

const LIB_TABS = [
  ['overview', 'Overview'], ['songs', 'Songs'], ['liked', 'Liked songs'],
  ['playlists', 'Playlists'], ['albums', 'Albums'], ['artists', 'Artists'], ['history', 'History'],
];

export function Library({ nav }) {
  const player = usePlayer();
  const [tab, setTab] = useState('overview');
  const [lib, setLib] = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [history, setHistory] = useState([]);
  const [favs, setFavs] = useState([]);
  const [artistsData, setArtistsData] = useState(null);
  const [albumsData, setAlbumsData] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [err, setErr] = useState(null);

  const loadLib = useCallback(() => api.get('/api/library').then(setLib).catch(e => setErr(e.message)), []);
  const loadPlaylists = useCallback(() => api.get('/api/playlists').then(setPlaylists).catch(() => {}), []);
  useEffect(() => {
    if (tab === 'artists' && !artistsData) api.get('/api/library/artists').then(setArtistsData).catch(() => setArtistsData([]));
    if (tab === 'albums' && !albumsData) api.get('/api/library/albums').then(setAlbumsData).catch(() => setAlbumsData([]));
  }, [tab, artistsData, albumsData]);
  // Server-side library search (debounced) — scales past what the client holds.
  useEffect(() => {
    const query = q.trim();
    if (!query) { setResults(null); return; }
    const t = setTimeout(() => {
      api.get(`/api/library?q=${encodeURIComponent(query)}&limit=200`).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    loadLib(); loadPlaylists();
    api.get('/api/history').then(h => setHistory((h || []).map(t => ({ ...t, available: !!t.file_path })))).catch(() => {});
    api.get('/api/favorites').then(f => setFavs((f || []).map(t => ({ ...t, available: !!t.file_path, favorite: true })))).catch(() => {});
    const poll = setInterval(loadLib, 5000); // keep download status fresh
    const h = () => loadPlaylists();
    window.addEventListener('musicarr:playlists-changed', h);
    return () => { clearInterval(poll); window.removeEventListener('musicarr:playlists-changed', h); };
  }, [loadLib, loadPlaylists]);

  if (err) return <ErrState msg={err} />;
  if (!lib) return <Loading />;

  const playable = lib.filter(t => t.available);

  const createPlaylist = async () => {
    const name = prompt('New playlist name');
    if (!name) return;
    try { const pl = await api.post('/api/playlists', { name }); window.dispatchEvent(new Event('musicarr:playlists-changed')); nav?.({ view: 'playlist', id: pl.id }); }
    catch (e) { alert(e.message); }
  };

  return (
    <div className="page">
      <div className="list-head">
        <h1 className="page-h1">Library</h1>
        <div className="list-head-actions">
          <button className="btn-primary" disabled={!playable.length} onClick={() => player.playList(playable, 0, { shuffle: true })}>
            <Icon name="shuffle" size={18} /> Shuffle all
          </button>
        </div>
      </div>
      <div className="tabbar">
        {LIB_TABS.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
        <input className="settings-input lib-search" type="search" placeholder="Search your library…"
          value={q} onChange={e => setQ(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 260 }} />
      </div>

      {q.trim() ? (
        results === null ? <Loading />
        : results.length
          ? <TrackTable tracks={results} nav={nav} />
          : <div className="state faint">Nothing in your library matches “{q.trim()}”.</div>
      ) : (
      <>
      {tab === 'overview' && (
        <>
          {!!history.length && (
            <CardRow title="Recently played">
              {history.slice(0, 12).map(t => (
                <TileCard key={t.deezer_id} cover={t.cover} title={t.title} sub={t.artist}
                  onClick={() => t.album_id && nav({ view: 'album', id: t.album_id })}
                  actions={<RadioButton seed={`track:${t.deezer_id}`} />} />
              ))}
            </CardRow>
          )}
          <section className="page-block">
            <h2 className="row-title">Playlists</h2>
            <PlaylistsGrid playlists={playlists} nav={nav} onCreate={createPlaylist} />
          </section>
          {!history.length && !playlists.length && !lib.length &&
            <div className="state faint">Your library is empty — download some music or create a playlist.</div>}
        </>
      )}

      {tab === 'songs' && (lib.length
        ? <TrackTable tracks={lib} nav={nav} />
        : <div className="state faint">Nothing downloaded yet. Search for music and hit download.</div>)}

      {tab === 'liked' && (favs.length
        ? <TrackTable tracks={favs} nav={nav} />
        : <div className="state faint">Tap the heart on any track to save it here.</div>)}

      {tab === 'playlists' && <PlaylistsGrid playlists={playlists} nav={nav} onCreate={createPlaylist} />}

      {tab === 'albums' && (
        albumsData === null ? <Loading />
        : albumsData.length
          ? <AlphaCardGrid items={albumsData} getName={albumName} renderItem={a => (
              <TileCard key={a.id} cover={a.cover} title={a.title} sub={`${a.artist} · ${a.count} song${a.count > 1 ? 's' : ''}`}
                onClick={() => nav({ view: 'album', id: a.id })} />)} />
          : <div className="state faint">No full albums in your library yet.</div>)}

      {tab === 'artists' && (
        artistsData === null ? <Loading />
        : artistsData.length
          ? <AlphaCardGrid items={artistsData} getName={artistName} renderItem={a => (
              <TileCard key={a.id} cover={a.picture} round title={a.name} sub={`${a.count} song${a.count > 1 ? 's' : ''}`}
                onClick={() => nav({ view: 'artist', id: a.id })} />)} />
          : <div className="state faint">No artists yet.</div>)}

      {tab === 'history' && (history.length
        ? <TrackTable tracks={history} nav={nav} />
        : <div className="state faint">No listening history yet.</div>)}
      </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Favorites */
export function Favorites({ nav }) {
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
        {tracks.length
          ? <TrackTable tracks={tracks} nav={nav} />
          : <div className="state faint">Tap the heart on any track to save it here.</div>}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ Following */
// Artists the user follows. New releases from these artists are auto-downloaded
// by the server-side release watcher.
export function Following({ nav }) {
  const { data, err, loading } = useAsync(() => api.get('/api/following'), []);
  const [artists, setArtists] = useState(null);
  useEffect(() => { if (data) setArtists(data); }, [data]);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const list = artists || [];
  const unfollow = async (id) => {
    setArtists(list.filter(a => a.id !== id));
    try { await api.del(`/api/following/${id}`); } catch (e) { alert(e.message); setArtists(list); }
  };
  return (
    <div className="page">
      <header className="hero">
        <div className="fav-art"><Icon name="user" size={72} fill="var(--accent-ink)" /></div>
        <div className="hero-meta">
          <span className="hero-kind">Library</span>
          <h1 className="hero-title">Following</h1>
          <span className="hero-sub faint">
            {list.length} artist{list.length === 1 ? '' : 's'} · new releases download automatically
          </span>
        </div>
      </header>
      <section className="page-block">
        {list.length
          ? <AlphaCardGrid items={list} getName={artistName} renderItem={a => (
              <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Following"
                onClick={() => nav({ view: 'artist', id: a.id })}
                actions={<button className="btn-ghost sm" onClick={(e) => { e.stopPropagation(); unfollow(a.id); }}>Unfollow</button>} />
            )} />
          : <div className="state faint">Open an artist and tap <strong>Follow</strong> to auto-download their new releases.</div>}
      </section>
    </div>
  );
}
