import { cn } from '@/lib/cn';

/**
 * Data table (Phase 9 rules 101, 105).
 *
 * Two properties are load-bearing:
 *  - the table scrolls **inside its own container**, so a wide row never makes
 *    the page scroll horizontally on a narrow screen;
 *  - it stays a real `<table>` with a real `<caption>` and scoped headers, so
 *    row/column association survives for a screen reader. Card-ifying tables on
 *    mobile is done per-view where it helps, not by breaking the semantics here.
 */

export function TableContainer({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  /** Accessible name; also makes the scroll region focusable for keyboards. */
  label: string;
}) {
  return (
    <div
      className={cn('w-full overflow-x-auto', className)}
      // A scrollable region must be reachable by keyboard, or its overflow is
      // unreachable without a mouse (WCAG 2.2 — 2.1.1).
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <table className={cn('w-full min-w-[36rem] border-collapse text-sm', className)}>{children}</table>;
}

export function Th({
  children,
  className,
  scope = 'col',
  align = 'left',
  sortDirection,
}: {
  children: React.ReactNode;
  className?: string;
  scope?: 'col' | 'row';
  align?: 'left' | 'right' | 'center';
  /** Announces the current sort to assistive tech when the column is sorted. */
  sortDirection?: 'asc' | 'desc' | null;
}) {
  return (
    <th
      scope={scope}
      aria-sort={
        sortDirection === undefined ? undefined : sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'none'
      }
      className={cn(
        'border-b border-[var(--border-subtle)] px-4 py-2.5 text-[12px] font-semibold tracking-wide',
        'text-[var(--text-muted)] uppercase',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = 'left',
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <td
      {...rest}
      className={cn(
        'border-b border-[var(--border-subtle)] px-4 py-3 align-middle text-[var(--text-secondary)]',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr {...rest} className={cn('transition-colors hover:bg-[var(--panel-raised)]', className)}>
      {children}
    </tr>
  );
}
