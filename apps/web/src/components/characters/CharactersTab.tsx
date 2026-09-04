'use client';

import { useMemo, useState } from 'react';
import { useProject } from '@/components/project/ProjectContext';
import { useCastingState, useCharacters } from '@/lib/query/hooks';
import { buildCastingIndex, type CastingStatus } from '@/lib/casting';
import { CharacterRow } from './CharacterRow';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { EmptyState, ErrorState, Notice } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { TextInput, Select } from '@/components/ui/Field';
import { useVirtualRows } from '@/lib/hooks/useVirtualRows';
import { formatCount } from '@/lib/format';
import type { Character } from '@/lib/api/types';

const ROW_HEIGHT = 64;

/**
 * The character registry (Phase 9 rules 24, 26, 27, 90, 140).
 *
 * **Search and sort operate on the loaded cast, and the UI says so.**
 * `GET .../characters` accepts `status`, `speaking`, and `include_sentinels`,
 * and orders by `importance_rank` — there is no name search and no `sort`
 * parameter (GAP-4). Doing this client-side is honest *here*, unlike on the
 * tenant-wide project list, because the set is complete and bounded: one book's
 * cast, every page fetched, tens to low hundreds of rows. The list is windowed
 * so 200+ characters stay responsive.
 */

type SortKey = 'importance' | 'name' | 'lines' | 'casting' | 'confidence';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'importance', label: 'Importance (server order)' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'lines', label: 'Spoken lines' },
  { value: 'casting', label: 'Needs a voice first' },
  { value: 'confidence', label: 'Detection confidence' },
];

type Scope = 'speaking' | 'all' | 'needs-voice';

export function CharactersTab() {
  const { bookId, book } = useProject();
  const characters = useCharacters(bookId, { enabled: Boolean(book?.current_book_version_id) });
  const casting = useCastingState(bookId, { enabled: Boolean(book?.current_book_version_id) });

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('importance');
  const [scope, setScope] = useState<Scope>('speaking');

  const statusFor = useMemo(() => buildCastingIndex(casting.data), [casting.data]);

  const rows = useMemo(() => {
    const all = characters.data ?? [];
    const needle = search.trim().toLowerCase();

    const filtered = all.filter((character) => {
      if (character.is_sentinel && scope !== 'all') return false;
      if (scope === 'speaking' && !character.speaking) return false;
      if (scope === 'needs-voice') {
        const status = statusFor(character).status;
        if (status !== 'NO_VOICE' && status !== 'VOICE_NOT_APPROVED') return false;
      }
      if (needle && !character.display_name.toLowerCase().includes(needle)) return false;
      return true;
    });

    const order: Record<CastingStatus, number> = {
      NO_VOICE: 0,
      VOICE_NOT_APPROVED: 1,
      UNKNOWN: 2,
      READY: 3,
      NOT_REQUIRED: 4,
    };

    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.display_name.localeCompare(b.display_name);
        case 'lines':
          return b.line_count - a.line_count;
        case 'confidence':
          return (b.detection.confidence ?? -1) - (a.detection.confidence ?? -1);
        case 'casting':
          return order[statusFor(a).status] - order[statusFor(b).status];
        default:
          return (
            (a.importance_rank ?? Number.MAX_SAFE_INTEGER) -
            (b.importance_rank ?? Number.MAX_SAFE_INTEGER)
          );
      }
    });
  }, [characters.data, search, scope, sort, statusFor]);

  const virtual = useVirtualRows<Character>({ items: rows, rowHeight: ROW_HEIGHT });

  if (!book?.current_book_version_id) {
    return (
      <Panel>
        <EmptyState
          title="No characters yet"
          description="Characters are discovered while the studio reads and analyses the book. They appear here once the analysis stage has run."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      {casting.data && !casting.data.ready_for_generation ? (
        <Notice
          tone="warning"
          title={`${formatCount(casting.data.blocking.length)} character${casting.data.blocking.length === 1 ? '' : 's'} cannot be voiced yet`}
        >
          Audio generation is refused until every speaking character resolves to an approved voice.
          Filter to “Needs a voice” below to see which.
        </Notice>
      ) : null}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Cast"
          description={
            characters.data
              ? `${formatCount(rows.length)} of ${formatCount(characters.data.length)} shown. Filtering and sorting apply to the loaded cast.`
              : undefined
          }
        />

        <div className="flex flex-wrap gap-3 border-b border-[var(--border-subtle)] px-5 py-3">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="character-search" className="sr-only">
              Filter characters by name
            </label>
            <TextInput
              id="character-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by name…"
            />
          </div>
          <div>
            <label htmlFor="character-scope" className="sr-only">
              Which characters to show
            </label>
            <Select
              id="character-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as Scope)}
            >
              <option value="speaking">Speaking characters</option>
              <option value="needs-voice">Needs a voice</option>
              <option value="all">Everyone, including narrator roles</option>
            </Select>
          </div>
          <div>
            <label htmlFor="character-sort" className="sr-only">
              Sort characters
            </label>
            <Select
              id="character-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              {SORTS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {characters.isPending ? (
          <PanelBody>
            <SkeletonText lines={8} />
          </PanelBody>
        ) : characters.isError ? (
          <PanelBody>
            <ErrorState error={characters.error} onRetry={() => void characters.refetch()} compact />
          </PanelBody>
        ) : rows.length === 0 ? (
          <EmptyState
            title={search ? 'No characters match that filter' : 'No characters in this view'}
            description={
              search
                ? 'Try a shorter search, or widen the “which characters” filter.'
                : 'Switch to “Everyone” to include narrator and non-speaking roles.'
            }
          />
        ) : (
          <div
            ref={virtual.containerRef}
            onScroll={virtual.onScroll}
            className="max-h-[38rem] overflow-y-auto"
            tabIndex={0}
            role="region"
            aria-label={`${formatCount(rows.length)} characters`}
          >
            <div
              style={virtual.totalHeight ? { height: virtual.totalHeight, position: 'relative' } : undefined}
            >
              <ul
                style={
                  virtual.windowed
                    ? {
                        transform: `translateY(${virtual.offsetY}px)`,
                        position: 'absolute',
                        inset: '0 0 auto 0',
                      }
                    : undefined
                }
                className="divide-y divide-[var(--border-subtle)]"
              >
                {virtual.visibleItems.map((character) => (
                  <CharacterRow
                    key={character.id}
                    bookId={bookId}
                    character={character}
                    casting={statusFor(character)}
                    height={ROW_HEIGHT}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
