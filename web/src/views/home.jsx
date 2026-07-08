import { useState, useEffect } from 'react';
import { api } from '../store.jsx';
import { TrackTable, CardRow, TileCard, DownloadButton, RadioButton } from '../ui.jsx';
import { useT } from '../i18n.jsx';
import { useAsync, Loading, ErrState, ImportPlaylistButton } from './shared.jsx';
import { MixCard } from './mixes.jsx';

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
