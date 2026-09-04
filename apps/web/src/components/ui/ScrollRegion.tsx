import { cn } from '@/lib/cn';

/**
 * A keyboard-reachable scroll container.
 *
 * Exists because of a real accessibility defect the axe suite caught: putting
 * `role="region"` and `tabIndex` directly on a `<ul>` to make its overflow
 * keyboard-reachable **overrides the list role**, which orphans every `<li>`
 * inside it and destroys the "list of N items" announcement a screen reader
 * would otherwise give. The scroll affordance and the list semantics have to
 * live on different elements.
 *
 * WCAG 2.1.1: a scrollable region must be reachable without a pointer, hence
 * `tabIndex={0}`; naming it stops that tab stop being an unlabelled mystery.
 */
export function ScrollRegion({
  label,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { label: string }) {
  return (
    <div
      {...rest}
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn('overflow-y-auto', className)}
    >
      {children}
    </div>
  );
}
