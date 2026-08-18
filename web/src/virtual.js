// Row virtualization for long lists.
//
// A library of 20,000 tracks used to mount 20,000 rows: every one of them a
// handful of DOM nodes, an image and three event handlers. That is seconds of
// scripting before the tab responds, hundreds of megabytes of DOM, and scrolling
// that stutters on anything but a desktop.
//
// The fix is to render only what is on screen (plus a margin) and stand in for
// the rest with two spacer elements, so the scrollbar still describes the whole
// list. Nothing here depends on a library: the arithmetic is a dozen lines, and
// it stays honest about the one assumption it makes — that rows are the same
// height, which is measured from a real row rather than hardcoded.
import { useState, useEffect, useRef, useCallback } from 'react';

// Rows rendered beyond the viewport on each side. Enough that a flick of the
// wheel doesn't outrun the next render; small enough to stay cheap.
const OVERSCAN = 10;
// Below this, windowing costs more than it saves and risks looking clever for
// no reason — an album is 12 rows.
export const VIRTUALIZE_ABOVE = 150;

/** Which rows to render, and how much empty space stands in for the rest.
 *
 *  `scrollTop` is measured from the top of the list, not the page: the list
 *  usually starts some way down a scrolling panel. A negative value simply means
 *  the list hasn't been scrolled to yet. */
export function visibleRange({ scrollTop, viewportHeight, rowHeight, count, overscan = OVERSCAN }) {
  // Without a measured row height (first paint) render everything: correct, and
  // it is what produces the row we measure.
  if (!rowHeight || rowHeight <= 0 || !count) {
    return { start: 0, end: count, padTop: 0, padBottom: 0 };
  }
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + overscan * 2;
  const start = Math.min(first, Math.max(0, count - 1));
  const end = Math.min(count, start + Math.max(1, visible));
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (count - end) * rowHeight,
  };
}

/** The nearest ancestor that actually scrolls. Musicarr scrolls a panel
 *  (.main-scroll), not the document, so `window` is the wrong thing to measure
 *  — but the walk is generic so a different layout still works. */
export function scrollParentOf(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Window a list of `count` uniform rows.
 *
 * Returns the range to render, spacer heights, and two refs: `listRef` on the
 * element wrapping the rows, and `rowRef` on any one rendered row (its height is
 * what everything else is derived from).
 *
 * Pass `disabled` to opt out — drag-to-reorder needs every row mounted to have
 * something to drop onto, and the lists that support it are short anyway.
 */
export function useVirtualRows(count, { disabled = false, threshold = VIRTUALIZE_ABOVE } = {}) {
  const listRef = useRef(null);
  const rowRef = useRef(null);
  const [rowHeight, setRowHeight] = useState(0);
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 });
  const active = !disabled && count > threshold;

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const scroller = scrollParentOf(list);
    const viewportHeight = scroller ? scroller.clientHeight : window.innerHeight;
    // Distance the list top has travelled past the top of the viewport.
    const listTop = list.getBoundingClientRect().top;
    const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
    setMetrics({ scrollTop: scrollerTop - listTop, viewportHeight });
  }, []);

  // Measure a real row rather than trusting a constant: row height depends on
  // the theme, the font and whatever CSS says today.
  useEffect(() => {
    if (!active) return;
    const h = rowRef.current?.offsetHeight;
    // Converges after one extra render: the measurement re-runs once rowHeight
    // changes, finds the same value, and stops.
    if (h && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
  }, [active, rowHeight, count]);

  useEffect(() => {
    if (!active) return undefined;
    measure();
    const list = listRef.current;
    const scroller = scrollParentOf(list);
    const target = scroller || window;
    // Passive: this listener only reads, and saying so keeps scrolling smooth.
    target.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      target.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [active, measure, count]);

  if (!active) {
    return { listRef, rowRef, start: 0, end: count, padTop: 0, padBottom: 0, active: false };
  }
  return {
    listRef, rowRef, active: true,
    ...visibleRange({ ...metrics, rowHeight, count }),
  };
}
