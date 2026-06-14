import { useState, useEffect, useCallback } from 'react';
import { api, usePlayer } from './store.jsx';
import { Icon, Cover, TrackRow, TrackTable, CardRow, TileCard, DownloadButton, HeartButton, AddToPlaylist, RadioButton, confirmRadioDownloads } from './ui.jsx';

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
  const [recs, setRecs] = useState(null);
  const [history, setHistory] = useState(null);
  useEffect(() => {
    api.get('/api/recommendations').then(setRecs).catch(() => {});
    api.get('/api/history').then(h => setHistory(h.map(t => ({ ...t, available: !!t.file_path }))) ).catch(() => {});
  }, []);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
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
      {!!recs?.tracks?.length && (
        <section className="page-block">
          <h2 className="row-title">{recs.personalized ? 'You might like' : 'Popular right now'}</h2>
          {recs.personalized && !!recs.basedOn?.length && (
            <p className="settings-hint" style={{ marginTop: -4 }}>Based on {recs.basedOn.map(a => a.name).slice(0, 3).join(', ')}</p>
          )}
          <div className="track-list">
            {recs.tracks.slice(0, 15).map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={recs.tracks} showAlbum />)}
          </div>
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
            <button className="btn-ghost" onClick={async () => {
              if (!confirmRadioDownloads()) return;
              try { await player.startRadio(`artist:${artist.id}`); } catch (e) { alert(e.message); }
            }}>
              <Icon name="radio" size={18} /> Start radio
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
      <section className="page-block">
        <div className="track-list">
          {tracks.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={tracks} />)}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------- Library */
export function Library({ me }) {
  const player = usePlayer();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api.get('/api/library').then(setData).catch(e => setErr(e.message)); }, []);
  // Poll so freshly-queued downloads and their status changes show up live.
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const onDelete = me?.is_admin ? async (id) => {
    try { await api.del(`/api/library/${id}`); setData(d => d.filter(t => t.deezer_id !== id)); }
    catch (e) { alert(e.message); }
  } : undefined;
  if (err) return <ErrState msg={err} />;
  if (!data) return <Loading />;
  const playable = data.filter(t => t.available);
  return (
    <div className="page">
      <div className="list-head">
        <h1 className="page-h1">Your library</h1>
        <div className="list-head-actions">
          <button className="btn-primary" disabled={!playable.length} onClick={() => player.playList(playable, 0, { shuffle: true })}>
            <Icon name="shuffle" size={18} /> Shuffle play
          </button>
        </div>
      </div>
      {data.length ? (
        <div className="track-list">
          {data.map((t, i) => <TrackRow key={t.deezer_id} track={t} i={i} tracks={data} showAlbum onDelete={onDelete} />)}
        </div>
      ) : <div className="state faint">Nothing downloaded yet. Search for music and hit the download button.</div>}
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
export function Playlist({ id, nav }) {
  const { data, err, loading, setData } = useAsync(() => api.get(`/api/playlists/${id}`), [id]);
  const player = usePlayer();
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
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
              onClick={() => player.playList(playable, 0)}>
              <Icon name="play" size={18} fill="currentColor" /> Play
            </button>
            <button className="btn-ghost" disabled={!playable.length}
              onClick={() => player.playList(playable, 0, { shuffle: true })}>
              <Icon name="shuffle" size={18} /> Shuffle
            </button>
          </div>
        </div>
      </header>
      <section className="page-block">
        {tracks.length
          ? <TrackTable tracks={tracks} nav={nav} onRemove={remove} />
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
        <div className="track-list">
          {tracks.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={tracks} showAlbum />)}
        </div>
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
          <div className="track-list">
            {tracks.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={tracks} showAlbum />)}
          </div>
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
          <div className="track-list">
            {data.tracks.map((t, i) => <TrackRow key={t.id} track={t} i={i} tracks={data.tracks} showAlbum />)}
          </div>
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
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  const remove = async (id) => { await api.del(`/api/downloads/${id}`); load(); };
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
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); remove(d.id); }} title="Remove from this list (does not delete the downloaded file)"><Icon name="trash" size={16} /></button>
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
  useEffect(() => {
    api.get('/api/settings').then(setS).catch(e => setMsg({ err: true, text: e.message }));
  }, []);
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
        <h2 className="row-title">Soulseek (slskd) <span className={`src-pill ${s.slskd_enabled ? 'on' : ''}`}>{s.slskd_enabled ? 'enabled' : 'off'}</span></h2>
        <p className="settings-hint">
          The download engine: tracks are fetched from the Soulseek network one file at a time, and
          albums as a whole folder from a single peer. Point the download directory at slskd's
          completed-downloads folder, mounted so Musicarr can read it. For good standing on Soulseek,
          configure slskd to share your music root folder back.
        </p>
        <Field label="URL" hint="e.g. http://slskd:5030 (no trailing slash)" value={s.slskd_url} onChange={v => set('slskd_url', v)} />
        <Field label="API key" type="password" value={s.slskd_api_key} onChange={v => set('slskd_api_key', v)} />
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
  const sub = u.nowPlaying
    ? <span className="np-live"><span className="np-dot" /> {u.nowPlaying.title} · {u.nowPlaying.artist}</span>
    : <span>{u.lastPlayed ? `Last played: ${u.lastPlayed.title}` : `${u.followers} follower${u.followers === 1 ? '' : 's'}`}</span>;
  return (
    <div className="user-row" onClick={() => nav({ view: 'user', id: u.id })}>
      <div className="user-avatar"><Icon name="user" size={20} /></div>
      <div className="user-row-meta">
        <div className="user-row-name">{u.username}{u.is_admin ? <span className="badge accent" style={{ marginLeft: 8 }}>Admin</span> : null}</div>
        <div className="user-row-sub">{sub}</div>
      </div>
      <div onClick={e => e.stopPropagation()}><FollowButton user={u} onChange={onChange} /></div>
    </div>
  );
}

export function Friends({ nav }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState(null);
  const [following, setFollowing] = useState(null);
  const loadFollowing = useCallback(() => { api.get('/api/social/following').then(setFollowing).catch(() => setFollowing([])); }, []);
  const loadUsers = useCallback(() => { api.get(`/api/social/users?q=${encodeURIComponent(q)}`).then(setUsers).catch(() => setUsers([])); }, [q]);
  useEffect(() => { loadFollowing(); const t = setInterval(loadFollowing, 20000); return () => clearInterval(t); }, [loadFollowing]);
  useEffect(() => { const t = setTimeout(loadUsers, 250); return () => clearTimeout(t); }, [loadUsers]);
  const refresh = () => { loadFollowing(); loadUsers(); };
  return (
    <div className="page">
      <h1 className="page-h1">Friends</h1>
      <section className="page-block">
        <h2 className="row-title">Activity</h2>
        {following && following.length > 0
          ? <div className="user-list">{following.map(u => <UserRow key={u.id} u={u} nav={nav} onChange={refresh} />)}</div>
          : <div className="state faint">You're not following anyone yet — find people below.</div>}
      </section>
      <section className="page-block">
        <h2 className="row-title">Find people</h2>
        <div className="search-box"><Icon name="search" size={18} /><input placeholder="Search people on this server…" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="user-list">
          {(users || []).map(u => <UserRow key={u.id} u={u} nav={nav} onChange={refresh} />)}
          {users && !users.length && <div className="state faint">No people found.</div>}
        </div>
      </section>
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
        <div className="fav-art" style={{ background: 'var(--bg-elev-2)' }}><Icon name="user" size={72} /></div>
        <div className="hero-meta">
          <span className="hero-kind">Profile</span>
          <h1 className="hero-title">{data.username}</h1>
          <span className="hero-sub faint">{data.followers} followers · {data.following_count} following</span>
          <div className="hero-actions"><FollowButton user={data} /></div>
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
          <div className="track-list">{recent.map((t, i) => <TrackRow key={t.deezer_id} track={t} i={i} tracks={recent} showAlbum />)}</div>
        </section>
      )}
      {!!favs.length && (
        <section className="page-block">
          <h2 className="row-title">Liked songs</h2>
          <div className="track-list">{favs.map((t, i) => <TrackRow key={t.deezer_id} track={t} i={i} tracks={favs} showAlbum />)}</div>
        </section>
      )}
      {!recent.length && !favs.length && <div className="state faint">No public activity yet.</div>}
    </div>
  );
}
