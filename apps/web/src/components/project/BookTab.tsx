'use client';

import { useState } from 'react';
import { useProject } from './ProjectContext';
import { SourceFilePanel } from './SourceFilePanel';
import { BookMetadataForm } from './BookMetadataForm';
import { ChapterStructureList } from './ChapterStructureList';
import { useChapters } from '@/lib/query/hooks';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { SkeletonText } from '@/components/ui/Skeleton';
import { formatCount } from '@/lib/format';

/**
 * The Book tab (Phase 9 rules 20, 21, 70).
 *
 * Shows the canonical structure the ingestion stage produced and the metadata
 * the API allows a client to change. Deliberately **not** shown: the Story
 * Bible's internal fact tables. `GET .../story-bible` exists, but rule 20 says
 * not to expose internal narrative state unless intended, and nothing in the
 * product brief calls for it — so this tab shows structure, not model output.
 */
export function BookTab() {
  const { bookId, book } = useProject();
  const [editing, setEditing] = useState(false);
  const chapters = useChapters(bookId, { enabled: Boolean(book?.current_book_version_id) });

  const hasStructure = Boolean(book?.current_book_version_id);

  return (
    <div className="space-y-6">
      <SourceFilePanel />

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Details"
          description="Metadata you control. Pipeline state is set by the studio as work completes and cannot be edited."
          actions={
            !editing ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null
          }
        />
        <PanelBody>
          {book ? (
            <BookMetadataForm editing={editing} onDone={() => setEditing(false)} />
          ) : (
            <SkeletonText lines={4} />
          )}
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Structure"
          description={
            chapters.data
              ? `${formatCount(chapters.data.length)} chapter${chapters.data.length === 1 ? '' : 's'} found in the source.`
              : undefined
          }
        />
        {!hasStructure ? (
          <EmptyState
            title="No structure yet"
            description="Chapters appear here once the studio has finished reading the source file."
          />
        ) : chapters.isPending ? (
          <PanelBody>
            <SkeletonText lines={6} />
          </PanelBody>
        ) : chapters.isError ? (
          <PanelBody>
            <ErrorState error={chapters.error} onRetry={() => void chapters.refetch()} compact />
          </PanelBody>
        ) : chapters.data && chapters.data.length > 0 ? (
          <ChapterStructureList chapters={chapters.data} bookId={bookId} />
        ) : (
          <EmptyState
            title="No chapters were identified"
            description="The source was read, but no chapter structure was found in it. The activity log shows what the parser reported."
          />
        )}
      </Panel>
    </div>
  );
}
