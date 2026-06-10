import { useState, useEffect, useRef } from 'react';
import { api, fmtTime, usePlayer } from './store.jsx';

/* Inline icon set (no dependency). */
export const Icon = ({ name, size = 20, fill = 'none' }) => {
  const p = {
    home: 'M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
    library: 'M4 4h6v16H4zM14 4h6v16h-6zM7 8h0M17 8h0',
    play: 'M6 4l14 8-14 8z',
    pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
    next: 'M5 4l10 8-10 8zM18 5v14',
    prev: 'M19 4 9 12l10 8zM6 5v14',
    heart: 'M12 21s-7.5-4.7-10-9.5C.6 8.4 2.3 5 5.5 5c2 0 3.3 1.2 4.5 3 1.2-1.8 2.5-3 4.5-3 3.2 0 4.9 3.4 3.5 6.5C19.5 16.3 12 21 12 21Z',
    plus: 'M12 5v14M5 12h14',
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M5 21h14',
    check: 'M5 13l4 4L19 7',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-4 4-6 8-6s8 2 8 6',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    close: 'M6 6l12 12M18 6 6 18',
    vol: 'M5 9v6h4l5 4V5L9 9zM17 8a5 5 0 0 1 0 8',
    spinner: 'M12 3a9 9 0 1 0 9 9',
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={name === 'spinner' ? 'spin' : ''}>
      <path d={p} />
    </svg>
  );
};

export function Cover({ src, size, round, alt }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: round ? '50%' : 8, flexShrink: 0,
      background: src ? `center/cover url(${src})` : 'var(--bg-elev-2)',
      boxShadow: '0 4px 16px rgba(0,0,0,.4)',
    }} aria-label={alt} role="img" />
  );
}

export function DownloadButton({ kind, id, label }) {
  const [state, setState] = useState('idle');
  const go = async (e) => {
    e.stopPropagation();
    setState('busy');
    try { await api.post('/api/download', { kind, deezer_id: id }); setState('done'); }
    catch { setState('idle'); }
  };
  return (
    <button className="icon-btn" onClick={go} title={`Download ${label}`} disabled={state !== 'idle'}>
      <Icon name={state === 'busy' ? 'spinner' : state === 'done' ? 'check' : 'download'} size={18} />
    </button>
  );
}

export function HeartButton({ trackId, initial, onChange }) {
  const [fav, setFav] = useState(!!initial);
  useEffect(() => setFav(!!initial), [initial]);
  const toggle = async (e) => {
    e.stopPropagation();
    const nv = !fav; setFav(nv);
    try {
      if (nv) await api.put(`/api/favorites/${trackId}`);
      else await api.del(`/api/favorites/${trackId}`);
      onChange?.(nv);
    } catch { setFav(!nv); }
  };
  return (
    <button className="icon-btn" onClick={toggle} title={fav ? 'Remove from favorites' : 'Add to favorites'}
      style={{ color: fav ? 'var(--accent)' : undefined }}>
      <Icon name="heart" size={18} fill={fav ? 'var(--accent)' : 'none'} />
    </button>
  );
}

export function AddToPlaylist({ trackId }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState([]);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const openMenu = async (e) => {
    e.stopPropagation();
    if (!open) { try { setLists(await api.get('/api/playlists')); } catch {} }
    setOpen(o => !o);
  };
  const add = async (pid, e) => {
    e.stopPropagation();
    try { await api.post(`/api/playlists/${pid}/tracks`, { track_id: trackId }); } catch {}
    setOpen(false);
  };
  const create = async (e) => {
    e.stopPropagation();
    const name = prompt('New playlist name');
    if (!name) return;
    try {
      const pl = await api.post('/api/playlists', { name });
      await api.post(`/api/playlists/${pl.id}/tracks`, { track_id: trackId });
      window.dispatchEvent(new Event('tonearr:playlists-changed'));
    } catch {}
    setOpen(false);
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="icon-btn" onClick={openMenu} title="Add to playlist"><Icon name="plus" size={18} /></button>
      {open && (
        <div className="menu" onClick={e => e.stopPropagation()}>
          <button className="menu-item accent" onClick={create}>+ New playlist</button>
          {lists.length > 0 && <div className="menu-sep" />}
          {lists.map(l => <button key={l.id} className="menu-item" onClick={(e) => add(l.id, e)}>{l.name}</button>)}
          {!lists.length && <div className="menu-empty">No playlists yet</div>}
        </div>
      )}
    </div>
  );
}

/** A single row in a track list. `tracks`/`i` allow play-in-context. */
export function TrackRow({ track, i, tracks, showAlbum, onFav }) {
  const player = usePlayer();
  const id = track.deezer_id || track.id;
  const isCurrent = (player.current?.deezer_id || player.current?.id) === id;
  const available = track.available || track.file_path;

  const onPlay = () => {
    if (!available) return;
    if (tracks) player.playList(tracks, i ?? 0);
    else player.playTrack(track);
  };
  return (
    <div className={`track-row ${isCurrent ? 'current' : ''} ${!available ? 'dim' : ''}`} onClick={onPlay}>
      <div className="track-idx">
        {isCurrent && player.playing
          ? <span className="eq"><i /><i /><i /></span>
          : <span className="num">{(i ?? 0) + 1}</span>}
        <Icon name="play" size={14} fill="currentColor" />
      </div>
      {showAlbum && <Cover src={track.cover} size={40} />}
      <div className="track-main">
        <div className="track-title">{track.title}</div>
        <div className="track-sub">{track.artist}{showAlbum && track.album ? ` · ${track.album}` : ''}</div>
      </div>
      {!available && <span className="badge">Not downloaded</span>}
      <div className="track-actions" onClick={e => e.stopPropagation()}>
        <HeartButton trackId={id} initial={track.favorite} onChange={onFav} />
        <AddToPlaylist trackId={id} />
        {!available && <DownloadButton kind="track" id={id} label={track.title} />}
      </div>
      <span className="track-time">{fmtTime(track.duration)}</span>
    </div>
  );
}

export function CardRow({ title, children }) {
  return (
    <section className="card-row">
      <h2 className="row-title">{title}</h2>
      <div className="card-scroll">{children}</div>
    </section>
  );
}

export function TileCard({ cover, round, title, sub, badge, onClick, actions }) {
  return (
    <div className="tile" onClick={onClick}>
      <div className="tile-art">
        <Cover src={cover} size={156} round={round} alt={title} />
        {badge && <span className="tile-badge">{badge}</span>}
        {actions && <div className="tile-actions" onClick={e => e.stopPropagation()}>{actions}</div>}
      </div>
      <div className="tile-title">{title}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}
