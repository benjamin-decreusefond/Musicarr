import { createContext, useContext, useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import { Icon } from './ui.jsx';
import { useT } from './i18n.jsx';

const navTo = (view) => () => window.dispatchEvent(new CustomEvent('musicarr:navigate', { detail: { view } }));

// Custom right-click context menu. A single menu instance lives at the app root;
// any component calls openMenu(event, items) from its onContextMenu handler to
// replace the browser's native menu with Musicarr actions.
//
// An item is either { separator: true } or:
//   { label, icon?, onClick?, danger?, disabled?, submenu?, loadSubmenu? }
// where submenu is a static array and loadSubmenu is async () => items (lazy).

const MenuCtx = createContext(null);
export const useContextMenu = () => useContext(MenuCtx);

export function ContextMenuProvider({ children }) {
  const [menu, setMenu] = useState(null); // { x, y, items }
  const t = useT();

  const openMenu = useCallback((e, items) => {
    if (!items || !items.length) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const close = useCallback(() => setMenu(null), []);

  // Fallback app menu for right-clicks anywhere that a specific element (track,
  // user, …) didn't already handle — so the whole interface has a custom menu
  // instead of the browser default. Native menu is preserved over text inputs
  // and selections so copy/paste still works.
  useEffect(() => {
    const onCtx = (e) => {
      if (e.defaultPrevented) return; // a specific handler already ran
      const el = e.target;
      if (el.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]')) return;
      if (String(window.getSelection?.() || '').trim()) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, items: [
        { label: t('ctx.menuBack'), icon: 'prev', onClick: () => window.history.back() },
        { separator: true },
        { label: t('nav.home'), icon: 'home', onClick: navTo('home') },
        { label: t('nav.search'), icon: 'search', onClick: navTo('search') },
        { label: t('nav.madeForYou'), icon: 'sparkles', onClick: navTo('mixes') },
        { label: t('nav.library'), icon: 'library', onClick: navTo('library') },
      ] });
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, [t]);

  return (
    <MenuCtx.Provider value={{ openMenu }}>
      {children}
      {menu && <Menu {...menu} onClose={close} />}
    </MenuCtx.Provider>
  );
}

function Menu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, visibility: 'hidden' });

  // Clamp to the viewport once measured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = x, top = y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left, top, visibility: 'visible' });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  return (
    <div className="ctxmenu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => <MenuItem key={i} item={it} onClose={onClose} />)}
    </div>
  );
}

function MenuItem({ item, onClose }) {
  const [subOpen, setSubOpen] = useState(false);
  const [subItems, setSubItems] = useState(item.submenu || null);
  const [loading, setLoading] = useState(false);
  const liRef = useRef(null);
  const hasSub = !!(item.submenu || item.loadSubmenu);

  if (item.separator) return <div className="ctxmenu-sep" />;

  const openSub = async () => {
    setSubOpen(true);
    if (item.loadSubmenu && subItems == null && !loading) {
      setLoading(true);
      try { setSubItems(await item.loadSubmenu()); } catch { setSubItems([]); }
      setLoading(false);
    }
  };

  const onClick = () => {
    if (item.disabled || hasSub) return;
    onClose();
    item.onClick?.();
  };

  return (
    <div className={`ctxmenu-item-wrap ${hasSub ? 'has-sub' : ''}`}
      ref={liRef}
      onMouseEnter={() => hasSub && openSub()}
      onMouseLeave={() => hasSub && setSubOpen(false)}>
      <button className={`ctxmenu-item ${item.danger ? 'danger' : ''}`} disabled={item.disabled} onClick={onClick}>
        {item.icon && <Icon name={item.icon} size={16} />}
        <span className="ctxmenu-label">{item.label}</span>
        {hasSub && <span className="ctxmenu-arrow">›</span>}
      </button>
      {hasSub && subOpen && (
        <div className="ctxmenu ctxmenu-sub">
          {loading && <div className="ctxmenu-empty">…</div>}
          {!loading && subItems && subItems.length === 0 && <div className="ctxmenu-empty">{item.emptyLabel || '—'}</div>}
          {!loading && subItems && subItems.map((s, i) => <MenuItem key={i} item={s} onClose={onClose} />)}
        </div>
      )}
    </div>
  );
}
