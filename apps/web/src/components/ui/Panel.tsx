import { cn } from '@/lib/cn';

/** The studio's surface primitive: a bordered, elevated region of the console. */
export function Panel({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        'rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--panel)]',
        'shadow-[var(--shadow-panel)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  as: Heading = 'h2',
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <Heading className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </Heading>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}
