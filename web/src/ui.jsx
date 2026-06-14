import { useState, useEffect, useRef } from 'react';
import { api, fmtTime, usePlayer, useMe } from './store.jsx';

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
    sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M14 4v4M6 10v4M12 16v4',
    lock: 'M6 10V8a6 6 0 0 1 12 0v2M5 10h14v10H5zM12 14v3',
    shuffle: 'M16 3h5v5M21 3l-7 7M4 20l7-7M4 4l5 5M16 21h5v-5M15 15l6 6',
    queue: 'M4 6h12M4 12h12M4 18h8M17 13v6M17 19a2 2 0 1 0 4 0 2 2 0 0 0-4 0M19 11l3-1',
    grip: 'M9 6h0M9 12h0M9 18h0M15 6h0M15 12h0M15 18h0',
    repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
    radio: 'M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6M5.6 5.6a9 9 0 0 0 0 12.7M18.4 5.6a9 9 0 0 1 0 12.7M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7',
    compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM16 8l-2 6-6 2 2-6 6-2Z',
    lyrics: 'M5 6h11M5 10h14M5 14h9M5 18h6M19 13v6a2 2 0 1 1-2-2',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z',
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

// Radio downloads upcoming songs, so warn about disk use once per session.
export function confirmRadioDownloads() {
  if (sessionStorage.getItem('musicarr:radio:ok') === '1') return true;
  const ok = window.confirm('Radio automatically downloads the upcoming songs from Soulseek so they can be played — this uses disk space. Continue?');
  if (ok) sessionStorage.setItem('musicarr:radio:ok', '1');
  return ok;
}

export function RadioButton({ seed }) {
  const player = usePlayer();
  const go = async (e) => {
    e.stopPropagation();
    if (!confirmRadioDownloads()) return;
    try { await player.startRadio(seed); } catch (err) { alert(err.message); }
  };
  return (
    <button className="icon-btn" onClick={go} title="Start radio (auto-downloads similar songs)">
      <Icon name="radio" size={18} />
    </button>
  );
}

export function HeartButton({ trackId, track, initial, onChange }) {
  const [fav, setFav] = useState(!!initial);
  useEffect(() => setFav(!!initial), [initial]);
  const toggle = async (e) => {
    e.stopPropagation();
    const nv = !fav; setFav(nv);
    try {
      // Send the track metadata so the server can catalog it first (search
      // results aren't in the catalog yet).
      if (nv) await api.put(`/api/favorites/${trackId}`, track || {});
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

export function AddToPlaylist({ trackId, track }) {
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
    try {
      await api.post(`/api/playlists/${pid}/tracks`, { track_id: trackId, track });
      window.dispatchEvent(new Event('musicarr:playlists-changed')); // refresh sidebar counts
    } catch {}
    setOpen(false);
  };
  const create = async (e) => {
    e.stopPropagation();
    const name = prompt('New playlist name');
    if (!name) return;
    try {
      const pl = await api.post('/api/playlists', { name });
      await api.post(`/api/playlists/${pl.id}/tracks`, { track_id: trackId, track });
      window.dispatchEvent(new Event('musicarr:playlists-changed'));
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

/** A single row in a track list. `tracks`/`i` allow play-in-context.
 *  `shuffle` (used by playlists) shuffles the whole list into the queue. */
export function TrackRow({ track, i, tracks, showAlbum, onFav, shuffle, onDelete }) {
  const player = usePlayer();
  const me = useMe();
  const [hidden, setHidden] = useState(false);
  const id = track.deezer_id || track.id;
  const isCurrent = (player.current?.deezer_id || player.current?.id) === id;
  const available = track.available || track.file_path;
  const DL_LABEL = { searching: 'Searching…', downloading: 'Downloading…', importing: 'Importing…', error: 'Failed', not_found: 'Not found' };
  const pending = !available && DL_LABEL[track.download_status];

  const onPlay = () => {
    if (!available) return;
    if (shuffle && tracks && !isCurrent) player.playList(tracks, i ?? 0, { shuffle: true });
    else player.playOrToggle(track, tracks, i ?? 0);
  };
  // Delete the file from disk (admins only). Lets a parent update its own list
  // via onDelete; otherwise the row hides itself optimistically.
  const canDelete = available && me?.is_admin;
  const doDelete = async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${track.title}" from disk? This removes the file from your library.`)) return;
    try {
      await api.del(`/api/library/${id}`);
      window.dispatchEvent(new Event('musicarr:library-changed'));
      if (onDelete) onDelete(id); else setHidden(true);
    } catch (err) { alert(err.message); }
  };
  if (hidden) return null;
  return (
    <div className={`track-row ${isCurrent ? 'current' : ''} ${!available ? 'dim' : ''}`} onClick={onPlay}>
      <div className="track-idx">
        {isCurrent && player.playing
          ? <span className="eq"><i /><i /><i /></span>
          : <span className="num">{(i ?? 0) + 1}</span>}
        <Icon name={isCurrent && player.playing ? 'pause' : 'play'} size={14} fill="currentColor" />
      </div>
      {showAlbum && <Cover src={track.cover} size={40} />}
      <div className="track-main">
        <div className="track-title">{track.title}</div>
        <div className="track-sub">{track.artist}{showAlbum && track.album ? ` · ${track.album}` : ''}</div>
      </div>
      {pending ? <span className="badge">{pending}</span> : (!available && <span className="badge">Not downloaded</span>)}
      <div className="track-actions" onClick={e => e.stopPropagation()}>
        <RadioButton seed={`track:${id}`} />
        <HeartButton trackId={id} track={track} initial={track.favorite} onChange={onFav} />
        <AddToPlaylist trackId={id} track={track} />
        {!available && !pending && <DownloadButton kind="track" id={id} label={track.title} />}
        {canDelete && (
          <button className="icon-btn" title="Delete from disk" onClick={doDelete}>
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
      <span className="track-time">{fmtTime(track.duration)}</span>
    </div>
  );
}

// Short date for the "Added" column (added_at is a UTC "YYYY-MM-DD HH:MM:SS").
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One row of the columnar TrackTable. */
function TrackTableRow({ track, i, tracks, nav, onRemove, showAlbum, showAdded, grid }) {
  const player = usePlayer();
  const me = useMe();
  const id = track.deezer_id || track.id;
  const isCurrent = (player.current?.deezer_id || player.current?.id) === id;
  const available = track.available || track.file_path;
  const DL_LABEL = { searching: 'Searching…', downloading: 'Downloading…', importing: 'Importing…', error: 'Failed', not_found: 'Not found' };
  const pending = !available && DL_LABEL[track.download_status];
  const [hidden, setHidden] = useState(false);

  const onPlay = () => { if (available) player.playOrToggle(track, tracks, i ?? 0); };
  const doDelete = async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${track.title}" from disk? This removes the file from your library.`)) return;
    try { await api.del(`/api/library/${id}`); window.dispatchEvent(new Event('musicarr:library-changed')); setHidden(true); }
    catch (err) { alert(err.message); }
  };
  if (hidden) return null;

  return (
    <div className={`tt-row ${isCurrent ? 'current' : ''} ${!available ? 'dim' : ''}`} style={grid} onClick={onPlay}>
      <div className="tt-idx">
        {isCurrent && player.playing
          ? <span className="eq"><i /><i /><i /></span>
          : <span className="num">{(i ?? 0) + 1}</span>}
        <Icon name={isCurrent && player.playing ? 'pause' : 'play'} size={14} fill="currentColor" />
      </div>
      <div className="tt-title">
        <Cover src={track.cover} size={40} />
        <div className="tt-title-meta">
          <div className="tt-name">{track.title}</div>
          {!available && <div className="tt-badge">{pending || 'Not downloaded'}</div>}
        </div>
      </div>
      <div className="tt-artist">
        {nav && track.artist_id
          ? <span className="link" onClick={e => { e.stopPropagation(); nav({ view: 'artist', id: track.artist_id }); }}>{track.artist}</span>
          : track.artist}
      </div>
      {showAlbum && (
        <div className="tt-album">
          {nav && track.album_id
            ? <span className="link" onClick={e => { e.stopPropagation(); nav({ view: 'album', id: track.album_id }); }}>{track.album}</span>
            : track.album}
        </div>
      )}
      {showAdded && <div className="tt-added">{fmtDate(track.added_at)}</div>}
      <div className="tt-actions" onClick={e => e.stopPropagation()}>
        <HeartButton trackId={id} track={track} initial={track.favorite} />
        <AddToPlaylist trackId={id} track={track} />
        {!available && !pending && <DownloadButton kind="track" id={id} label={track.title} />}
        {available && me?.is_admin && (
          <button className="icon-btn" title="Delete from disk" onClick={doDelete}><Icon name="trash" size={16} /></button>
        )}
        {onRemove && (
          <button className="icon-btn" title="Remove from playlist"
            onClick={e => { e.stopPropagation(); onRemove(id); }}><Icon name="close" size={16} /></button>
        )}
      </div>
      <div className="tt-time">{fmtTime(track.duration)}</div>
    </div>
  );
}

/** Deezer-style columnar track table (Title · Artist · Album · Added · Duration)
 *  with per-row actions on hover. Columns Album/Added can be turned off for
 *  browse contexts. `onRemove` adds a remove-from-playlist button. */
export function TrackTable({ tracks, nav, onRemove, showAlbum = true, showAdded = true }) {
  if (!tracks.length) return <div className="state faint">Nothing here yet.</div>;
  // Build the grid so header and rows always line up regardless of which
  // optional columns are shown.
  const cols = ['32px', 'minmax(0,2.4fr)', 'minmax(0,1.3fr)'];      // idx, title, artist
  if (showAlbum) cols.push('minmax(0,1.3fr)');
  if (showAdded) cols.push('110px');
  cols.push('minmax(96px,132px)', '52px');                          // actions, time
  const grid = { gridTemplateColumns: cols.join(' ') };
  return (
    <div className="tracktable">
      <div className="tt-head" style={grid}>
        <div className="tt-idx">#</div>
        <div>Title</div>
        <div className="tt-artist">Artist</div>
        {showAlbum && <div className="tt-album">Album</div>}
        {showAdded && <div className="tt-added">Added</div>}
        <div />
        <div className="tt-time"><Icon name="clock" size={15} /></div>
      </div>
      {tracks.map((t, i) => (
        <TrackTableRow key={t.deezer_id || t.id} track={t} i={i} tracks={tracks} nav={nav}
          onRemove={onRemove} showAlbum={showAlbum} showAdded={showAdded} grid={grid} />
      ))}
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
