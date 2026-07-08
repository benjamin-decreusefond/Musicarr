// Made-for-you mixes: the tile (also used on Home), the overview page, and the
// full track listing for one mix.
import { api, usePlayer } from '../store.jsx';
import { Icon, Cover, TrackTable, CardRow } from '../ui.jsx';
import { useAsync, Loading, ErrState } from './shared.jsx';

// A mix tile that plays its tracks on click (Liked Songs shuffles). Discovery
// "daily" mixes are mostly not on disk yet, so playing one queues whatever is
// available and offers to download the rest.
export function MixCard({ mix, nav }) {
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
