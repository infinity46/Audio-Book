import '@/test/next-navigation';
import { describe, expect, it } from 'vitest';
import axe from 'axe-core';
import { render } from '@testing-library/react';
import { renderInProject, renderWithProviders } from '@/test/render';
import { makeAudiobook, makeBook, makeCharacters, makeScriptChunk, makeVoiceProfiles, BOOK_ID, CHARACTER_ID } from '@/test/msw/fixtures';
import { ProjectCard } from '@/components/project/ProjectCard';
import { ProjectOverview } from '@/components/project/ProjectOverview';
import { ReviewItem } from '@/components/review/ReviewItem';
import { AudiobookPlayer } from '@/components/audio/AudiobookPlayer';
import { VoiceSelector } from '@/components/voices/VoiceSelector';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ErrorState } from '@/components/ui/States';
import { ApiError } from '@/lib/api/errors';

/**
 * Automated accessibility scan (Phase 9 rules 83, 147).
 *
 * An automated pass catches roughly a third of WCAG failures — the mechanical
 * third: missing names, broken label associations, invalid ARIA, unlabelled
 * regions. It is a floor, not a ceiling: keyboard traversal, focus order, and
 * screen-reader coherence are asserted in the component and Playwright suites
 * instead, because a scanner cannot see them.
 *
 * Colour-contrast rules are skipped here rather than silently passing: jsdom
 * computes no layout and resolves no CSS custom properties, so axe cannot
 * evaluate contrast in this environment. Contrast is verified in the browser,
 * in the Playwright accessibility suite.
 */
async function scan(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.html),
  }));
}

describe('accessibility', () => {
  it('project card', async () => {
    const { container } = render(<ProjectCard book={makeBook()} />);
    expect(await scan(container)).toEqual([]);
  });

  it('project overview', async () => {
    const { container } = renderInProject(<ProjectOverview />);
    expect(await scan(container)).toEqual([]);
  });

  it('review item, including the passage quotation and its controls', async () => {
    // ReviewItem is an <li> by design — the review queue is a list. Rendering
    // it without its <ul> parent is a harness artefact, not a defect.
    const { container } = renderInProject(
      <ul>
        <ReviewItem
          bookId={BOOK_ID}
          chunk={makeScriptChunk()}
          chapterTitle="Chapter 1"
          characterNames={new Map([[CHARACTER_ID, 'Marlow']])}
          selected={false}
          onToggleSelected={() => {}}
        />
      </ul>,
    );
    expect(await scan(container)).toEqual([]);
  });

  it('audiobook player transport and chapter list', async () => {
    const { container } = renderWithProviders(
      <AudiobookPlayer bookId={BOOK_ID} audiobook={makeAudiobook()} />,
    );
    expect(await scan(container)).toEqual([]);
  });

  it('voice selector', async () => {
    const { container } = renderWithProviders(
      <VoiceSelector
        profiles={makeVoiceProfiles()}
        loading={false}
        bookLanguage="en-GB"
        onSelect={() => {}}
        assigning={false}
      />,
    );
    expect(await scan(container)).toEqual([]);
  });

  it('confirmation dialog', async () => {
    const { container } = render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Cancel this work?"
        consequence="Finished work is kept."
        confirmLabel="Request cancellation"
        onConfirm={() => {}}
      />,
    );
    expect(await scan(container)).toEqual([]);
  });

  it('indeterminate progress bar', async () => {
    const { container } = render(<ProgressBar value={null} label="Generating audio" />);
    expect(await scan(container)).toEqual([]);
  });

  it('error state', async () => {
    const { container } = render(
      <ErrorState
        error={new ApiError({ status: 409, code: 'CASTING_INCOMPLETE', message: '' })}
        onRetry={() => {}}
      />,
    );
    expect(await scan(container)).toEqual([]);
  });

  it('character list rows', async () => {
    const { CharacterRow } = await import('@/components/characters/CharacterRow');
    const { container } = render(
      <ul>
        <CharacterRow
          bookId={BOOK_ID}
          character={makeCharacters()[0]!}
          casting={{
            status: 'READY',
            label: 'Voice ready',
            tone: 'success',
            description: 'An approved voice version is bound to this character.',
          }}
          height={64}
        />
      </ul>,
    );
    expect(await scan(container)).toEqual([]);
  });
});
