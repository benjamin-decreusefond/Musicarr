import { useState, useEffect, useCallback } from 'react';
import { api, usePlayer } from './store.jsx';
import { events } from './events.js';
import { Icon, Cover, Avatar, TrackTable, CardRow, TileCard, DownloadButton, RadioButton, confirmRadioDownloads, useUserMenu } from './ui.jsx';
import { useT, useLang, LANGS } from './i18n.jsx';

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
  const t = useT();
  const { data, err, loading } = useAsync(() => api.get('/api/home'), []);
  const [recs, setRecs] = useState(null);
  const [history, setHistory] = useState(null);
  const [mixes, setMixes] = useState(null);
  useEffect(() => {
    api.get('/api/recommendations').then(setRecs).catch(() => {});
    api.get('/api/history').then(h => setHistory(h.map(t => ({ ...t, available: !!t.file_path }))) ).catch(() => {});
    api.get('/api/mixes').then(m => setMixes([...(m.smart || []), ...(m.daily || [])])).catch(() => {});
  }, []);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const hour = new Date().getHours();
  const greet = hour < 5 ? t('greet.night') : hour < 12 ? t('greet.morning') : hour < 18 ? t('greet.afternoon') : t('greet.evening');
  return (
    <div className="page">
      <h1 className="page-h1">{greet}</h1>
      {!!history?.length && (
        <CardRow title="Recently played">
          {history.slice(0, 12).map(t => (
            <TileCard key={t.deezer_id} cover={t.cover} title={t.title} sub={t.artist}
              onClick={() => t.album_id && nav({ view: 'album', id: t.album_id })}
              actions={<RadioButton seed={`track:${t.deezer_id}`} />} />
          ))}
        </CardRow>
      )}
      {!!mixes?.length && (
        <CardRow title="Made for you">
          {mixes.map(m => <MixCard key={m.key} mix={m} nav={nav} />)}
        </CardRow>
      )}
      {!!recs?.tracks?.length && (
        <section className="page-block">
          <h2 className="row-title">{recs.personalized ? 'You might like' : 'Popular right now'}</h2>
          {recs.personalized && !!recs.basedOn?.length && (
            <p className="settings-hint" style={{ marginTop: -4 }}>Based on {recs.basedOn.map(a => a.name).slice(0, 3).join(', ')}</p>
          )}
          <TrackTable tracks={recs.tracks.slice(0, 15)} nav={nav} showAdded={false} />
        </section>
      )}
      {!!recs?.artists?.length && (
        <CardRow title="Artists for you">
          {recs.artists.map(a => (
            <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Artist"
              onClick={() => nav({ view: 'artist', id: a.id })} />
          ))}
        </CardRow>
      )}
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
              onClick={() => nav({ view: 'dplaylist', id: p.id })}
              actions={<ImportPlaylistButton playlist={p} nav={nav} />} />
          ))}
        </CardRow>
      )}
      <section className="page-block">
        <h2 className="row-title">Charts</h2>
        <TrackTable tracks={data.tracks} nav={nav} showAdded={false} />
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
  const [people, setPeople] = useState([]);
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
    if (!q.trim()) { setRes(null); setPeople([]); return; }
    setLoading(true);
    const id = setTimeout(async () => {
      // Query Deezer (music) and the server's own users in parallel.
      api.get(`/api/social/users?q=${encodeURIComponent(q)}`).then(setPeople).catch(() => setPeople([]));
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
      {!!people.length && (
        <section className="page-block">
          <h2 className="row-title">People <span className="src-badge">on this server</span></h2>
          <div className="user-list">
            {people.map(u => <UserRow key={u.id} u={u} nav={nav} onChange={() => {
              api.get(`/api/social/users?q=${encodeURIComponent(q)}`).then(setPeople).catch(() => {});
            }} />)}
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
              <TrackTable tracks={res.tracks} nav={nav} showAdded={false} />
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
// Follow an artist so new releases are auto-downloaded (server-wide watcher).
function ArtistFollowButton({ artistId, initial }) {
  const [following, setFollowing] = useState(!!initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setFollowing(!!initial), [initial, artistId]);
  const toggle = async () => {
    const nv = !following; setFollowing(nv); setBusy(true);
    try {
      if (nv) await api.put(`/api/following/${artistId}`);
      else await api.del(`/api/following/${artistId}`);
    } catch (e) { setFollowing(!nv); alert(e.message); }
    finally { setBusy(false); }
  };
  return (
    <button className={`btn-ghost ${following ? 'on' : ''}`} onClick={toggle} disabled={busy}
      title="Auto-download this artist's new releases">
      <Icon name={following ? 'check' : 'plus'} size={18} /> {following ? 'Following' : 'Follow'}
    </button>
  );
}

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
            <button className="btn-ghost" onClick={async () => {
              if (!confirmRadioDownloads()) return;
              try { await player.startRadio(`artist:${artist.id}`); } catch (e) { alert(e.message); }
            }}>
              <Icon name="radio" size={18} /> Start radio
            </button>
            <ArtistFollowButton artistId={artist.id} initial={data.following} />
          </div>
        </div>
      </header>
      <section className="page-block">
        <h2 className="row-title">Popular</h2>
        <TrackTable tracks={top} nav={nav} showAdded={false} />
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
      <section className="page-block">
        <TrackTable tracks={tracks} nav={nav} showAlbum={false} showAdded={false} />
      </section>
    </div>
  );
}

/* -------------------------------------------------------------- Library */
/* -------------------------------------------------------------- Library */
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
  const [err, setErr] = useState(null);

  const loadLib = useCallback(() => api.get('/api/library').then(setLib).catch(e => setErr(e.message)), []);
  const loadPlaylists = useCallback(() => api.get('/api/playlists').then(setPlaylists).catch(() => {}), []);
  useEffect(() => {
    if (tab === 'artists' && !artistsData) api.get('/api/library/artists').then(setArtistsData).catch(() => setArtistsData([]));
  }, [tab, artistsData]);
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
  // Group the downloaded tracks into albums (the Artists tab uses the dedicated
  // /api/library/artists endpoint).
  const albumMap = new Map();
  for (const t of playable) {
    if (t.album_id) {
      if (!albumMap.has(t.album_id)) albumMap.set(t.album_id, { id: t.album_id, title: t.album, artist: t.artist, cover: t.cover, count: 0 });
      albumMap.get(t.album_id).count++;
    }
  }
  const albums = [...albumMap.values()];

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
      </div>

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

      {tab === 'albums' && (albums.length
        ? <div className="card-grid">{albums.map(a => (
            <TileCard key={a.id} cover={a.cover} title={a.title} sub={`${a.artist} · ${a.count} song${a.count > 1 ? 's' : ''}`}
              onClick={() => nav({ view: 'album', id: a.id })} />))}</div>
        : <div className="state faint">No full albums in your library yet.</div>)}

      {tab === 'artists' && (
        artistsData === null ? <Loading />
        : artistsData.length
          ? <div className="card-grid">{artistsData.map(a => (
              <TileCard key={a.id} cover={a.picture} round title={a.name} sub={`${a.count} song${a.count > 1 ? 's' : ''}`}
                onClick={() => nav({ view: 'artist', id: a.id })} />))}</div>
          : <div className="state faint">No artists yet.</div>)}

      {tab === 'history' && (history.length
        ? <TrackTable tracks={history} nav={nav} />
        : <div className="state faint">No listening history yet.</div>)}
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
          ? <div className="card-grid">{list.map(a => (
              <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Following"
                onClick={() => nav({ view: 'artist', id: a.id })}
                actions={<button className="btn-ghost sm" onClick={(e) => { e.stopPropagation(); unfollow(a.id); }}>Unfollow</button>} />
            ))}</div>
          : <div className="state faint">Open an artist and tap <strong>Follow</strong> to auto-download their new releases.</div>}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- Playlist */
// Owner-only panel to share a playlist with other users (view or collaborate).
function SharePanel({ playlistId, initialShares }) {
  const [shares, setShares] = useState(initialShares || []);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try { const r = await api.get(`/api/social/users?q=${encodeURIComponent(q)}`); if (live) setResults(r || []); }
      catch { if (live) setResults([]); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const sharedIds = new Set(shares.map(s => s.user_id));
  const save = async (userId, username, canEdit) => {
    try {
      await api.post(`/api/playlists/${playlistId}/shares`, { user_id: userId, can_edit: canEdit });
      setShares(prev => [...prev.filter(s => s.user_id !== userId), { user_id: userId, username, can_edit: canEdit ? 1 : 0 }]);
    } catch (e) { alert(e.message); }
  };
  const removeShare = async (userId) => {
    try { await api.del(`/api/playlists/${playlistId}/shares/${userId}`); setShares(prev => prev.filter(s => s.user_id !== userId)); }
    catch (e) { alert(e.message); }
  };
  const candidates = results.filter(u => !sharedIds.has(u.id));
  return (
    <section className="page-block share-panel">
      <h2 className="row-title">Share with people</h2>
      {!!shares.length && (
        <div className="share-list">
          {shares.map(s => (
            <div className="share-row" key={s.user_id}>
              <span className="share-name">{s.username}</span>
              <label className="share-edit">
                <input type="checkbox" checked={!!s.can_edit}
                  onChange={e => save(s.user_id, s.username, e.target.checked)} /> Can edit
              </label>
              <button className="btn-ghost sm" onClick={() => removeShare(s.user_id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <input className="share-search" placeholder="Search users to share with…" value={q}
        onChange={e => setQ(e.target.value)} />
      <div className="share-results">
        {candidates.map(u => (
          <div className="share-row" key={u.id}>
            <span className="share-name">{u.username}</span>
            <button className="btn-ghost sm" onClick={() => save(u.id, u.username, false)}>Share</button>
            <button className="btn-ghost sm" onClick={() => save(u.id, u.username, true)}>Share &amp; allow edits</button>
          </div>
        ))}
        {q && !candidates.length && <div className="state faint">No matching users.</div>}
      </div>
    </section>
  );
}

export function Playlist({ id, nav }) {
  const { data, err, loading, setData } = useAsync(() => api.get(`/api/playlists/${id}`), [id]);
  const player = usePlayer();
  const [showShare, setShowShare] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  useEffect(() => { setShowShare(false); setEditingName(false); }, [id]);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const canEdit = !!data.can_edit;
  const tracks = (data.tracks || []).map(t => ({ ...t, available: !!t.file_path }));
  const playable = tracks.filter(t => t.available);
  const remove = async (trackId) => {
    await api.del(`/api/playlists/${id}/tracks/${trackId}`);
    setData({ ...data, tracks: data.tracks.filter(t => t.deezer_id !== trackId) });
    window.dispatchEvent(new Event('musicarr:playlists-changed'));
  };
  const rename = async () => {
    const name = nameDraft.trim();
    setEditingName(false);
    if (!name || name === data.name) return;
    try {
      await api.put(`/api/playlists/${id}`, { name });
      setData({ ...data, name });
      window.dispatchEvent(new Event('musicarr:playlists-changed'));
    } catch (e) { alert(e.message); }
  };
  // Optimistic drag-reorder; on failure, reload the server's order.
  const reorder = async (from, to) => {
    const next = [...data.tracks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setData({ ...data, tracks: next });
    try {
      await api.put(`/api/playlists/${id}/reorder`, { track_ids: next.map(t => t.deezer_id) });
    } catch (e) {
      alert(e.message);
      try { setData(await api.get(`/api/playlists/${id}`)); } catch { /* keep optimistic order */ }
    }
  };
  const meta = [
    !data.is_owner && data.owner_name ? `by ${data.owner_name}` : null,
    `${tracks.length} tracks`,
    data.role === 'editor' ? 'you can edit' : (!data.is_owner && data.role === 'viewer' ? 'view only' : null),
  ].filter(Boolean).join(' · ');
  return (
    <div className="page">
      <header className="hero">
        <Cover src={tracks[0]?.cover} size={200} alt={data.name} />
        <div className="hero-meta">
          <span className="hero-kind">{data.shared ? 'Shared playlist' : 'Playlist'}</span>
          {editingName ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="settings-input" autoFocus value={nameDraft} maxLength={120}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditingName(false); }} />
              <button className="btn-primary" onClick={rename}>Save</button>
              <button className="btn-ghost" onClick={() => setEditingName(false)}>Cancel</button>
            </div>
          ) : (
            <h1 className="hero-title">
              {data.name}
              {data.is_owner && (
                <button className="icon-btn" title="Rename playlist" style={{ marginLeft: 8, verticalAlign: 'middle' }}
                  onClick={() => { setNameDraft(data.name); setEditingName(true); }}>
                  <Icon name="edit" size={16} />
                </button>
              )}
            </h1>
          )}
          <span className="hero-sub faint">{meta}</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!playable.length}
              onClick={() => player.playList(playable, 0)}>
              <Icon name="play" size={18} fill="currentColor" /> Play
            </button>
            <button className="btn-ghost" disabled={!playable.length}
              onClick={() => player.playList(playable, 0, { shuffle: true })}>
              <Icon name="shuffle" size={18} /> Shuffle
            </button>
            {data.is_owner && (
              <button className={`btn-ghost ${showShare ? 'on' : ''}`} onClick={() => setShowShare(v => !v)}>
                <Icon name="user" size={18} /> Share
              </button>
            )}
          </div>
        </div>
      </header>
      {showShare && data.is_owner && <SharePanel playlistId={id} initialShares={data.shares || []} />}
      <section className="page-block">
        {tracks.length
          ? <TrackTable tracks={tracks} nav={nav} onRemove={canEdit ? remove : undefined}
              onReorder={canEdit ? reorder : undefined} />
          : <div className="state faint">This playlist is empty.</div>}
      </section>
    </div>
  );
}

/* --------------------------------------------------- Deezer playlist preview */
export function DeezerPlaylist({ id, nav }) {
  const player = usePlayer();
  const { data, err, loading } = useAsync(() => api.get(`/api/deezer-playlist/${id}`), [id]);
  const [imp, setImp] = useState('idle');
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const tracks = data.tracks || [];
  const playable = tracks.filter(t => t.available);
  const doImport = async () => {
    setImp('busy');
    try {
      const r = await api.post('/api/playlists/import-deezer', { deezer_playlist_id: id });
      window.dispatchEvent(new Event('musicarr:playlists-changed'));
      nav({ view: 'playlist', id: r.id });
    } catch (e) { alert(e.message); setImp('idle'); }
  };
  return (
    <div className="page">
      <header className="hero">
        <Cover src={data.cover} size={200} alt={data.title} />
        <div className="hero-meta">
          <span className="hero-kind">Deezer playlist</span>
          <h1 className="hero-title">{data.title}</h1>
          <span className="hero-sub faint">{data.nb_tracks} tracks · {data.by}</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!playable.length} onClick={() => player.playList(playable, 0, { shuffle: true })}>
              <Icon name="shuffle" size={18} /> Shuffle play
            </button>
            <button className="btn-ghost" onClick={doImport} disabled={imp !== 'idle'}>
              <Icon name={imp === 'busy' ? 'spinner' : 'plus'} size={18} /> {imp === 'busy' ? 'Adding…' : 'Add & download missing'}
            </button>
          </div>
        </div>
      </header>
      <p className="settings-hint" style={{ maxWidth: 720 }}>
        Adding this playlist saves it to your collection and downloads the tracks you don't have yet
        from Soulseek, one song at a time.
      </p>
      <section className="page-block">
        <TrackTable tracks={tracks} nav={nav} showAdded={false} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- Explore */
const MOOD_GRADIENTS = {
  happy: 'linear-gradient(135deg,#ffb347,#ffcc33)',
  chill: 'linear-gradient(135deg,#2193b0,#6dd5ed)',
  sad: 'linear-gradient(135deg,#4b6cb7,#182848)',
  energetic: 'linear-gradient(135deg,#f7411f,#fc5c7d)',
  romantic: 'linear-gradient(135deg,#e55d87,#5fc3e4)',
  focus: 'linear-gradient(135deg,#0f2027,#2c5364)',
  party: 'linear-gradient(135deg,#8e2de2,#e94057)',
  sleep: 'linear-gradient(135deg,#141e30,#243b55)',
  workout: 'linear-gradient(135deg,#f12711,#f5af19)',
  study: 'linear-gradient(135deg,#355c7d,#6c5b7b)',
  feelgood: 'linear-gradient(135deg,#11998e,#38ef7d)',
  throwback: 'linear-gradient(135deg,#cc2b5e,#753a88)',
  summer: 'linear-gradient(135deg,#ff8008,#ffc837)',
  rainy: 'linear-gradient(135deg,#3a6073,#16222a)',
  dance: 'linear-gradient(135deg,#fc466b,#3f5efb)',
  rnb: 'linear-gradient(135deg,#5f2c82,#49a09d)',
  heartbreak: 'linear-gradient(135deg,#93291e,#ed213a)',
  roadtrip: 'linear-gradient(135deg,#2980b9,#2c3e50)',
  jazz: 'linear-gradient(135deg,#42275a,#734b6d)',
  motivation: 'linear-gradient(135deg,#f7971e,#ffd200)',
};
// Deterministic gradient for genres that have no artwork, so no card is blank.
function hueGradient(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 38%), hsl(${(h + 45) % 360} 58% 24%))`;
}

export function Explore({ nav }) {
  const { data, err, loading } = useAsync(() => api.get('/api/explore'), []);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  return (
    <div className="page explore">
      <h1 className="page-h1">Explore</h1>

      {!!data.releases?.length && (
        <CardRow title="New releases">
          {data.releases.map(a => (
            <TileCard key={a.id} cover={a.cover} title={a.title} sub={a.artist}
              badge={a.available ? 'In library' : null}
              onClick={() => nav({ view: 'album', id: a.id })}
              actions={<DownloadButton kind="album" id={a.id} label={a.title} />} />
          ))}
        </CardRow>
      )}

      {!!data.topAlbums?.length && (
        <CardRow title="Top albums">
          {data.topAlbums.map(a => (
            <TileCard key={a.id} cover={a.cover} title={a.title} sub={a.artist}
              badge={a.available ? 'In library' : null}
              onClick={() => nav({ view: 'album', id: a.id })}
              actions={<DownloadButton kind="album" id={a.id} label={a.title} />} />
          ))}
        </CardRow>
      )}

      {!!data.topPlaylists?.length && (
        <CardRow title="Popular playlists">
          {data.topPlaylists.map(p => (
            <TileCard key={p.id} cover={p.cover} title={p.title} sub={`${p.nb_tracks} tracks · ${p.by}`}
              onClick={() => nav({ view: 'dplaylist', id: p.id })}
              actions={<ImportPlaylistButton playlist={p} nav={nav} />} />
          ))}
        </CardRow>
      )}

      {!!data.topArtists?.length && (
        <CardRow title="Trending artists">
          {data.topArtists.map(a => (
            <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Artist"
              onClick={() => nav({ view: 'artist', id: a.id })} />
          ))}
        </CardRow>
      )}

      {!!data.moods?.length && (
        <section className="explore-section">
          <h2 className="row-title">Moods</h2>
          <div className="explore-grid">
            {data.moods.map(m => (
              // With a cover photo use the stronger default scrim for legibility;
              // without one, fall back to a gradient (lighter "mood" scrim).
              <button key={m.slug} className={`explore-card ${m.image ? '' : 'mood'}`}
                onClick={() => nav({ view: 'mood', id: m.slug })}
                style={m.image
                  ? { backgroundImage: `url(${m.image})` }
                  : { background: MOOD_GRADIENTS[m.slug] || hueGradient(m.slug) }}>
                <span className="explore-label">{m.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!!data.genres?.length && (
        <section className="explore-section">
          <h2 className="row-title">All categories</h2>
          <div className="cat-grid">
            {data.genres.map(g => (
              <button key={g.id} className="cat-card" onClick={() => nav({ view: 'genre', id: g.id })}>
                <span className="cat-name">{g.name}</span>
                <span className="cat-thumb" style={g.picture
                  ? { backgroundImage: `url(${g.picture})` }
                  : { background: hueGradient(g.name) }} />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function Mood({ slug, nav }) {
  const player = usePlayer();
  const { data, err, loading } = useAsync(() => api.get(`/api/mood/${encodeURIComponent(slug)}`), [slug]);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const tracks = data.tracks || [];
  const playable = tracks.filter(t => t.available);
  return (
    <div className="page">
      <span className="hero-kind">Mood</span>
      <div className="list-head">
        <h1 className="page-h1">{data.name}</h1>
        {!!playable.length && (
          <div className="list-head-actions">
            <button className="btn-primary" onClick={() => player.playList(playable, 0, { shuffle: true })}>
              <Icon name="shuffle" size={18} /> Shuffle play
            </button>
          </div>
        )}
      </div>
      {!!data.playlists?.length && (
        <CardRow title="Playlists">
          {data.playlists.map(p => (
            <TileCard key={p.id} cover={p.cover} title={p.title} sub={`${p.nb_tracks} tracks · ${p.by}`}
              onClick={() => nav({ view: 'dplaylist', id: p.id })} />
          ))}
        </CardRow>
      )}
      {!!tracks.length && (
        <section className="page-block">
          <h2 className="row-title">Songs</h2>
          <TrackTable tracks={tracks} nav={nav} showAdded={false} />
        </section>
      )}
      {!tracks.length && !data.playlists?.length && <div className="state faint">Nothing found for this mood.</div>}
    </div>
  );
}

export function Genre({ id, nav }) {
  const { data, err, loading } = useAsync(() => api.get(`/api/genre/${id}`), [id]);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  return (
    <div className="page">
      <span className="hero-kind">Genre</span>
      <h1 className="page-h1">{data.name}</h1>
      {!!data.artists?.length && (
        <CardRow title="Artists">
          {data.artists.map(a => (
            <TileCard key={a.id} cover={a.picture} round title={a.name} sub="Artist"
              onClick={() => nav({ view: 'artist', id: a.id })} />
          ))}
        </CardRow>
      )}
      {!!data.albums?.length && (
        <CardRow title="Albums">
          {data.albums.map(a => (
            <TileCard key={a.id} cover={a.cover} title={a.title} sub={a.artist} badge={a.available ? 'In library' : null}
              onClick={() => nav({ view: 'album', id: a.id })}
              actions={<DownloadButton kind="album" id={a.id} label={a.title} />} />
          ))}
        </CardRow>
      )}
      {!!data.playlists?.length && (
        <CardRow title="Playlists">
          {data.playlists.map(p => (
            <TileCard key={p.id} cover={p.cover} title={p.title} sub={`${p.nb_tracks} tracks · ${p.by}`}
              onClick={() => nav({ view: 'dplaylist', id: p.id })} />
          ))}
        </CardRow>
      )}
      {!!data.tracks?.length && (
        <section className="page-block">
          <h2 className="row-title">Top tracks</h2>
          <TrackTable tracks={data.tracks} nav={nav} showAdded={false} />
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Downloads */
export function Downloads({ nav }) {
  const player = usePlayer();
  const [items, setItems] = useState([]);
  const load = useCallback(async () => { try { setItems(await api.get('/api/downloads')); } catch {} }, []);
  // Live updates over SSE; the poll only fires while SSE is down (plus a slow
  // safety refresh to heal any missed event).
  useEffect(() => {
    load();
    const off = events.on('download', (d) => setItems(prev => {
      if (d.removed) return prev.filter(x => x.id !== d.id);
      const i = prev.findIndex(x => x.id === d.id);
      if (i < 0) return [d, ...prev];
      const next = [...prev];
      next[i] = { ...next[i], ...d };
      return next;
    }));
    let n = 0;
    const t = setInterval(() => { n++; if (events.connected && n % 8 !== 0) return; load(); }, 4000);
    return () => { off(); clearInterval(t); };
  }, [load]);
  const remove = async (id) => { await api.del(`/api/downloads/${id}`); load(); };
  const retry = async (id) => { try { await api.post(`/api/downloads/${id}/retry`, {}); } catch (e) { alert(e.message); } load(); };
  const statusLabel = { searching: 'Searching', downloading: 'Downloading', importing: 'Importing', done: 'Done', not_found: 'Not found', error: 'Error' };

  // Click a finished download: play the track and jump to the library; for an
  // album, open the album page. Label is "Artist – Title".
  const open = (d) => {
    if (d.status !== 'done') return;
    if (d.kind === 'album') { nav?.({ view: 'album', id: d.deezer_id }); return; }
    const [artist, title] = String(d.label || '').split(' – ');
    player.playTrack({ deezer_id: d.deezer_id, title: title || d.label, artist: artist || '', cover: d.cover, available: true });
    nav?.({ view: 'library' });
  };

  return (
    <div className="page">
      <h1 className="page-h1">Downloads</h1>
      <div className="dl-list">
        {items.map(d => (
          <div key={d.id} className={`dl-item ${d.status === 'done' ? 'playable' : ''}`}
            onClick={d.status === 'done' ? () => open(d) : undefined}
            title={d.status === 'done' ? (d.kind === 'album' ? 'Open album' : 'Play in library') : undefined}>
            <Cover src={d.cover} size={52} />
            <div className="dl-main">
              <div className="dl-label">{d.label}{d.username ? <span className="dl-by"> · {d.username}</span> : ''}</div>
              <div className="dl-detail">{d.detail || statusLabel[d.status]}</div>
              {d.status === 'downloading' && (
                <div className="dl-bar"><div className="dl-bar-fill" style={{ width: `${Math.round(d.progress * 100)}%` }} /></div>
              )}
            </div>
            <span className={`dl-status s-${d.status}`}>{statusLabel[d.status] || d.status}</span>
            {(d.status === 'error' || d.status === 'not_found') && (
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); retry(d.id); }} title="Retry this download"><Icon name="refresh" size={16} /></button>
            )}
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); remove(d.id); }} title="Remove (cancels the transfer; does not delete an already-imported file)"><Icon name="trash" size={16} /></button>
          </div>
        ))}
        {!items.length && <div className="state faint">No downloads yet.</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- Listening stats */
const STAT_RANGES = [['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']];

function StatCard({ value, label }) {
  return <div className="stat-card"><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div>;
}

export function Stats({ nav, userId = null }) {
  const [range, setRange] = useState('all');
  const qs = `?range=${range}${userId ? `&user=${userId}` : ''}`;
  const { data, err, loading } = useAsync(() => api.get(`/api/stats${qs}`), [range, userId]);
  const player = usePlayer();
  // For another user the server returns their username; otherwise it's "Your".
  const title = (userId && data?.username) ? `${data.username}'s stats` : 'Your stats';

  const fmtMinutes = (sec) => {
    const m = Math.round((sec || 0) / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };

  return (
    <div className="page">
      <div className="stats-head">
        <h1 className="page-h1">{title}</h1>
        <div className="seg">
          {STAT_RANGES.map(([key, label]) => (
            <button key={key} className={`seg-btn ${range === key ? 'on' : ''}`} onClick={() => setRange(key)}>{label}</button>
          ))}
        </div>
      </div>
      {loading && <Loading />}
      {err && <ErrState msg={err} />}
      {data && (data.totals.plays === 0
        ? <div className="state faint">No listening recorded for this period yet — play something and check back.</div>
        : <>
          <div className="stat-grid">
            <StatCard value={data.totals.plays} label="Tracks played" />
            <StatCard value={fmtMinutes(data.totals.seconds)} label="Time listened" />
            <StatCard value={data.totals.artists} label="Different artists" />
            <StatCard value={data.totals.tracks} label="Unique tracks" />
          </div>

          {!!data.daily?.length && (
            <section className="page-block">
              <h2 className="row-title">Last 14 days</h2>
              <Sparkline daily={data.daily} />
            </section>
          )}

          {!!data.topArtists?.length && (
            <CardRow title="Top artists">
              {data.topArtists.map((a, i) => (
                <TileCard key={a.artist_id} cover={a.cover} round title={`${i + 1}. ${a.artist}`}
                  sub={`${a.plays} play${a.plays === 1 ? '' : 's'}`}
                  onClick={() => a.artist_id && nav({ view: 'artist', id: a.artist_id })} />
              ))}
            </CardRow>
          )}

          {!!data.topTracks?.length && (
            <section className="page-block">
              <div className="row-title-flex">
                <h2 className="row-title">Top tracks</h2>
                <button className="btn-ghost sm" onClick={() => player.playList(data.topTracks, 0)}>
                  <Icon name="play" size={14} fill="currentColor" /> Play
                </button>
              </div>
              <TrackTable tracks={data.topTracks} nav={nav} showAdded={false} />
            </section>
          )}

          {!!data.topAlbums?.length && (
            <CardRow title="Top albums">
              {data.topAlbums.map(a => (
                <TileCard key={a.album_id} cover={a.cover} title={a.album} sub={a.artist}
                  onClick={() => a.album_id && nav({ view: 'album', id: a.album_id })} />
              ))}
            </CardRow>
          )}
        </>)}
    </div>
  );
}

// Tiny dependency-free bar chart of per-day play counts.
function Sparkline({ daily }) {
  const max = Math.max(1, ...daily.map(d => d.plays));
  return (
    <div className="sparkline">
      {daily.map(d => (
        <div key={d.day} className="spark-col" title={`${d.day}: ${d.plays} play${d.plays === 1 ? '' : 's'}`}>
          <div className="spark-bar" style={{ height: `${Math.round((d.plays / max) * 100)}%` }} />
          <span className="spark-label">{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------- Made-for-you mixes */
// A mix tile that plays its tracks on click (Liked Songs shuffles). Discovery
// "daily" mixes are mostly not on disk yet, so playing one queues whatever is
// available and offers to download the rest.
function MixCard({ mix, nav }) {
  const player = usePlayer();
  const availableCount = mix.tracks.filter(t => t.available || t.file_path).length;
  const play = (e) => {
    e.stopPropagation();
    const shuffle = mix.key === 'liked';
    if (availableCount > 0) player.playList(mix.tracks, 0, { shuffle });
  };
  return (
    <div className="tile" onClick={() => nav({ view: 'mix', id: mix.key })}>
      <div className="tile-art">
        <Cover src={mix.cover} size={156} alt={mix.title} />
        <div className="tile-actions" onClick={e => e.stopPropagation()}>
          <button className="icon-btn" onClick={play} title={availableCount ? 'Play' : 'Nothing downloaded yet — open to download'}>
            <Icon name="play" size={18} fill="currentColor" />
          </button>
        </div>
      </div>
      <div className="tile-title">{mix.title}</div>
      <div className="tile-sub">{mix.subtitle}</div>
    </div>
  );
}

export function MadeForYou({ nav }) {
  const { data, err, loading } = useAsync(() => api.get('/api/mixes'), []);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const empty = !data.smart?.length && !data.daily?.length;
  return (
    <div className="page">
      <h1 className="page-h1">Made for you</h1>
      {empty && <div className="state faint">Listen to and like some music — your personal mixes will appear here.</div>}
      {!!data.smart?.length && (
        <CardRow title="Your mixes">
          {data.smart.map(m => <MixCard key={m.key} mix={m} nav={nav} />)}
        </CardRow>
      )}
      {!!data.daily?.length && (
        <CardRow title="Daily mixes">
          {data.daily.map(m => <MixCard key={m.key} mix={m} nav={nav} />)}
        </CardRow>
      )}
    </div>
  );
}

// Full track listing for a single mix (reached by clicking a mix tile).
export function Mix({ id, nav }) {
  const { data, err, loading } = useAsync(() => api.get('/api/mixes'), []);
  const player = usePlayer();
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const mix = [...(data.smart || []), ...(data.daily || [])].find(m => m.key === id);
  if (!mix) return <ErrState msg="This mix is no longer available." />;
  const shuffle = mix.key === 'liked';
  const availableCount = mix.tracks.filter(t => t.available || t.file_path).length;
  return (
    <div className="page">
      <header className="hero">
        <Cover src={mix.cover} size={200} alt={mix.title} />
        <div className="hero-meta">
          <span className="hero-kind">Mix</span>
          <h1 className="hero-title">{mix.title}</h1>
          <span className="hero-sub faint">{mix.subtitle}</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!availableCount}
              onClick={() => player.playList(mix.tracks, 0, { shuffle })}>
              <Icon name="play" size={18} fill="currentColor" /> {shuffle ? 'Shuffle' : 'Play'}
            </button>
            {availableCount < mix.tracks.length && (
              <span className="hero-sub faint">{availableCount} of {mix.tracks.length} on disk — download the rest below.</span>
            )}
          </div>
        </div>
      </header>
      <section className="page-block">
        <TrackTable tracks={mix.tracks} nav={nav} showAdded={false} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------ API access tokens */
function ApiTokens() {
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [created, setCreated] = useState(null); // freshly minted token, shown once
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => api.get('/api/auth/tokens').then(setTokens).catch(() => setTokens([])), []);
  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null); setCreated(null); setCopied(false);
    try {
      const t = await api.post('/api/auth/tokens', { name: name.trim() });
      setCreated(t);
      setName('');
      load();
    } catch (e) { setMsg({ err: true, text: e.message }); }
    setBusy(false);
  };

  const revoke = async (id) => {
    if (!window.confirm('Revoke this token? Any service using it will immediately lose access.')) return;
    try { await api.del(`/api/auth/tokens/${id}`); load(); }
    catch (e) { setMsg({ err: true, text: e.message }); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(created.token); setCopied(true); }
    catch { /* clipboard may be unavailable on http; the field is selectable */ }
  };

  return (
    <section className="page-block settings-section">
      <h2 className="row-title">API access tokens</h2>
      <p className="settings-hint">
        Personal access tokens let external tools (scripts, automations, Claude Code) call the
        Musicarr API on your behalf. Send the token as an <code>Authorization: Bearer &lt;token&gt;</code>
        header (or <code>X-Api-Key: &lt;token&gt;</code>). A token has the same permissions as your
        account and is shown only once — store it somewhere safe.
      </p>

      <form className="profile-form token-create" onSubmit={create}>
        <input className="settings-input" placeholder="Token name (e.g. Claude Code)" maxLength={80}
          value={name} onChange={e => setName(e.target.value)} />
        <button className="btn-primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create token'}</button>
      </form>
      {msg && <p className={`settings-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</p>}

      {created && (
        <div className="token-reveal">
          <div className="settings-fieldhint">Copy your new token now — you won't be able to see it again.</div>
          <div className="token-reveal-row">
            <input className="settings-input mono" readOnly value={created.token} onFocus={e => e.target.select()} />
            <button type="button" className="btn-ghost" onClick={copy}>
              <Icon name="copy" size={16} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="token-list">
        {tokens == null ? <div className="state faint">Loading…</div>
          : tokens.length === 0 ? <div className="state faint">No tokens yet.</div>
          : tokens.map(t => (
            <div key={t.id} className="token-row">
              <div className="token-meta">
                <Icon name="key" size={16} />
                <span className="token-name">{t.name}</span>
                <span className="token-prefix mono">{t.token_prefix}…</span>
              </div>
              <div className="token-sub">
                <span className="settings-fieldhint">
                  Created {fmtDate(t.created_at)} · {t.last_used_at ? `last used ${fmtDate(t.last_used_at)}` : 'never used'}
                </span>
                <button className="icon-btn" title="Revoke token" onClick={() => revoke(t.id)}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

function fmtDate(s) {
  if (!s) return '';
  // SQLite datetimes are UTC ("YYYY-MM-DD HH:MM:SS"); render in local time.
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

/* -------------------------------------------------------------- Profile */
// Downscale a chosen image file to a small centered-square JPEG data URL, so
// uploads stay tiny and the server only ever stores a uniform format.
function fileToSquareJpeg(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

// Upload / remove your own profile picture.
function AvatarSection({ me }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await fileToSquareJpeg(file);
      await api.post('/api/avatar', { image: dataUrl });
      window.dispatchEvent(new Event('musicarr:me-updated'));
    } catch (err) { alert(err.message || 'Upload failed'); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    try { await api.del('/api/avatar'); window.dispatchEvent(new Event('musicarr:me-updated')); }
    catch (err) { alert(err.message); }
    setBusy(false);
  };
  return (
    <section className="page-block settings-section">
      <h2 className="row-title">{t('settings.photo')}</h2>
      <div className="avatar-edit">
        <Avatar src={me.avatar} size={88} />
        <div className="avatar-edit-actions">
          <label className="btn-ghost">
            <Icon name="camera" size={16} /> {busy ? '…' : t('settings.changePhoto')}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} disabled={busy} />
          </label>
          {me.avatar && <button className="btn-ghost" onClick={remove} disabled={busy}>{t('settings.removePhoto')}</button>}
        </div>
      </div>
    </section>
  );
}

// Interface language selector (persisted to localStorage; applies instantly).
function LanguagePicker() {
  const { lang, setLang, t } = useLang();
  return (
    <section className="page-block settings-section">
      <h2 className="row-title">{t('settings.language')}</h2>
      <p className="settings-hint">{t('settings.languageHint')}</p>
      <div className="lang-grid">
        {LANGS.map(l => (
          <button key={l.code} className={`lang-btn ${lang === l.code ? 'on' : ''}`} onClick={() => setLang(l.code)}>
            {l.label}{lang === l.code ? <Icon name="check" size={16} /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

export function Profile({ me, nav }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [friends, setFriends] = useState(null);
  const loadFriends = useCallback(() => api.get('/api/social/following').then(setFriends).catch(() => setFriends([])), []);
  useEffect(() => { loadFriends(); const t = setInterval(loadFriends, 20000); return () => clearInterval(t); }, [loadFriends]);
  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (next.length < 8) return setMsg({ err: true, text: 'New password must be at least 8 characters' });
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
      <AvatarSection me={me} />
      <LanguagePicker />
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
      <ApiTokens />
      <section className="page-block settings-section">
        <h2 className="row-title">Friends</h2>
        <p className="settings-hint">People you follow on this server. Find more from the Search tab.</p>
        {friends && friends.length
          ? <div className="user-list">{friends.map(u => <UserRow key={u.id} u={u} nav={nav} onChange={loadFriends} />)}</div>
          : <div className="state faint">You're not following anyone yet.</div>}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- Settings */
const SETTING_FIELDS = ['root_folder', 'slskd_url', 'slskd_api_key', 'slskd_download_dir'];

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
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState(null);
  const [scan, setScan] = useState(null);
  useEffect(() => {
    api.get('/api/settings').then(setS).catch(e => setMsg({ err: true, text: e.message }));
    api.get('/api/library/scan').then(setScan).catch(() => {});
  }, []);
  // Live scan progress: SSE when available, polling while a scan runs.
  useEffect(() => events.on('scan', setScan), []);
  useEffect(() => {
    if (!scan?.running) return;
    const t = setInterval(() => api.get('/api/library/scan').then(setScan).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [scan?.running]);
  const startScan = async () => {
    try { setScan(await api.post('/api/library/scan')); }
    catch (e) { alert(e.message); }
  };
  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }));
  const runCleanup = async () => {
    setCleaning(true); setCleanMsg(null);
    try {
      const r = await api.post('/api/settings/cleanup-now');
      setCleanMsg({ err: false, text: `Removed ${r.removed} track(s).` });
    } catch (e) { setCleanMsg({ err: true, text: e.message }); }
    setCleaning(false);
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload = Object.fromEntries(SETTING_FIELDS.map(k => [k, s[k] ?? '']));
      // The API key is write-only: the server never sends it back, so only
      // include it when the admin actually typed a new one (otherwise an empty
      // value would be a no-op that leaves the stored key untouched).
      if (!s.slskd_api_key) delete payload.slskd_api_key;
      payload.cleanup_enabled = !!s.cleanup_enabled;
      payload.cleanup_after_days = parseInt(s.cleanup_after_days, 10) || 0;
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
    const body = { section, slskd_url: s.slskd_url, slskd_api_key: s.slskd_api_key };
    try {
      const r = await api.post('/api/settings/test', body);
      setTested(t => ({ ...t, [section]: { ok: true, text: r?.detail ? `Connection successful — ${r.detail}` : 'Connection successful' } }));
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
          When a download finishes, Musicarr hardlinks the files into the root folder
          (Artist/Album/Track) and the library plays everything from there. Keep the root folder on
          the same volume as the slskd download directory so hardlinks work — instant and no extra
          disk space. On different volumes, files are copied instead.
        </p>
        <Field label="Root folder"
          hint="The library: files are hardlinked here and streamed from here, e.g. /data/media/music."
          value={s.root_folder} onChange={v => set('root_folder', v)} />
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Import existing music</h2>
        <p className="settings-hint">
          Already have a music collection? Put it inside the root folder and run a scan:
          each unknown audio file is identified from its tags (and its Artist/Album folder as a
          fallback), matched against Deezer, and added to the library in place — nothing is moved,
          copied or deleted. Files that can't be matched confidently are left untouched.
        </p>
        <div className="settings-actions">
          <button className="btn-ghost" onClick={startScan} disabled={!!scan?.running}>
            {scan?.running ? 'Scanning…' : 'Scan root folder now'}
          </button>
          {scan?.running && scan.total > 0 && (
            <span className="settings-msg">{scan.processed}/{scan.total} files · {scan.imported} imported</span>
          )}
          {!scan?.running && scan?.finishedAt && (
            <span className={`settings-msg ${scan.error ? 'err' : 'ok'}`}>
              {scan.error
                ? `Scan failed: ${scan.error}`
                : `Last scan: ${scan.imported} imported, ${scan.skipped} skipped, ${scan.failed} failed (of ${scan.total}).`}
            </span>
          )}
        </div>
        {scan?.running && scan.total > 0 && (
          <div className="dl-bar" style={{ marginTop: 8 }}>
            <div className="dl-bar-fill" style={{ width: `${Math.round((scan.processed / scan.total) * 100)}%` }} />
          </div>
        )}
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Soulseek (slskd) <span className={`src-pill ${s.slskd_enabled ? 'on' : ''}`}>{s.slskd_enabled ? 'enabled' : 'off'}</span></h2>
        <p className="settings-hint">
          The download engine: tracks are fetched from the Soulseek network one file at a time, and
          albums as a whole folder from a single peer. Point the download directory at slskd's
          completed-downloads folder, mounted so Musicarr can read it. For good standing on Soulseek,
          configure slskd to share your music root folder back.
        </p>
        <Field label="URL" hint="e.g. http://slskd:5030 (no trailing slash)" value={s.slskd_url} onChange={v => set('slskd_url', v)} />
        <Field label="API key" type="password"
          hint={s.slskd_api_key_set ? `A key is configured (${s.slskd_api_key_hint}). Leave blank to keep it, or type a new one to replace it.` : 'Not set yet.'}
          value={s.slskd_api_key} onChange={v => set('slskd_api_key', v)} />
        <Field label="Download directory" hint="Where slskd writes finished files, as Musicarr sees it (shared volume), e.g. /data/slskd/downloads"
          value={s.slskd_download_dir} onChange={v => set('slskd_download_dir', v)} />
        <div className="settings-actions">
          <button className="btn-ghost" onClick={() => test('slskd')} disabled={testing === 'slskd'}>
            {testing === 'slskd' ? 'Testing…' : 'Test connection'}
          </button>
          <TestResult section="slskd" />
        </div>
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Library maintenance</h2>
        <p className="settings-hint">
          Automatically free up disk space by deleting tracks you haven't played in a while.
          Liked songs and tracks in any playlist are always kept. Off by default.
        </p>
        <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={!!s.cleanup_enabled} onChange={e => set('cleanup_enabled', e.target.checked)} />
          <span className="settings-label" style={{ margin: 0 }}>Automatically remove unplayed tracks</span>
        </label>
        <Field label="Remove after (days without a play)" type="number"
          hint="e.g. 30. A track never played is aged from when it was added. Set 0 to disable."
          value={s.cleanup_after_days ?? 0} onChange={v => set('cleanup_after_days', v)} />
        <div className="settings-actions">
          <button className="btn-ghost" disabled={cleaning || !s.cleanup_enabled || !(parseInt(s.cleanup_after_days, 10) > 0)}
            onClick={runCleanup}>{cleaning ? 'Cleaning…' : 'Run cleanup now'}</button>
          {cleanMsg && <span className={`settings-msg ${cleanMsg.err ? 'err' : 'ok'}`}>{cleanMsg.text}</span>}
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
export function Admin({ me, nav }) {
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
          <div key={u.id} className="admin-row clickable"
            onClick={() => nav(u.id === me.id ? { view: 'profile' } : { view: 'user', id: u.id })}
            title="View profile">
            <Icon name="user" size={18} />
            <span className="admin-name">{u.username}</span>
            {!!u.is_admin && <span className="badge accent">Admin</span>}
            <span style={{ flex: 1 }} />
            {u.id !== me.id && <button className="icon-btn" onClick={(e) => { e.stopPropagation(); del(u.id); }}><Icon name="trash" size={16} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Social */
function FollowButton({ user, onChange }) {
  const [following, setFollowing] = useState(user.following);
  useEffect(() => setFollowing(user.following), [user.following]);
  const toggle = async (e) => {
    e.stopPropagation();
    const nv = !following; setFollowing(nv);
    try {
      if (nv) await api.post(`/api/social/follow/${user.id}`);
      else await api.del(`/api/social/follow/${user.id}`);
      onChange?.(nv);
    } catch { setFollowing(!nv); }
  };
  return <button className={`btn-ghost sm ${following ? 'on' : ''}`} onClick={toggle}>{following ? 'Following' : 'Follow'}</button>;
}

function UserRow({ u, nav, onChange }) {
  const userMenu = useUserMenu();
  const sub = u.nowPlaying
    ? <span className="np-live"><span className="np-dot" /> {u.nowPlaying.title} · {u.nowPlaying.artist}</span>
    : <span>{u.lastPlayed ? `Last played: ${u.lastPlayed.title}` : `${u.followers} follower${u.followers === 1 ? '' : 's'}`}</span>;
  return (
    <div className="user-row" onClick={() => nav({ view: 'user', id: u.id })}
      onContextMenu={(e) => userMenu(e, u, { onChange })}>
      <Avatar src={u.avatar} size={44} />
      <div className="user-row-meta">
        <div className="user-row-name">{u.username}{u.is_admin ? <span className="badge accent" style={{ marginLeft: 8 }}>Admin</span> : null}</div>
        <div className="user-row-sub">{sub}</div>
      </div>
      <div onClick={e => e.stopPropagation()}><FollowButton user={u} onChange={onChange} /></div>
    </div>
  );
}

export function UserProfile({ id, nav }) {
  const { data, err, loading } = useAsync(() => api.get(`/api/social/users/${id}`), [id]);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const recent = (data.recent || []).map(t => ({ ...t, available: !!t.available }));
  const favs = (data.favorites || []).map(t => ({ ...t, available: !!t.available }));
  return (
    <div className="page">
      <header className="hero">
        <Avatar src={data.avatar} size={200} className="hero-avatar" />
        <div className="hero-meta">
          <span className="hero-kind">Profile</span>
          <h1 className="hero-title">{data.username}</h1>
          <span className="hero-sub faint">{data.followers} followers · {data.following_count} following</span>
          <div className="hero-actions">
            <FollowButton user={data} />
            <button className="btn-ghost sm" onClick={() => nav({ view: 'stats', id: data.id })}>
              <Icon name="chart" size={16} /> View stats
            </button>
          </div>
          {data.nowPlaying && (
            <div className="np-live" style={{ marginTop: 12 }}>
              <span className="np-dot" /> Listening to <b style={{ margin: '0 5px' }}>{data.nowPlaying.title}</b> · {data.nowPlaying.artist}
            </div>
          )}
        </div>
      </header>
      {!!recent.length && (
        <section className="page-block">
          <h2 className="row-title">Recently played</h2>
          <TrackTable tracks={recent} nav={nav} showAdded={false} />
        </section>
      )}
      {!!favs.length && (
        <section className="page-block">
          <h2 className="row-title">Liked songs</h2>
          <TrackTable tracks={favs} nav={nav} showAdded={false} />
        </section>
      )}
      {!!data.playlists?.length && (
        <section className="page-block">
          <h2 className="row-title">Playlists</h2>
          <div className="card-grid">
            {data.playlists.map(pl => (
              <TileCard key={pl.id} cover={pl.cover} title={pl.name} sub={`${pl.count || 0} tracks`}
                onClick={() => nav({ view: 'playlist', id: pl.id })} />
            ))}
          </div>
        </section>
      )}
      {!recent.length && !favs.length && !data.playlists?.length && <div className="state faint">No public activity yet.</div>}
    </div>
  );
}
