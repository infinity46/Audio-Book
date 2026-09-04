import { cn } from '@/lib/cn';

/**
 * Project cover art (Phase 9 rule 69).
 *
 * **There is no cover to display.** The API's only cover endpoint is
 * `PUT /books/{id}/audiobooks/{id}/cover` — a write. `api-specification.md`
 * §15.12 lists no `GET`, and the audiobook resource reports only
 * `cover: { present, width, height, content_hash }`, never a URL or an
 * `access-urls` sub-resource. So there is no backend-provided URL to render,
 * and this component does not pretend otherwise (rules 161, 174): it draws a
 * deterministic monogram derived from the project's own id, which is plainly a
 * placeholder and is never presented as the book's artwork.
 *
 * Recorded as GAP-3 in `docs/application/frontend-api-gaps.md`. When a read
 * path exists, this component gains an `<img>` branch and nothing else changes.
 */

/** Stable hue from the id, so a project keeps the same colour everywhere. */
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return hash;
}

function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${(words[0] ?? '')[0] ?? ''}${(words[1] ?? '')[0] ?? ''}`.toUpperCase();
}

export function CoverArt({
  bookId,
  title,
  size = 'md',
  className,
}: {
  bookId: string;
  title: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const hue = hueFor(bookId);
  const dimensions =
    size === 'lg' ? 'h-28 w-20 text-xl' : size === 'sm' ? 'h-10 w-7 text-[10px]' : 'h-16 w-11 text-sm';

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[0.35rem] border border-black/10 font-semibold tracking-wide select-none',
        dimensions,
        className,
      )}
      style={{
        background: `linear-gradient(150deg, oklch(62% 0.09 ${hue}) 0%, oklch(44% 0.11 ${(hue + 40) % 360}) 100%)`,
        color: 'oklch(98% 0 0)',
      }}
      // Decorative: the title is always rendered next to it as real text, so
      // announcing a monogram would just repeat it.
      aria-hidden="true"
    >
      {monogram(title)}
    </div>
  );
}
