import { describe, expect, it } from 'vitest';
import { buildGenerationPlan } from './generation';
import { makeProgress, makeCasting } from '@/test/msw/fixtures';
import type { AudioScript, BookProgress } from './api/types';

function progressWith(overrides: Record<string, Partial<BookProgress['stages'][number]>>) {
  const base = makeProgress();
  return {
    ...base,
    stages: base.stages.map((stage) => ({ ...stage, ...(overrides[stage.stage] ?? {}) })),
  };
}

const validatedScript = { state: 'VALIDATED', chunk_count: 8420 } as AudioScript;

describe('buildGenerationPlan', () => {
  it('blocks analysis until the book has actually been read', () => {
    const plan = buildGenerationPlan({
      progress: progressWith({
        ingestion: { status: 'RUNNING' },
        analysis: { status: 'NOT_STARTED' },
      }),
      casting: null,
      audioScript: null,
    });
    const analysis = plan.entries.find((entry) => entry.stage === 'analysis')!;
    expect(analysis.blockedReason).toMatch(/read/i);
  });

  it('blocks TTS on incomplete casting — the same precondition the API enforces', () => {
    // POST .../tts answers 409 CASTING_INCOMPLETE. Refusing here means the user
    // sees the cause instead of the refusal.
    const plan = buildGenerationPlan({
      progress: progressWith({ tts: { status: 'NOT_STARTED' } }),
      casting: makeCasting({ ready_for_generation: false }),
      audioScript: validatedScript,
    });
    const tts = plan.entries.find((entry) => entry.stage === 'tts')!;
    expect(tts.blockedReason).toMatch(/no approved voice/i);
  });

  it('blocks TTS on an unvalidated script', () => {
    const plan = buildGenerationPlan({
      progress: progressWith({ tts: { status: 'NOT_STARTED' } }),
      casting: makeCasting({ ready_for_generation: true, blocking: [] }),
      audioScript: { state: 'DRAFT', chunk_count: 10 } as AudioScript,
    });
    const tts = plan.entries.find((entry) => entry.stage === 'tts')!;
    expect(tts.blockedReason).toMatch(/not validated/i);
  });

  it('allows TTS once the script is validated and casting is complete', () => {
    const plan = buildGenerationPlan({
      progress: progressWith({ tts: { status: 'NOT_STARTED' } }),
      casting: makeCasting({ ready_for_generation: true, blocking: [] }),
      audioScript: validatedScript,
    });
    expect(plan.entries.find((entry) => entry.stage === 'tts')!.blockedReason).toBeNull();
  });

  it('blocks assembly when nothing has been rendered', () => {
    const plan = buildGenerationPlan({
      progress: progressWith({ tts: { status: 'NOT_STARTED', completed_units: 0 } }),
      casting: makeCasting({ ready_for_generation: true, blocking: [] }),
      audioScript: validatedScript,
    });
    expect(plan.entries.find((entry) => entry.stage === 'assembly')!.blockedReason).toMatch(
      /no generated audio/i,
    );
  });

  it('picks the first incomplete, not-running stage as the next step', () => {
    const plan = buildGenerationPlan({
      progress: makeProgress(),
      casting: makeCasting({ ready_for_generation: true, blocking: [] }),
      audioScript: validatedScript,
    });
    // ingestion/analysis/director are COMPLETED and tts is RUNNING, so assembly
    // is what is left to do.
    expect(plan.next?.stage).toBe('assembly');
  });

  it('reports a finished pipeline when every stage is complete', () => {
    const plan = buildGenerationPlan({
      progress: progressWith({
        tts: { status: 'COMPLETED', progress: 1 },
        assembly: { status: 'COMPLETED', progress: 1, completed_units: 3, total_units: 3 },
      }),
      casting: makeCasting({ ready_for_generation: true, blocking: [] }),
      audioScript: validatedScript,
    });
    expect(plan.finished).toBe(true);
    expect(plan.next).toBeNull();
  });

  it('marks a completed stage as one that would redo work', () => {
    const plan = buildGenerationPlan({
      progress: makeProgress(),
      casting: null,
      audioScript: validatedScript,
    });
    expect(plan.entries.find((entry) => entry.stage === 'ingestion')!.wouldRedoWork).toBe(true);
  });
});
