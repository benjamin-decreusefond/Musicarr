// Social views: follow buttons, user rows (Search / Profile friends), and
// other users' public profiles.
import { useState, useEffect } from 'react';
import { api } from '../store.jsx';
import { Icon, Avatar, TrackTable, TileCard, useUserMenu } from '../ui.jsx';
import { useAsync, Loading, ErrState } from './shared.jsx';

export function FollowButton({ user, onChange }) {
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

export function UserRow({ u, nav, onChange }) {
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
