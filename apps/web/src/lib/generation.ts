import type { AudioScript, BookProgress, CastingState, StageName } from './api/types';

/**
 * The generation plan (Phase 9 rules 34, 37, 161, 169, 171).
 *
 * There is **no orchestrator endpoint**: `api-specification.md` §4.3 fixes one
 * command per stage, and nothing in the API runs the pipeline end to end. A
 * single "Generate audiobook" button that silently chained five commands would
 * be a UI for a capability the backend does not have. So the studio presents
 * the pipeline as the sequence it is, and the primary action is *whichever step
 * comes next* — one clear next action per state, which is what rule 169
 * actually asks for.
 *
 * Runnability is derived from the same preconditions the API enforces up front,
 * so a disabled button here corresponds to a `409` there rather than to a
 * client-side opinion. Where the client cannot know, the button is **enabled**
 * and the API's refusal is surfaced — a guess that blocks a legal action is
 * worse than a clear error.
 */

export interface StagePlanEntry {
  stage: StageName;
  /** The label on the action that starts this stage. */
  actionLabel: string;
  /** Whether this stage has already produced what the next one needs. */
  complete: boolean;
  /** Whether work for this stage is in flight right now. */
  running: boolean;
  /** `null` when runnable; otherwise the reason it is not. */
  blockedReason: string | null;
  /** True when re-running would redo work that already exists. */
  wouldRedoWork: boolean;
}

export interface GenerationPlan {
  entries: StagePlanEntry[];
  /** The step the primary action should run, or `null` when nothing is next. */
  next: StagePlanEntry | null;
  /** True when every stage has completed. */
  finished: boolean;
}

const ACTION_LABELS: Record<StageName, string> = {
  ingestion: 'Read the book',
  analysis: 'Analyse the story',
  director: 'Write the performance script',
  tts: 'Generate audio',
  assembly: 'Assemble the audiobook',
};

const ORDER: StageName[] = ['ingestion', 'analysis', 'director', 'tts', 'assembly'];

export function buildGenerationPlan(input: {
  progress: BookProgress | null;
  casting: CastingState | null | undefined;
  audioScript: AudioScript | null | undefined;
}): GenerationPlan {
  const { progress, casting, audioScript } = input;
  const byStage = new Map(progress?.stages.map((stage) => [stage.stage, stage]) ?? []);

  const entries: StagePlanEntry[] = ORDER.map((stage) => {
    const state = byStage.get(stage);
    const status = state?.status ?? 'NOT_STARTED';
    const running = status === 'QUEUED' || status === 'RUNNING' || status === 'VALIDATING';
    const complete = status === 'COMPLETED';

    return {
      stage,
      actionLabel: ACTION_LABELS[stage],
      complete,
      running,
      blockedReason: blockedReasonFor(stage, { byStage, casting, audioScript }),
      wouldRedoWork: complete || (state?.completed_units ?? 0) > 0,
    };
  });

  const next = entries.find((entry) => !entry.complete && !entry.running) ?? null;
  return { entries, next, finished: entries.every((entry) => entry.complete) };
}

function blockedReasonFor(
  stage: StageName,
  context: {
    byStage: Map<string, { status: string; completed_units: number }>;
    casting: CastingState | null | undefined;
    audioScript: AudioScript | null | undefined;
  },
): string | null {
  const { byStage, casting, audioScript } = context;
  const statusOf = (name: StageName) => byStage.get(name)?.status ?? 'NOT_STARTED';

  switch (stage) {
    case 'ingestion':
      return null;

    case 'analysis':
      // Analysis needs canonical text. The API refuses otherwise; saying so up
      // front is more useful than a 409.
      return statusOf('ingestion') === 'COMPLETED'
        ? null
        : 'The book has to be read before its story can be analysed.';

    case 'director':
      return statusOf('analysis') === 'COMPLETED'
        ? null
        : 'The story analysis has to finish before the performance script can be written.';

    case 'tts': {
      // These two are exactly the preconditions `POST .../tts` enforces:
      // `409 AUDIO_SCRIPT_NOT_VALIDATED` and `409 CASTING_INCOMPLETE`.
      if (audioScript && audioScript.state !== 'VALIDATED') {
        return 'The performance script is not validated yet. Audio generation is refused until it is.';
      }
      if (!audioScript && statusOf('director') !== 'COMPLETED') {
        return 'The performance script has to be written and validated first.';
      }
      if (casting && !casting.ready_for_generation) {
        const count = casting.blocking.length;
        return `${count} speaking character${count === 1 ? '' : 's'} still ${count === 1 ? 'has' : 'have'} no approved voice.`;
      }
      return null;
    }

    case 'assembly': {
      const tts = byStage.get('tts');
      if (!tts || tts.completed_units === 0) {
        return 'There is no generated audio to assemble yet.';
      }
      // `409 CHAPTER_MANIFEST_INCOMPLETE` is possible even here — assembly
      // needs every chunk VALIDATED unless a partial preview is requested — so
      // this is not treated as a hard block, only as a warning surfaced by the
      // caller.
      return null;
    }

    default:
      return null;
  }
}
