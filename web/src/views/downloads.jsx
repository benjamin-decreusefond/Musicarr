import { useState, useEffect, useCallback } from 'react';
import { api, usePlayer } from '../store.jsx';
import { events } from '../events.js';
import { Icon, Cover } from '../ui.jsx';

export function Downloads({ nav }) {
  const player = usePlayer();
  const [items, setItems] = useState([]);
  const load = useCallback(async () => { try { setItems(await api.get('/api/downloads')); } catch {} }, []);
  // Live updates over SSE; the poll only fires while SSE is down (plus a slow
  // safety refresh to heal any missed event).
  useEffect(() => {
    load();
    const off = events.on('download', (d) => setItems(prev => {
      if (d.removed) return prev.filter(x => x.id !== d.id);
      const i = prev.findIndex(x => x.id === d.id);
      if (i < 0) return [d, ...prev];
      const next = [...prev];
      next[i] = { ...next[i], ...d };
      return next;
    }));
    let n = 0;
    const t = setInterval(() => { n++; if (events.connected && n % 8 !== 0) return; load(); }, 4000);
    return () => { off(); clearInterval(t); };
  }, [load]);
  const remove = async (id) => { await api.del(`/api/downloads/${id}`); load(); };
  const retry = async (id) => { try { await api.post(`/api/downloads/${id}/retry`, {}); } catch (e) { alert(e.message); } load(); };
  const statusLabel = { searching: 'Searching', downloading: 'Downloading', importing: 'Importing', done: 'Done', not_found: 'Not found', error: 'Error' };

  // Click a finished download: play the track and jump to the library; for an
  // album, open the album page. Label is "Artist – Title".
  const open = (d) => {
    if (d.status !== 'done') return;
    if (d.kind === 'album') { nav?.({ view: 'album', id: d.deezer_id }); return; }
    const [artist, title] = String(d.label || '').split(' – ');
    player.playTrack({ deezer_id: d.deezer_id, title: title || d.label, artist: artist || '', cover: d.cover, available: true });
    nav?.({ view: 'library' });
  };

  return (
    <div className="page">
      <h1 className="page-h1">Downloads</h1>
      <div className="dl-list">
        {items.map(d => (
          <div key={d.id} className={`dl-item ${d.status === 'done' ? 'playable' : ''}`}
            onClick={d.status === 'done' ? () => open(d) : undefined}
            title={d.status === 'done' ? (d.kind === 'album' ? 'Open album' : 'Play in library') : undefined}>
            <Cover src={d.cover} size={52} />
            <div className="dl-main">
              <div className="dl-label">{d.label}{d.username ? <span className="dl-by"> · {d.username}</span> : ''}</div>
              <div className="dl-detail">{d.detail || statusLabel[d.status]}</div>
              {d.status === 'downloading' && (
                <div className="dl-bar"><div className="dl-bar-fill" style={{ width: `${Math.round(d.progress * 100)}%` }} /></div>
              )}
            </div>
            <span className={`dl-status s-${d.status}`}>{statusLabel[d.status] || d.status}</span>
            {(d.status === 'error' || d.status === 'not_found') && (
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); retry(d.id); }} title="Retry this download"><Icon name="refresh" size={16} /></button>
            )}
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); remove(d.id); }} title="Remove (cancels the transfer; does not delete an already-imported file)"><Icon name="trash" size={16} /></button>
          </div>
        ))}
        {!items.length && <div className="state faint">No downloads yet.</div>}
      </div>
    </div>
  );
}
