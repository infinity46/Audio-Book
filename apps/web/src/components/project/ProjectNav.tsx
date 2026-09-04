'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

/**
 * Workspace navigation (Phase 9 rules 18, 87, 107).
 *
 * A vertical rail on desktop; a horizontal, scrollable strip on small screens
 * rather than a hamburger — with nine short destinations a scroller keeps every
 * section one tap away, which a collapsed menu does not.
 *
 * Counts come from server state only. A badge is rendered when the number is
 * known and omitted when it is not; it is never a zero standing in for unknown.
 */

export interface ProjectNavItem {
  segment: string;
  label: string;
  badge?: number | null;
  badgeTone?: 'warning' | 'danger' | 'neutral';
}

/**
 * `min-w-0` on the `<nav>` is required, not cosmetic: a grid item defaults to
 * `min-width: auto`, which lets its content decide the column's width. Without
 * it, the horizontally scrolling tab strip expands the whole page on a phone —
 * a horizontal page scroll, which rule 105 forbids. The Playwright responsive
 * suite asserts the page never scrolls sideways, which is what caught it.
 */
export function ProjectNav({
  bookId,
  items,
}: {
  bookId: string;
  items: ProjectNavItem[];
}) {
  const pathname = usePathname();
  const base = `/projects/${bookId}`;

  return (
    <nav aria-label="Project sections" className="min-w-0 lg:sticky lg:top-20">
      <ul
        className={cn(
          'flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0',
          '-mx-1 px-1 lg:mx-0 lg:px-0',
        )}
      >
        {items.map((item) => {
          const href = item.segment ? `${base}/${item.segment}` : base;
          const active = item.segment
            ? pathname === href || pathname.startsWith(`${href}/`)
            : pathname === base;
          return (
            <li key={item.segment || 'overview'} className="shrink-0 lg:shrink">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'bg-[var(--panel-sunken)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--panel-raised)] hover:text-[var(--text-primary)]',
                )}
              >
                <span>{item.label}</span>
                {typeof item.badge === 'number' && item.badge > 0 ? (
                  <span
                    className={cn(
                      'rounded-[var(--radius-pill)] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                      item.badgeTone === 'danger'
                        ? 'bg-[var(--tone-danger-soft)] text-[var(--tone-danger)]'
                        : item.badgeTone === 'warning'
                          ? 'bg-[var(--tone-warning-soft)] text-[var(--tone-warning)]'
                          : 'bg-[var(--panel-sunken)] text-[var(--text-muted)]',
                    )}
                  >
                    {item.badge > 999 ? '999+' : item.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
