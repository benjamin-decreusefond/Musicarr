// Playlist pages: a local playlist (with sharing/renaming/reordering) and the
// preview of a Deezer playlist before importing it.
import { useState, useEffect } from 'react';
import { api, usePlayer } from '../store.jsx';
import { Icon, Cover, TrackTable } from '../ui.jsx';
import { useAsync, Loading, ErrState } from './shared.jsx';

// Owner-only panel to share a playlist with other users (view or collaborate).
function SharePanel({ playlistId, initialShares }) {
  const [shares, setShares] = useState(initialShares || []);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try { const r = await api.get(`/api/social/users?q=${encodeURIComponent(q)}`); if (live) setResults(r || []); }
      catch { if (live) setResults([]); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const sharedIds = new Set(shares.map(s => s.user_id));
  const save = async (userId, username, canEdit) => {
    try {
      await api.post(`/api/playlists/${playlistId}/shares`, { user_id: userId, can_edit: canEdit });
      setShares(prev => [...prev.filter(s => s.user_id !== userId), { user_id: userId, username, can_edit: canEdit ? 1 : 0 }]);
    } catch (e) { alert(e.message); }
  };
  const removeShare = async (userId) => {
    try { await api.del(`/api/playlists/${playlistId}/shares/${userId}`); setShares(prev => prev.filter(s => s.user_id !== userId)); }
    catch (e) { alert(e.message); }
  };
  const candidates = results.filter(u => !sharedIds.has(u.id));
  return (
    <section className="page-block share-panel">
      <h2 className="row-title">Share with people</h2>
      {!!shares.length && (
        <div className="share-list">
          {shares.map(s => (
            <div className="share-row" key={s.user_id}>
              <span className="share-name">{s.username}</span>
              <label className="share-edit">
                <input type="checkbox" checked={!!s.can_edit}
                  onChange={e => save(s.user_id, s.username, e.target.checked)} /> Can edit
              </label>
              <button className="btn-ghost sm" onClick={() => removeShare(s.user_id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <input className="share-search" placeholder="Search users to share with…" value={q}
        onChange={e => setQ(e.target.value)} />
      <div className="share-results">
        {candidates.map(u => (
          <div className="share-row" key={u.id}>
            <span className="share-name">{u.username}</span>
            <button className="btn-ghost sm" onClick={() => save(u.id, u.username, false)}>Share</button>
            <button className="btn-ghost sm" onClick={() => save(u.id, u.username, true)}>Share &amp; allow edits</button>
          </div>
        ))}
        {q && !candidates.length && <div className="state faint">No matching users.</div>}
      </div>
    </section>
  );
}

export function Playlist({ id, nav }) {
  const { data, err, loading, setData } = useAsync(() => api.get(`/api/playlists/${id}`), [id]);
  const player = usePlayer();
  const [showShare, setShowShare] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  useEffect(() => { setShowShare(false); setEditingName(false); }, [id]);
  if (loading) return <Loading />;
  if (err) return <ErrState msg={err} />;
  const canEdit = !!data.can_edit;
  const tracks = (data.tracks || []).map(t => ({ ...t, available: !!t.file_path }));
  const playable = tracks.filter(t => t.available);
  const remove = async (trackId) => {
    await api.del(`/api/playlists/${id}/tracks/${trackId}`);
    setData({ ...data, tracks: data.tracks.filter(t => t.deezer_id !== trackId) });
    window.dispatchEvent(new Event('musicarr:playlists-changed'));
  };
  const rename = async () => {
    const name = nameDraft.trim();
    setEditingName(false);
    if (!name || name === data.name) return;
    try {
      await api.put(`/api/playlists/${id}`, { name });
      setData({ ...data, name });
      window.dispatchEvent(new Event('musicarr:playlists-changed'));
    } catch (e) { alert(e.message); }
  };
  // Optimistic drag-reorder; on failure, reload the server's order.
  const reorder = async (from, to) => {
    const next = [...data.tracks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setData({ ...data, tracks: next });
    try {
      await api.put(`/api/playlists/${id}/reorder`, { track_ids: next.map(t => t.deezer_id) });
    } catch (e) {
      alert(e.message);
      try { setData(await api.get(`/api/playlists/${id}`)); } catch { /* keep optimistic order */ }
    }
  };
  const meta = [
    !data.is_owner && data.owner_name ? `by ${data.owner_name}` : null,
    `${tracks.length} tracks`,
    data.role === 'editor' ? 'you can edit' : (!data.is_owner && data.role === 'viewer' ? 'view only' : null),
  ].filter(Boolean).join(' · ');
  return (
    <div className="page">
      <header className="hero">
        <Cover src={tracks[0]?.cover} size={200} alt={data.name} />
        <div className="hero-meta">
          <span className="hero-kind">{data.shared ? 'Shared playlist' : 'Playlist'}</span>
          {editingName ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="settings-input" autoFocus value={nameDraft} maxLength={120}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditingName(false); }} />
              <button className="btn-primary" onClick={rename}>Save</button>
              <button className="btn-ghost" onClick={() => setEditingName(false)}>Cancel</button>
            </div>
          ) : (
            <h1 className="hero-title">
              {data.name}
              {data.is_owner && (
                <button className="icon-btn" title="Rename playlist" style={{ marginLeft: 8, verticalAlign: 'middle' }}
                  onClick={() => { setNameDraft(data.name); setEditingName(true); }}>
                  <Icon name="edit" size={16} />
                </button>
              )}
            </h1>
          )}
          <span className="hero-sub faint">{meta}</span>
          <div className="hero-actions">
            <button className="btn-primary" disabled={!playable.length}
              onClick={() => player.playList(playable, 0)}>
              <Icon name="play" size={18} fill="currentColor" /> Play
            </button>
            <button className="btn-ghost" disabled={!playable.length}
              onClick={() => player.playList(playable, 0, { shuffle: true })}>
              <Icon name="shuffle" size={18} /> Shuffle
            </button>
            {data.is_owner && (
              <button className={`btn-ghost ${showShare ? 'on' : ''}`} onClick={() => setShowShare(v => !v)}>
                <Icon name="user" size={18} /> Share
              </button>
            )}
          </div>
        </div>
      </header>
      {showShare && data.is_owner && <SharePanel playlistId={id} initialShares={data.shares || []} />}
      <section className="page-block">
        {tracks.length
          ? <TrackTable tracks={tracks} nav={nav} onRemove={canEdit ? remove : undefined}
              onReorder={canEdit ? reorder : undefined} />
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
        <TrackTable tracks={tracks} nav={nav} showAdded={false} />
      </section>
    </div>
  );
}
