// Listening stats for the signed-in user (or, for admins/friends, another user).
import { useState } from 'react';
import { api, usePlayer } from '../store.jsx';
import { Icon, TrackTable, CardRow, TileCard } from '../ui.jsx';
import { useAsync, Loading, ErrState } from './shared.jsx';

const STAT_RANGES = [['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']];

export function StatCard({ value, label }) {
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
