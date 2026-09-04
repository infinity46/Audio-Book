'use client';

import Link from 'next/link';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatCount } from '@/lib/format';
import type { CastingStatusDisplay } from '@/lib/casting';
import type { Character } from '@/lib/api/types';

/**
 * One character in the registry (rule 24).
 *
 * `line_count` is the API's own occurrence measure. Detection confidence is
 * shown as a percentage **with its provenance implied by the column heading** —
 * it is the model's own confidence in having identified the character, and the
 * UI makes no claim beyond that (rule 174). No chain-of-thought or model
 * rationale is displayed; none is exposed by the API and none would be shown if
 * it were (rule 25).
 */
export function CharacterRow({
  bookId,
  character,
  casting,
  height,
}: {
  bookId: string;
  character: Character;
  casting: CastingStatusDisplay;
  height: number;
}) {
  const confidence = character.detection.confidence;

  return (
    <li style={{ height }}>
      <Link
        href={`/projects/${bookId}/characters/${character.id}`}
        className="flex h-full items-center gap-4 px-5 transition-colors hover:bg-[var(--panel-raised)]"
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--panel-sunken)] text-[11px] font-semibold text-[var(--text-secondary)]"
          aria-hidden="true"
        >
          {character.display_name.slice(0, 2).toUpperCase()}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
            {character.display_name}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-[var(--text-muted)]">
            {character.is_sentinel
              ? `${character.sentinel_kind ?? 'Narrator role'}`
              : character.speaking
                ? `${formatCount(character.line_count)} spoken line${character.line_count === 1 ? '' : 's'}`
                : 'Mentioned, does not speak'}
          </span>
        </span>

        {confidence !== null ? (
          <span
            className="hidden w-24 shrink-0 text-right font-mono text-[12px] tabular-nums text-[var(--text-muted)] md:block"
            title="How confident the analysis was that this is a distinct character."
          >
            {Math.round(confidence * 100)}%
          </span>
        ) : (
          <span className="hidden w-24 shrink-0 text-right text-[12px] text-[var(--text-muted)] md:block">
            —
          </span>
        )}

        <span className="shrink-0">
          <StatusBadge
            label={casting.label}
            tone={casting.tone}
            description={casting.description}
            size="sm"
          />
        </span>
      </Link>
    </li>
  );
}
