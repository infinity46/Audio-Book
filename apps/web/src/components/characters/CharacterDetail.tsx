'use client';

import Link from 'next/link';
import { useProject } from '@/components/project/ProjectContext';
import {
  useCastingState,
  useCharacter,
  useCharacterAliases,
  useCharacterVoice,
  useVoiceProfiles,
} from '@/lib/query/hooks';
import { buildCastingIndex } from '@/lib/casting';
import { VoiceAssignmentPanel } from '@/components/voices/VoiceAssignmentPanel';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ErrorPanel } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { formatCount, formatRelativeTime } from '@/lib/format';
import { humanizeEnum } from '@/lib/status';
import { useMemo } from 'react';

/**
 * Character detail (Phase 9 rule 25).
 *
 * Shows the name, aliases, assigned voice **with its version**, and the
 * metadata the API exposes. It shows no model reasoning, because none is
 * exposed and none should be. `detection.source` and `confidence` are facts the
 * API publishes about how the character was found; they are labelled as such.
 */
export function CharacterDetail({ characterId }: { characterId: string }) {
  const { bookId } = useProject();
  const character = useCharacter(bookId, characterId);
  const aliases = useCharacterAliases(bookId, characterId);
  const casting = useCastingState(bookId);
  const assignment = useCharacterVoice(bookId, characterId);
  const voices = useVoiceProfiles();

  const statusFor = useMemo(() => buildCastingIndex(casting.data), [casting.data]);

  if (character.isError) {
    return (
      <ErrorPanel
        error={character.error}
        onRetry={() => void character.refetch()}
        secondaryAction={
          <Link
            href={`/projects/${bookId}/characters`}
            className="text-[13px] font-semibold text-[var(--accent-text)] hover:underline"
          >
            Back to the cast
          </Link>
        }
      />
    );
  }

  const data = character.data;
  const castingStatus = data ? statusFor(data) : null;

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb">
        <Link
          href={`/projects/${bookId}/characters`}
          className="text-[13px] text-[var(--text-muted)] hover:underline"
        >
          ← Cast
        </Link>
      </nav>

      <Panel className="overflow-hidden">
        <PanelHeader
          as="h2"
          title={data?.display_name ?? 'Character'}
          description={
            data
              ? data.is_sentinel
                ? `${humanizeEnum(data.sentinel_kind ?? 'Narrator role')} — a structural role, not a person in the book.`
                : data.speaking
                  ? `${formatCount(data.line_count)} spoken line${data.line_count === 1 ? '' : 's'}`
                  : 'Mentioned in the text, but never speaks.'
              : undefined
          }
          actions={
            castingStatus ? (
              <StatusBadge
                label={castingStatus.label}
                tone={castingStatus.tone}
                description={castingStatus.description}
                size="sm"
              />
            ) : null
          }
        />
        <PanelBody>
          {character.isPending ? (
            <SkeletonText lines={4} />
          ) : data ? (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Row label="Status" value={humanizeEnum(data.status)} />
              <Row
                label="Importance rank"
                value={data.importance_rank !== null ? `#${data.importance_rank}` : 'Not ranked'}
              />
              <Row
                label="Detection confidence"
                value={
                  data.detection.confidence !== null
                    ? `${Math.round(data.detection.confidence * 100)}%`
                    : 'Not recorded'
                }
              />
              <Row label="Detected by" value={humanizeEnum(data.detection.source)} />
              <Row
                label="First appears"
                value={data.first_appearance.chapter_id ? 'Recorded' : 'Not recorded'}
              />
              <Row label="Last updated" value={formatRelativeTime(data.updated_at)} />
            </dl>
          ) : null}
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          as="h2"
          title="Aliases"
          description="Other names the book uses for this character. Used to attribute dialogue correctly."
        />
        {aliases.isPending ? (
          <PanelBody>
            <SkeletonText lines={2} />
          </PanelBody>
        ) : (aliases.data?.data.length ?? 0) === 0 ? (
          <PanelBody>
            <p className="text-[13px] text-[var(--text-muted)]">
              No aliases were recorded for this character.
            </p>
          </PanelBody>
        ) : (
          <ul className="flex flex-wrap gap-2 px-5 py-4">
            {aliases.data?.data.map((alias) => (
              <li
                key={alias.id}
                className="rounded-[var(--radius-pill)] border border-[var(--border-subtle)] bg-[var(--panel-sunken)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)]"
                title={`${humanizeEnum(alias.alias_type)} · ${humanizeEnum(alias.source)}`}
              >
                {alias.surface_form}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {data?.speaking ? (
        <VoiceAssignmentPanel
          bookId={bookId}
          character={data}
          assignment={assignment.data ?? null}
          assignmentLoading={assignment.isPending}
          voiceProfiles={voices.data ?? []}
          voicesLoading={voices.isPending}
        />
      ) : (
        <Panel>
          <PanelHeader as="h2" title="Voice" />
          <PanelBody>
            <p className="text-[13px] text-[var(--text-muted)]">
              This character has no spoken lines, so no voice is needed. Narration of passages that
              mention them is performed by the narrator voice.
            </p>
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-medium text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}
