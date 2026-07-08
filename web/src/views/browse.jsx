// Deezer browsing: artist and album pages, and the Explore / Mood / Genre
// discovery views.
import { useState, useEffect } from 'react';
import { api, usePlayer } from '../store.jsx';
import { Icon, Cover, TrackTable, CardRow, TileCard, DownloadButton, confirmRadioDownloads } from '../ui.jsx';
import { useAsync, Loading, ErrState, ImportPlaylistButton } from './shared.jsx';

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
