'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fixed-height windowing (Phase 9 rules 22, 89, 90, 139).
 *
 * A 100-chapter book and a 200-character cast both have to stay responsive, and
 * the honest fix is to stop putting thousands of DOM nodes on the page. This is
 * a ~50-line window over a fixed row height rather than a virtualization
 * library: the two lists that need it are uniform-height rows, so the extra
 * 15 kB a general-purpose virtualizer costs (rule 151) buys nothing here.
 *
 * Degrades safely: before measurement, and in a jsdom test environment where
 * `clientHeight` is 0, it renders an initial window rather than nothing.
 */
export function useVirtualRows<T>({
  items,
  rowHeight,
  overscan = 8,
  enabled = true,
}: {
  items: T[];
  rowHeight: number;
  overscan?: number;
  enabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const measure = useCallback(() => {
    const node = containerRef.current;
    if (node) setViewportHeight(node.clientHeight);
  }, []);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  // Windowing is skipped for short lists: the machinery costs more than it
  // saves below a few dozen rows, and a plain list keeps native find-in-page.
  const shouldWindow = enabled && items.length > 60;
  const effectiveViewport = viewportHeight || rowHeight * 20;

  const startIndex = shouldWindow
    ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    : 0;
  const visibleCount = shouldWindow
    ? Math.ceil(effectiveViewport / rowHeight) + overscan * 2
    : items.length;
  const endIndex = Math.min(items.length, startIndex + visibleCount);

  return {
    containerRef,
    onScroll,
    /** Total scrollable height, so the scrollbar reflects the whole list. */
    totalHeight: shouldWindow ? items.length * rowHeight : undefined,
    /** Offset of the first rendered row within that height. */
    offsetY: shouldWindow ? startIndex * rowHeight : 0,
    visibleItems: items.slice(startIndex, endIndex),
    startIndex,
    windowed: shouldWindow,
  };
}
