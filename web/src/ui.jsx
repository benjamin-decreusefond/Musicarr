import { useState, useEffect, useRef } from 'react';
import { api, fmtTime, usePlayer, useMe } from './store.jsx';
import { useContextMenu } from './menu.jsx';
import { useT } from './i18n.jsx';

// Fire a global navigation request (handled by <App>), so deep components like
// the context menu can route without prop-drilling `nav`.
const navTo = (route) => window.dispatchEvent(new CustomEvent('musicarr:navigate', { detail: route }));

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
    key: 'M15.5 7.5a3 3 0 1 1-2.6 4.5L8 17l-2 0 0-2 .5-.5L4 12l2-2 5.9-5.9A3 3 0 0 1 15.5 7.5Z',
    copy: 'M9 9h10v10H9zM5 15H4V4h11v1',
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
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    sparkles: 'M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 14l.9 2.3 2.3.9-2.3.9L19 20.4l-.9-2.3-2.3-.9 2.3-.9z',
    users: 'M16 14c2.7 0 5 1.8 5 4v2H11v-2c0-2.2 2.3-4 5-4ZM8.5 13C10.4 13 12 14.3 12 16v2H1v-2c0-1.7 1.6-3 3.5-3M8 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6M16.5 5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5',
    cast: 'M2 8V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7M2 12a8 8 0 0 1 8 8M2 16a4 4 0 0 1 4 4M2 20h0',
    save: 'M6 19a4 4 0 0 1-.6-8A6 6 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9H6ZM9 13l3 3 3-3M12 9v7',
    addCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v8M8 12h8',
    camera: 'M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    headphones: 'M4 14v-1a8 8 0 0 1 16 0v1M3 16a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h0a2 2 0 0 1-2-2zM21 16a2 2 0 0 0-2-2h0a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2z',
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

// Round user avatar: shows the uploaded picture when `src` is set, otherwise a
// neutral person glyph. Used in the sidebar, friend activity and profiles.
export function Avatar({ src, size = 44, className = '' }) {
  return (
    <div className={`user-avatar ${className}`}
      style={src
        ? { width: size, height: size, backgroundImage: `url(${src})`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : { width: size, height: size }}>
      {!src && <Icon name="user" size={Math.max(14, Math.round(size * 0.45))} />}
    </div>
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

// Play a 30-second Deezer preview of a track (for songs not downloaded yet).
export function PreviewButton({ track }) {
  const player = usePlayer();
  const t = useT();
  const id = track.deezer_id || track.id;
  const active = player.previewId === id;
  const loading = active && player.previewLoading;
  return (
    <button className="icon-btn" title={t('ctx.preview')}
      onClick={(e) => { e.stopPropagation(); player.previewTrack(track); }}
      style={{ color: active ? 'var(--accent)' : undefined }}>
      <Icon name={loading ? 'spinner' : active ? 'pause' : 'headphones'} size={18} />
    </button>
  );
}

// Promote an already-on-server track into the shared Library (e.g. a song seen
// in another user's activity that isn't in the library yet).
export function AddToLibraryButton({ track, onAdded }) {
  const [state, setState] = useState('idle');
  const t = useT();
  const id = track.deezer_id || track.id;
  const go = async (e) => {
    e.stopPropagation();
    setState('busy');
    try {
      await api.put(`/api/library/${id}`, {});
      setState('done');
      window.dispatchEvent(new Event('musicarr:library-changed'));
      onAdded?.();
    } catch (err) { setState('idle'); alert(err.message); }
  };
  return (
    <button className="icon-btn" onClick={go} title={t('ctx.addToLibrary')} disabled={state !== 'idle'}>
      <Icon name={state === 'busy' ? 'spinner' : state === 'done' ? 'check' : 'addCircle'} size={18} />
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

/** Build the right-click context menu for a track and return an onContextMenu
 *  handler. Reused by both the compact TrackRow and the columnar TrackTableRow
 *  so every track listing exposes the same Musicarr actions. */
export function useTrackMenu() {
  const player = usePlayer();
  const me = useMe();
  const { openMenu } = useContextMenu() || {};
  const t = useT();

  return (e, track, opts = {}) => {
    if (!openMenu) return;
    const id = track.deezer_id || track.id;
    const available = track.available || track.file_path;
    const items = [];

    if (available) {
      items.push({ label: t('ctx.play'), icon: 'play', onClick: () => player.playOrToggle(track, opts.tracks, opts.i ?? 0) });
      items.push({ label: t('ctx.playNext'), icon: 'next', onClick: () => player.playNext(track) });
      items.push({ label: t('ctx.addToQueue'), icon: 'queue', onClick: () => player.enqueue(track) });
    } else {
      items.push({ label: t('ctx.preview'), icon: 'headphones', onClick: () => player.previewTrack(track) });
      items.push({ label: t('ctx.download'), icon: 'download', onClick: () =>
        api.post('/api/download', { kind: 'track', deezer_id: id, track }).catch(err => alert(err.message)) });
    }
    // Already on the server but not in the shared Library yet → offer to add it.
    if (available && track.in_library === 0) {
      items.push({ label: t('ctx.addToLibrary'), icon: 'addCircle', onClick: async () => {
        try { await api.put(`/api/library/${id}`, {}); track.in_library = 1; window.dispatchEvent(new Event('musicarr:library-changed')); opts.onAddedToLibrary?.(); }
        catch (err) { alert(err.message); }
      } });
    }
    items.push({ label: t('ctx.startRadio'), icon: 'radio', onClick: () => {
      if (confirmRadioDownloads()) player.startRadio(`track:${id}`).catch(err => alert(err.message));
    } });

    items.push({ separator: true });
    items.push({
      label: track.favorite ? t('ctx.unlike') : t('ctx.like'), icon: 'heart',
      onClick: async () => {
        try {
          if (track.favorite) await api.del(`/api/favorites/${id}`);
          else await api.put(`/api/favorites/${id}`, track || {});
          track.favorite = !track.favorite;
          opts.onFav?.(track.favorite);
        } catch (err) { alert(err.message); }
      },
    });
    items.push({
      label: t('ctx.addToPlaylist'), icon: 'plus',
      emptyLabel: t('ctx.noPlaylists'),
      loadSubmenu: async () => {
        const lists = await api.get('/api/playlists').catch(() => []);
        const own = lists.filter(l => !l.shared);
        const addTo = (pid) => api.post(`/api/playlists/${pid}/tracks`, { track_id: id, track })
          .then(() => window.dispatchEvent(new Event('musicarr:playlists-changed')))
          .catch(err => alert(err.message));
        const out = [{
          label: t('ctx.newPlaylist'), icon: 'plus', onClick: async () => {
            const name = prompt(t('nav.newPlaylist'));
            if (!name) return;
            try { const pl = await api.post('/api/playlists', { name }); await addTo(pl.id); }
            catch (err) { alert(err.message); }
          },
        }];
        if (own.length) out.push({ separator: true });
        for (const l of own) out.push({ label: l.name, onClick: () => addTo(l.id) });
        return out;
      },
    });

    if (track.artist_id || track.album_id) {
      items.push({ separator: true });
      if (track.artist_id) items.push({ label: t('ctx.goToArtist'), icon: 'user', onClick: () => navTo({ view: 'artist', id: track.artist_id }) });
      if (track.album_id) items.push({ label: t('ctx.goToAlbum'), icon: 'library', onClick: () => navTo({ view: 'album', id: track.album_id }) });
    }

    if (available && me?.is_admin) {
      items.push({ separator: true });
      items.push({
        label: t('ctx.deleteFromLibrary'), icon: 'trash', danger: true,
        onClick: async () => {
          if (!confirm(`Delete "${track.title}" from disk?`)) return;
          try { await api.del(`/api/library/${id}`); window.dispatchEvent(new Event('musicarr:library-changed')); opts.onDelete?.(id); }
          catch (err) { alert(err.message); }
        },
      });
    }

    openMenu(e, items);
  };
}

/** Right-click menu for a user (friend activity, user lists): view profile and
 *  follow/unfollow. `opts.onChange(following)` lets the caller refresh. */
export function useUserMenu() {
  const { openMenu } = useContextMenu() || {};
  const t = useT();
  return (e, user, opts = {}) => {
    if (!openMenu || !user) return;
    const items = [
      { label: t('ctx.viewProfile'), icon: 'user', onClick: () => navTo({ view: 'user', id: user.id }) },
      { separator: true },
      user.following
        ? { label: t('ctx.unfollow'), icon: 'close', onClick: async () => {
            try { await api.del(`/api/social/follow/${user.id}`); opts.onChange?.(false); } catch (err) { alert(err.message); } } }
        : { label: t('ctx.follow'), icon: 'plus', onClick: async () => {
            try { await api.post(`/api/social/follow/${user.id}`); opts.onChange?.(true); } catch (err) { alert(err.message); } } },
    ];
    openMenu(e, items);
  };
}

/** A single row in a track list. `tracks`/`i` allow play-in-context.
 *  `shuffle` (used by playlists) shuffles the whole list into the queue. */
/** Render a track's artists: the main artist plus any featured contributors
 *  (Deezer), comma-separated and each linkable to its artist page when `nav` is
 *  given. Falls back to the single artist string for library/DB tracks. */
export function TrackArtists({ track, nav }) {
  const mainId = track.artist_id;
  const link = (name, id) => (nav && id)
    ? <span className="link" onClick={e => { e.stopPropagation(); nav({ view: 'artist', id }); }}>{name}</span>
    : <span>{name}</span>;
  const extra = (track.contributors || []).filter(c => c && c.name && c.id !== mainId);
  if (!extra.length) return link(track.artist, mainId);
  const seen = new Set([(track.artist || '').toLowerCase()]);
  const parts = [link(track.artist, mainId)];
  for (const c of extra) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(link(c.name, c.id));
  }
  return <>{parts.map((p, idx) => <span key={idx}>{idx ? ', ' : ''}{p}</span>)}</>;
}

export function TrackRow({ track, i, tracks, showAlbum, onFav, shuffle, onDelete }) {
  const player = usePlayer();
  const me = useMe();
  const trackMenu = useTrackMenu();
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
    <div className={`track-row ${isCurrent ? 'current' : ''} ${!available ? 'dim' : ''}`} onClick={onPlay}
      onContextMenu={(e) => trackMenu(e, track, { tracks, i, onFav, onDelete: (delId) => { if (onDelete) onDelete(delId); else setHidden(true); } })}>
      <div className="track-idx">
        {isCurrent && player.playing
          ? <span className="eq"><i /><i /><i /></span>
          : <span className="num">{(i ?? 0) + 1}</span>}
        <Icon name={isCurrent && player.playing ? 'pause' : 'play'} size={14} fill="currentColor" />
      </div>
      {showAlbum && <Cover src={track.cover} size={40} />}
      <div className="track-main">
        <div className="track-title">{track.title}</div>
        <div className="track-sub"><TrackArtists track={track} />{showAlbum && track.album ? ` · ${track.album}` : ''}</div>
      </div>
      {pending ? <span className="badge">{pending}</span> : (!available && <span className="badge">Not downloaded</span>)}
      <div className="track-actions" onClick={e => e.stopPropagation()}>
        <RadioButton seed={`track:${id}`} />
        <HeartButton trackId={id} track={track} initial={track.favorite} onChange={onFav} />
        <AddToPlaylist trackId={id} track={track} />
        {available && track.in_library === 0 && <AddToLibraryButton track={track} />}
        {!available && !pending && <PreviewButton track={track} />}
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
  const trackMenu = useTrackMenu();
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
    <div className={`tt-row ${isCurrent ? 'current' : ''} ${!available ? 'dim' : ''}`} style={grid} onClick={onPlay}
      onContextMenu={(e) => trackMenu(e, track, { tracks, i, onDelete: () => setHidden(true) })}>
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
        <TrackArtists track={track} nav={nav} />
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
        {available && track.in_library === 0 && <AddToLibraryButton track={track} />}
        {!available && !pending && <PreviewButton track={track} />}
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
