// Admin server settings: root folder, slskd connection, import scan, file tags, cleanup.
import { useState, useEffect } from 'react';
import { api, useMe } from '../store.jsx';
import { events } from '../events.js';
import { Loading, ErrState } from './shared.jsx';

// Read-only summary of how the server authenticates requests. The method itself
// is a boot-time setting (AUTH_METHOD env var), not a runtime toggle, because it
// changes the server's security posture.
const AUTH_METHOD_INFO = {
  login: ['Built-in login', 'Users sign in with a username and password managed by Musicarr.'],
  none: ['Disabled', 'No authentication — every request acts as a single admin user. Only safe on a trusted, isolated network.'],
  proxy: ['Trusted reverse proxy', 'An authenticating proxy (oauth2-proxy, Authelia, Authentik, …) signs users in and Musicarr trusts its identity header. API tokens still work for direct clients.'],
};

function AuthMethodCard() {
  const me = useMe();
  const [label, desc] = AUTH_METHOD_INFO[me?.auth_method] || AUTH_METHOD_INFO.login;
  return (
    <section className="page-block settings-section">
      <h2 className="row-title">Authentication <span className="src-pill on">{label}</span></h2>
      <p className="settings-hint">{desc}</p>
      <p className="settings-fieldhint">
        Set with the <code>AUTH_METHOD</code> environment variable (<code>login</code>, <code>none</code>, or <code>proxy</code>)
        and restart. See the README for the matching <code>AUTH_PROXY_*</code> options.
      </p>
    </section>
  );
}

const SETTING_FIELDS = ['root_folder', 'slskd_url', 'slskd_api_key', 'slskd_download_dir', 'download_format'];

const DOWNLOAD_FORMATS = [
  ['any', 'Any format (best quality wins)'],
  ['mp3', 'MP3 only'],
  ['flac', 'FLAC only'],
];

function Field({ label, hint, type = 'text', value, onChange }) {
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <input className="settings-input" type={type} value={value ?? ''} spellCheck={false}
        autoComplete="off" onChange={e => onChange(e.target.value)} />
      {hint && <span className="settings-fieldhint">{hint}</span>}
    </label>
  );
}

function Select({ label, hint, value, options, onChange }) {
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <select className="settings-input" value={value ?? ''} onChange={e => onChange(e.target.value)}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
      {hint && <span className="settings-fieldhint">{hint}</span>}
    </label>
  );
}

export function Settings() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(null);
  const [tested, setTested] = useState({});
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState(null);
  const [scan, setScan] = useState(null);
  useEffect(() => {
    api.get('/api/settings').then(setS).catch(e => setMsg({ err: true, text: e.message }));
    api.get('/api/library/scan').then(setScan).catch(() => {});
  }, []);
  // Live scan progress: SSE when available, polling while a scan runs.
  useEffect(() => events.on('scan', setScan), []);
  useEffect(() => {
    if (!scan?.running) return;
    const t = setInterval(() => api.get('/api/library/scan').then(setScan).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [scan?.running]);
  const startScan = async () => {
    try { setScan(await api.post('/api/library/scan')); }
    catch (e) { alert(e.message); }
  };
  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }));
  const runCleanup = async () => {
    setCleaning(true); setCleanMsg(null);
    try {
      const r = await api.post('/api/settings/cleanup-now');
      setCleanMsg({ err: false, text: `Removed ${r.removed} track(s).` });
    } catch (e) { setCleanMsg({ err: true, text: e.message }); }
    setCleaning(false);
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload = Object.fromEntries(SETTING_FIELDS.map(k => [k, s[k] ?? '']));
      // The API key is write-only: the server never sends it back, so only
      // include it when the admin actually typed a new one (otherwise an empty
      // value would be a no-op that leaves the stored key untouched).
      if (!s.slskd_api_key) delete payload.slskd_api_key;
      payload.cleanup_enabled = !!s.cleanup_enabled;
      payload.cleanup_after_days = parseInt(s.cleanup_after_days, 10) || 0;
      payload.tag_write_enabled = !!s.tag_write_enabled;
      payload.tag_art_enabled = !!s.tag_art_enabled;
      const next = await api.put('/api/settings', payload);
      setS(next);
      setMsg({ err: false, text: 'Settings saved. Changes apply immediately — no restart needed.' });
    } catch (e) {
      setMsg({ err: true, text: e.message });
    }
    setBusy(false);
  };

  const test = async (section) => {
    setTesting(section); setTested(t => ({ ...t, [section]: null }));
    const body = { section, slskd_url: s.slskd_url, slskd_api_key: s.slskd_api_key };
    try {
      const r = await api.post('/api/settings/test', body);
      setTested(t => ({ ...t, [section]: { ok: true, text: r?.detail ? `Connection successful — ${r.detail}` : 'Connection successful' } }));
    } catch (e) {
      setTested(t => ({ ...t, [section]: { ok: false, text: e.message } }));
    }
    setTesting(null);
  };

  if (!s) return msg ? <ErrState msg={msg.text} /> : <Loading />;
  const TestResult = ({ section }) => {
    const r = tested[section];
    if (!r) return null;
    return <span className={`settings-msg ${r.ok ? 'ok' : 'err'}`}>{r.text}</span>;
  };

  return (
    <div className="page">
      <h1 className="page-h1">Settings</h1>

      <section className="page-block settings-section">
        <h2 className="row-title">Media management</h2>
        <p className="settings-hint">
          When a download finishes, Musicarr hardlinks the files into the root folder
          (Artist/Album/Track) and the library plays everything from there. Keep the root folder on
          the same volume as the slskd download directory so hardlinks work — instant and no extra
          disk space. On different volumes, files are copied instead.
        </p>
        <Field label="Root folder"
          hint="The library: files are hardlinked here and streamed from here, e.g. /data/media/music."
          value={s.root_folder} onChange={v => set('root_folder', v)} />
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Import existing music</h2>
        <p className="settings-hint">
          Already have a music collection? Put it inside the root folder and run a scan:
          each unknown audio file is identified from its tags (and its Artist/Album folder as a
          fallback), matched against Deezer, and added to the library in place — nothing is moved,
          copied or deleted. Files that can't be matched confidently are left untouched.
        </p>
        <div className="settings-actions">
          <button className="btn-ghost" onClick={startScan} disabled={!!scan?.running}>
            {scan?.running ? 'Scanning…' : 'Scan root folder now'}
          </button>
          {scan?.running && scan.total > 0 && (
            <span className="settings-msg">{scan.processed}/{scan.total} files · {scan.imported} imported</span>
          )}
          {!scan?.running && scan?.finishedAt && (
            <span className={`settings-msg ${scan.error ? 'err' : 'ok'}`}>
              {scan.error
                ? `Scan failed: ${scan.error}`
                : `Last scan: ${scan.imported} imported, ${scan.skipped} skipped, ${scan.failed} failed (of ${scan.total}).`}
            </span>
          )}
        </div>
        {scan?.running && scan.total > 0 && (
          <div className="dl-bar" style={{ marginTop: 8 }}>
            <div className="dl-bar-fill" style={{ width: `${Math.round((scan.processed / scan.total) * 100)}%` }} />
          </div>
        )}
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Soulseek (slskd) <span className={`src-pill ${s.slskd_enabled ? 'on' : ''}`}>{s.slskd_enabled ? 'enabled' : 'off'}</span></h2>
        <p className="settings-hint">
          The download engine: tracks are fetched from the Soulseek network one file at a time, and
          albums as a whole folder from a single peer. Point the download directory at slskd's
          completed-downloads folder, mounted so Musicarr can read it. For good standing on Soulseek,
          configure slskd to share your music root folder back.
        </p>
        <Field label="URL" hint="e.g. http://slskd:5030 (no trailing slash)" value={s.slskd_url} onChange={v => set('slskd_url', v)} />
        <Field label="API key" type="password"
          hint={s.slskd_api_key_set ? `A key is configured (${s.slskd_api_key_hint}). Leave blank to keep it, or type a new one to replace it.` : 'Not set yet.'}
          value={s.slskd_api_key} onChange={v => set('slskd_api_key', v)} />
        <Field label="Download directory" hint="Where slskd writes finished files, as Musicarr sees it (shared volume), e.g. /data/slskd/downloads"
          value={s.slskd_download_dir} onChange={v => set('slskd_download_dir', v)} />
        <Select label="Preferred format" options={DOWNLOAD_FORMATS} value={s.download_format || 'any'}
          hint="Restrict what Musicarr downloads from Soulseek. “Any” takes the best candidate and prefers lossless; MP3 only keeps the library small and plays everywhere; FLAC only keeps it lossless. A restriction can leave rarer tracks unavailable."
          onChange={v => set('download_format', v)} />
        <div className="settings-actions">
          <button className="btn-ghost" onClick={() => test('slskd')} disabled={testing === 'slskd'}>
            {testing === 'slskd' ? 'Testing…' : 'Test connection'}
          </button>
          <TestResult section="slskd" />
        </div>
      </section>

      <AuthMethodCard />

      <section className="page-block settings-section">
        <h2 className="row-title">File metadata</h2>
        <p className="settings-hint">
          Soulseek files arrive with whatever tags the peer had — often wrong, often none. Musicarr
          reads titles from its own database, so it doesn't care, but every other player does. Turn
          this on and each imported file is rewritten with the correct artist, album, title, track
          number and ISRC, so the library also reads correctly in Jellyfin, on a phone or in a car.
          The audio itself is copied untouched (no re-encoding), and it needs ffmpeg on the server.
        </p>
        <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={!!s.tag_write_enabled} onChange={e => set('tag_write_enabled', e.target.checked)} />
          <span className="settings-label" style={{ margin: 0 }}>Write tags on imported files</span>
        </label>
        <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={!!s.tag_art_enabled} disabled={!s.tag_write_enabled}
            onChange={e => set('tag_art_enabled', e.target.checked)} />
          <span className="settings-label" style={{ margin: 0 }}>Embed album art (one image download per album)</span>
        </label>
        <p className="settings-fieldhint">
          Only affects new imports — files already in the library are left alone.
        </p>
      </section>

      <section className="page-block settings-section">
        <h2 className="row-title">Library maintenance</h2>
        <p className="settings-hint">
          Automatically free up disk space by deleting tracks you haven't played in a while.
          Liked songs and tracks in any playlist are always kept. Off by default.
        </p>
        <label className="settings-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={!!s.cleanup_enabled} onChange={e => set('cleanup_enabled', e.target.checked)} />
          <span className="settings-label" style={{ margin: 0 }}>Automatically remove unplayed tracks</span>
        </label>
        <Field label="Remove after (days without a play)" type="number"
          hint="e.g. 30. A track never played is aged from when it was added. Set 0 to disable."
          value={s.cleanup_after_days ?? 0} onChange={v => set('cleanup_after_days', v)} />
        <div className="settings-actions">
          <button className="btn-ghost" disabled={cleaning || !s.cleanup_enabled || !(parseInt(s.cleanup_after_days, 10) > 0)}
            onClick={runCleanup}>{cleaning ? 'Cleaning…' : 'Run cleanup now'}</button>
          {cleanMsg && <span className={`settings-msg ${cleanMsg.err ? 'err' : 'ok'}`}>{cleanMsg.text}</span>}
        </div>
      </section>

      <div className="settings-save">
        <button className="btn-primary lg" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save all settings'}</button>
        {msg && <span className={`settings-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
