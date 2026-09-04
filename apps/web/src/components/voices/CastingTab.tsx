'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import {
  useCastingState,
  useCharacters,
  useCharacterVoice,
  useVoiceProfiles,
} from '@/lib/query/hooks';
import { buildCastingIndex } from '@/lib/casting';
import { VoiceAssignmentPanel } from './VoiceAssignmentPanel';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ScrollRegion } from '@/components/ui/ScrollRegion';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { TextInput } from '@/components/ui/Field';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';

/**
 * The casting workspace (Phase 9 rules 30–33).
 *
 * A master–detail layout rather than a modal per character (rule 106): casting
 * a book is a session's work, not a one-off dialog, and the readiness figure at
 * the top is the thing the user is driving toward.
 *
 * Readiness comes from `GET .../casting`, which is also the precondition
 * `POST .../tts` enforces — so what this screen calls "ready" is exactly what
 * the generation command will accept, not a client-side approximation.
 */
export function CastingTab() {
  const { bookId, book } = useProject();
  const characters = useCharacters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const casting = useCastingState(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const voices = useVoiceProfiles();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const statusFor = useMemo(() => buildCastingIndex(casting.data), [casting.data]);

  const speaking = useMemo(() => {
    const rows = (characters.data ?? []).filter((c) => c.speaking);
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((c) => c.display_name.toLowerCase().includes(needle))
      : rows;
    // Unvoiced characters first — this screen exists to close that gap.
    return [...filtered].sort((a, b) => {
      const rank = (status: string) => (status === 'READY' ? 1 : 0);
      const diff = rank(statusFor(a).status) - rank(statusFor(b).status);
      return diff !== 0 ? diff : b.line_count - a.line_count;
    });
  }, [characters.data, search, statusFor]);

  const selected = speaking.find((c) => c.id === selectedId) ?? speaking[0] ?? null;
  const assignment = useCharacterVoice(bookId, selected?.id ?? '', Boolean(selected));

  if (!book?.current_book_version_id) {
    return (
      <Panel>
        <EmptyState
          title="Casting starts after the book is analysed"
          description="Characters have to be discovered before they can be given voices. Upload the book and let the analysis stage finish."
        />
      </Panel>
    );
  }

  const assignedCount = casting.data?.approved_count ?? 0;
  const totalSpeaking = casting.data?.speaking_character_count ?? 0;

  return (
    <div className="space-y-6">
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Casting readiness"
          description="Every speaking character must resolve to an approved voice version before audio generation is accepted."
          actions={
            casting.data ? (
              <StatusBadge
                label={casting.data.ready_for_generation ? 'Ready to generate' : 'Incomplete'}
                tone={casting.data.ready_for_generation ? 'success' : 'warning'}
                size="sm"
              />
            ) : null
          }
        />
        <PanelBody>
          {casting.isPending ? (
            <SkeletonText lines={2} />
          ) : casting.isError ? (
            <ErrorState error={casting.error} onRetry={() => void casting.refetch()} compact />
          ) : casting.data ? (
            <>
              <ProgressBar
                value={totalSpeaking > 0 ? assignedCount / totalSpeaking : null}
                label="Characters with an approved voice"
                tone={casting.data.ready_for_generation ? 'success' : 'progress'}
                completedUnits={assignedCount}
                totalUnits={totalSpeaking}
                unitNoun={{ one: 'character', many: 'characters' }}
              />
              {(voices.data?.length ?? 0) === 0 && !voices.isPending ? (
                <Notice className="mt-4" tone="warning" title="No voices exist yet">
                  This workspace has no voice profiles, so no character can be cast.{' '}
                  <Link href="/voices" className="font-semibold underline">
                    Open the voice library
                  </Link>{' '}
                  to create one.
                </Notice>
              ) : null}
            </>
          ) : null}
        </PanelBody>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Panel className="overflow-hidden lg:sticky lg:top-20 lg:self-start">
          <PanelHeader
            as="h3"
            title="Speaking characters"
            description={`${formatCount(speaking.length)} shown`}
          />
          <div className="border-b border-[var(--border-subtle)] px-4 py-3">
            <label htmlFor="casting-search" className="sr-only">
              Filter characters
            </label>
            <TextInput
              id="casting-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by name…"
            />
          </div>
          {characters.isPending ? (
            <PanelBody>
              <SkeletonText lines={6} />
            </PanelBody>
          ) : speaking.length === 0 ? (
            <EmptyState
              title="No speaking characters"
              description="The analysis found no dialogue attributed to a named character. The narrator voice covers the whole book."
              className="py-8"
            />
          ) : (
            <ScrollRegion label="Speaking characters" className="max-h-[32rem]">
              <ul className="divide-y divide-[var(--border-subtle)]">
              {speaking.map((character) => {
                const status = statusFor(character);
                const active = selected?.id === character.id;
                return (
                  <li key={character.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(character.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                        active
                          ? 'bg-[var(--accent-soft)]'
                          : 'hover:bg-[var(--panel-raised)]',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                          {character.display_name}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">
                          {formatCount(character.line_count)} lines
                        </span>
                      </span>
                      <StatusBadge
                        label={status.status === 'READY' ? 'Cast' : 'Needs voice'}
                        tone={status.tone}
                        description={status.description}
                        size="sm"
                      />
                    </button>
                  </li>
                );
                })}
              </ul>
            </ScrollRegion>
          )}
        </Panel>

        <div className="min-w-0">
          {selected ? (
            <VoiceAssignmentPanel
              key={selected.id}
              bookId={bookId}
              character={selected}
              assignment={assignment.data ?? null}
              assignmentLoading={assignment.isPending}
              voiceProfiles={voices.data ?? []}
              voicesLoading={voices.isPending}
            />
          ) : (
            <Panel>
              <EmptyState
                title="Select a character"
                description="Choose a speaking character to see and change the voice bound to them."
              />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
