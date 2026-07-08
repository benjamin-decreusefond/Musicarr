// Helpers shared by every view: async data loading, the loading/error states,
// and small cross-view widgets.
import { useState, useEffect } from 'react';
import { api } from '../store.jsx';
import { Icon } from '../ui.jsx';

export function useAsync(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    fn().then(d => { if (alive) { setData(d); setLoading(false); } })
        .catch(e => { if (alive) { setErr(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, deps);
  return { data, err, loading, setData };
}

export const Loading = () => <div className="state"><Icon name="spinner" size={28} /></div>;
export const ErrState = ({ msg }) => <div className="state err">{msg}</div>;

/** "+" button on a Deezer playlist tile: imports it as a local playlist and
 *  queues downloads for whatever isn't on disk yet. */
export function ImportPlaylistButton({ playlist, nav }) {
  const [state, setState] = useState('idle'); // idle | busy | done
  const go = async (e) => {
    e.stopPropagation();
    setState('busy');
    try {
      const r = await api.post('/api/playlists/import-deezer', { deezer_playlist_id: playlist.id });
      window.dispatchEvent(new Event('musicarr:playlists-changed'));
      setState('done');
      nav({ view: 'playlist', id: r.id });
    } catch (err) {
      alert(err.message);
      setState('idle');
    }
  };
  return (
    <button className="icon-btn" onClick={go} disabled={state !== 'idle'}
      title={`Add "${playlist.title}" to your playlists and download missing tracks`}>
      <Icon name={state === 'busy' ? 'spinner' : state === 'done' ? 'check' : 'plus'} size={18} />
    </button>
  );
}
