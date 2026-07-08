import { useState, useEffect, useCallback } from 'react';
import { api } from '../store.jsx';
import { Icon, TrackTable, CardRow, TileCard, DownloadButton } from '../ui.jsx';
import { Loading } from './shared.jsx';
import { UserRow } from './social.jsx';

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
