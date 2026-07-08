// Admin-only pages: user management and the library-health dashboard.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../store.jsx';
import { Icon, Cover } from '../ui.jsx';
import { Loading, ErrState } from './shared.jsx';
import { StatCard } from './stats.jsx';

/* --------------------------------------------------------- Library health */
function fmtBytes(b) {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(b) / 10));
  return `${(b / 2 ** (10 * i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// Admin dashboard for everything that otherwise only lives in the logs:
// vanished files, low-bitrate (upgradable) tracks, duplicate recordings,
// files the import scan couldn't match, and blocked Soulseek peers.
export function LibraryHealth() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [pruning, setPruning] = useState(false);
  const load = useCallback(() => api.get('/api/library/health').then(setData).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const prune = async () => {
    setPruning(true);
    try { await api.post('/api/library/health/prune'); await load(); }
    catch (e) { alert(e.message); }
    setPruning(false);
  };
  const unblock = async (u) => {
    try { await api.del(`/api/library/health/peers/${encodeURIComponent(u)}`); await load(); }
    catch (e) { alert(e.message); }
  };
  if (err) return <ErrState msg={err} />;
  if (!data) return <Loading />;

  const Row = ({ t, extra }) => (
    <div className="dl-item">
      <Cover src={t.cover} size={40} />
      <div className="dl-main">
        <div className="dl-label">{t.title}</div>
        <div className="dl-detail">{t.artist}{t.album ? ` · ${t.album}` : ''}</div>
      </div>
      {extra}
    </div>
  );

  return (
    <div className="page">
      <h1 className="page-h1">Library health</h1>
      <div className="stat-grid">
        <StatCard value={data.tracks} label="Tracks on disk" />
        <StatCard value={data.inLibrary} label="In the Library" />
        <StatCard value={fmtBytes(data.totalBytes)} label="Disk used" />
        <StatCard value={data.missing.length} label="Missing files" />
      </div>

      <section className="page-block settings-section">
        <h2 className="row-title">Missing files</h2>
        <p className="settings-hint">
          Tracks the catalog says are on disk but whose file has vanished (moved, deleted outside
          Musicarr, or an unmounted volume). Prune clears the dead links so they show as
          downloadable again — and relinks any file that reappeared.
        </p>
        <div className="settings-actions">
          <button className="btn-ghost" onClick={prune} disabled={pruning || !data.missing.length}>
            {pruning ? 'Pruning…' : `Prune ${data.missing.length} dead link${data.missing.length === 1 ? '' : 's'}`}
          </button>
        </div>
        {data.missing.slice(0, 50).map(t => <Row key={t.deezer_id} t={t} />)}
        {!data.missing.length && <div className="state faint">Every catalog entry has its file. ✓</div>}
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Low quality ({data.lowBitrate.length})</h2>
        <p className="settings-hint">
          Non-lossless files estimated under 200 kbps — candidates for a re-download in better
          quality. Delete one from the library (admin) and download it again to upgrade.
        </p>
        {data.lowBitrate.slice(0, 50).map(t => (
          <Row key={t.deezer_id} t={t} extra={<span className="dl-status">{t.kbps} kbps</span>} />
        ))}
        {!data.lowBitrate.length && <div className="state faint">No obviously low-quality files. ✓</div>}
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Duplicates ({data.duplicates.length})</h2>
        <p className="settings-hint">The same artist + title stored under multiple Deezer ids.</p>
        {data.duplicates.map(d => (
          <div className="dl-item" key={`${d.artist}|${d.title}`}>
            <div className="dl-main">
              <div className="dl-label">{d.title}</div>
              <div className="dl-detail">{d.artist} · {d.count} copies</div>
            </div>
          </div>
        ))}
        {!data.duplicates.length && <div className="state faint">No duplicate recordings. ✓</div>}
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Unmatched scan files ({data.unmatched.length})</h2>
        <p className="settings-hint">
          Files the last import scan couldn't confidently match to a Deezer track. Fix their tags
          (or folder layout) and re-run the scan from Settings.
        </p>
        {data.unmatched.slice(0, 50).map(u => (
          <div className="dl-item" key={u.file}>
            <div className="dl-main">
              <div className="dl-label mono">{u.file}</div>
              <div className="dl-detail">{u.reason}</div>
            </div>
          </div>
        ))}
        {!data.unmatched.length && <div className="state faint">Nothing left unmatched by the last scan. ✓</div>}
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Blocked peers ({data.blockedPeers.length})</h2>
        <p className="settings-hint">
          Soulseek peers skipped after repeated failures (stalls, rejects, wrong files). A
          successful transfer clears a peer automatically; strikes also expire after a week.
        </p>
        {data.blockedPeers.map(p => (
          <div className="dl-item" key={p.username}>
            <div className="dl-main">
              <div className="dl-label mono">{p.username}</div>
              <div className="dl-detail">{p.strikes} strikes · last {p.last_strike}</div>
            </div>
            <button className="btn-ghost sm" onClick={() => unblock(p.username)}>Unblock</button>
          </div>
        ))}
        {!data.blockedPeers.length && <div className="state faint">No peers are currently blocked. ✓</div>}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- Admin */
export function Admin({ me, nav }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', is_admin: false });
  const load = async () => { try { setUsers(await api.get('/api/users')); } catch {} };
  useEffect(() => { load(); }, []);
  const create = async () => {
    if (!form.username || !form.password) return;
    try { await api.post('/api/users', form); setForm({ username: '', password: '', is_admin: false }); load(); }
    catch (e) { alert(e.message); }
  };
  const del = async (id) => { if (confirm('Delete this user?')) { await api.del(`/api/users/${id}`); load(); } };
  return (
    <div className="page">
      <h1 className="page-h1">Users</h1>
      <div className="admin-form">
        <input placeholder="Username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
        <input placeholder="Password" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
        <label className="chk"><input type="checkbox" checked={form.is_admin} onChange={e => setForm({ ...form, is_admin: e.target.checked })} /> Admin</label>
        <button className="btn-primary" onClick={create}>Add user</button>
      </div>
      <div className="admin-list">
        {users.map(u => (
          <div key={u.id} className="admin-row clickable"
            onClick={() => nav(u.id === me.id ? { view: 'profile' } : { view: 'user', id: u.id })}
            title="View profile">
            <Icon name="user" size={18} />
            <span className="admin-name">{u.username}</span>
            {!!u.is_admin && <span className="badge accent">Admin</span>}
            <span style={{ flex: 1 }} />
            {u.id !== me.id && <button className="icon-btn" onClick={(e) => { e.stopPropagation(); del(u.id); }}><Icon name="trash" size={16} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}
