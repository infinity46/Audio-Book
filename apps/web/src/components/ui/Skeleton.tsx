import { cn } from '@/lib/cn';

/**
 * Loading placeholders (rule 80). Marked `aria-hidden` with a single polite
 * live-region announcement at the container level, so a screen reader hears
 * "Loading" once instead of a wall of empty boxes.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton h-3.5"
          style={{ width: i === lines - 1 ? '60%' : '100%' }}
        />
      ))}
    </div>
  );
}

export function LoadingRegion({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
