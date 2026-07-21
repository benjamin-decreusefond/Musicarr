// The signed-in user's own profile: avatar, language, password, API tokens,
// and the people they follow.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../store.jsx';
import { Icon, Avatar } from '../ui.jsx';
import { useT, useLang, LANGS } from '../i18n.jsx';
import { UserRow } from './social.jsx';

/* ------------------------------------------------------ API access tokens */
function ApiTokens() {
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [created, setCreated] = useState(null); // freshly minted token, shown once
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => api.get('/api/auth/tokens').then(setTokens).catch(() => setTokens([])), []);
  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null); setCreated(null); setCopied(false);
    try {
      const t = await api.post('/api/auth/tokens', { name: name.trim() });
      setCreated(t);
      setName('');
      load();
    } catch (e) { setMsg({ err: true, text: e.message }); }
    setBusy(false);
  };

  const revoke = async (id) => {
    if (!window.confirm('Revoke this token? Any service using it will immediately lose access.')) return;
    try { await api.del(`/api/auth/tokens/${id}`); load(); }
    catch (e) { setMsg({ err: true, text: e.message }); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(created.token); setCopied(true); }
    catch { /* clipboard may be unavailable on http; the field is selectable */ }
  };

  return (
    <section className="page-block settings-section">
      <h2 className="row-title">API access tokens</h2>
      <p className="settings-hint">
        Personal access tokens let external tools (scripts, automations, Claude Code) call the
        Musicarr API on your behalf. Send the token as an <code>Authorization: Bearer &lt;token&gt;</code>
        header (or <code>X-Api-Key: &lt;token&gt;</code>). A token has the same permissions as your
        account and is shown only once — store it somewhere safe.
      </p>

      <form className="profile-form token-create" onSubmit={create}>
        <input className="settings-input" placeholder="Token name (e.g. Claude Code)" maxLength={80}
          value={name} onChange={e => setName(e.target.value)} />
        <button className="btn-primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create token'}</button>
      </form>
      {msg && <p className={`settings-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</p>}

      {created && (
        <div className="token-reveal">
          <div className="settings-fieldhint">Copy your new token now — you won't be able to see it again.</div>
          <div className="token-reveal-row">
            <input className="settings-input mono" readOnly value={created.token} onFocus={e => e.target.select()} />
            <button type="button" className="btn-ghost" onClick={copy}>
              <Icon name="copy" size={16} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="token-list">
        {tokens == null ? <div className="state faint">Loading…</div>
          : tokens.length === 0 ? <div className="state faint">No tokens yet.</div>
          : tokens.map(t => (
            <div key={t.id} className="token-row">
              <div className="token-meta">
                <Icon name="key" size={16} />
                <span className="token-name">{t.name}</span>
                <span className="token-prefix mono">{t.token_prefix}…</span>
              </div>
              <div className="token-sub">
                <span className="settings-fieldhint">
                  Created {fmtDate(t.created_at)} · {t.last_used_at ? `last used ${fmtDate(t.last_used_at)}` : 'never used'}
                </span>
                <button className="icon-btn" title="Revoke token" onClick={() => revoke(t.id)}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

function fmtDate(s) {
  if (!s) return '';
  // SQLite datetimes are UTC ("YYYY-MM-DD HH:MM:SS"); render in local time.
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

/* -------------------------------------------------------------- Profile */
// Downscale a chosen image file to a small centered-square JPEG data URL, so
// uploads stay tiny and the server only ever stores a uniform format.
function fileToSquareJpeg(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

// Upload / remove your own profile picture.
function AvatarSection({ me }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await fileToSquareJpeg(file);
      await api.post('/api/avatar', { image: dataUrl });
      window.dispatchEvent(new Event('musicarr:me-updated'));
    } catch (err) { alert(err.message || 'Upload failed'); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    try { await api.del('/api/avatar'); window.dispatchEvent(new Event('musicarr:me-updated')); }
    catch (err) { alert(err.message); }
    setBusy(false);
  };
  return (
    <section className="page-block settings-section">
      <h2 className="row-title">{t('settings.photo')}</h2>
      <div className="avatar-edit">
        <Avatar src={me.avatar} size={88} />
        <div className="avatar-edit-actions">
          <label className="btn-ghost">
            <Icon name="camera" size={16} /> {busy ? '…' : t('settings.changePhoto')}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} disabled={busy} />
          </label>
          {me.avatar && <button className="btn-ghost" onClick={remove} disabled={busy}>{t('settings.removePhoto')}</button>}
        </div>
      </div>
    </section>
  );
}

// Interface language selector (persisted to localStorage; applies instantly).
function LanguagePicker() {
  const { lang, setLang, t } = useLang();
  return (
    <section className="page-block settings-section">
      <h2 className="row-title">{t('settings.language')}</h2>
      <p className="settings-hint">{t('settings.languageHint')}</p>
      <div className="lang-grid">
        {LANGS.map(l => (
          <button key={l.code} className={`lang-btn ${lang === l.code ? 'on' : ''}`} onClick={() => setLang(l.code)}>
            {l.label}{lang === l.code ? <Icon name="check" size={16} /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

export function Profile({ me, nav }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [friends, setFriends] = useState(null);
  const loadFriends = useCallback(() => api.get('/api/social/following').then(setFriends).catch(() => setFriends([])), []);
  useEffect(() => { loadFriends(); const t = setInterval(loadFriends, 20000); return () => clearInterval(t); }, [loadFriends]);
  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (next.length < 8) return setMsg({ err: true, text: 'New password must be at least 8 characters' });
    if (next !== confirm) return setMsg({ err: true, text: 'New passwords do not match' });
    setBusy(true);
    try {
      await api.post('/api/auth/password', { current: cur, next });
      setMsg({ err: false, text: 'Password changed.' });
      setCur(''); setNext(''); setConfirm('');
    } catch (e) { setMsg({ err: true, text: e.message }); }
    setBusy(false);
  };
  return (
    <div className="page">
      <h1 className="page-h1">Profile</h1>
      <section className="page-block settings-section">
        <h2 className="row-title">Account</h2>
        <div className="profile-id">
          <div className="profile-avatar"><Icon name="user" size={28} /></div>
          <div>
            <div className="profile-name">{me.username}</div>
            <div className="settings-fieldhint">{me.is_admin ? 'Administrator' : 'User'}</div>
          </div>
        </div>
      </section>
      <AvatarSection me={me} />
      <LanguagePicker />
      {/* Only a native login has a password to change; a proxy/IdP-managed or
          auth-disabled account has none. */}
      {me.can_change_password && (
        <section className="page-block settings-section">
          <h2 className="row-title">Change password</h2>
          <form className="profile-form" onSubmit={submit}>
            <input className="settings-input" type="password" placeholder="Current password"
              autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} />
            <input className="settings-input" type="password" placeholder="New password"
              autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
            <input className="settings-input" type="password" placeholder="Confirm new password"
              autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            <button className="btn-primary" disabled={busy || !cur || !next}>{busy ? 'Saving…' : 'Update password'}</button>
          </form>
          {msg && <p className={`settings-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</p>}
        </section>
      )}
      <ApiTokens />
      <section className="page-block settings-section">
        <h2 className="row-title">Friends</h2>
        <p className="settings-hint">People you follow on this server. Find more from the Search tab.</p>
        {friends && friends.length
          ? <div className="user-list">{friends.map(u => <UserRow key={u.id} u={u} nav={nav} onChange={loadFriends} />)}</div>
          : <div className="state faint">You're not following anyone yet.</div>}
      </section>
    </div>
  );
}
