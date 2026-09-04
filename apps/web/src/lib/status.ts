/**
 * The one status mapping (Phase 9 rules 9, 10, 171).
 *
 * Every status label, tone, and next-action in the studio is derived here.
 * Nothing in this file invents a lifecycle: the vocabularies are the backend's
 * (`api-specification.md` §20.1 for `Book.status`, §20.5 for stage states, the
 * nine `ProcessingJob.status` values, and `audiobook_project.generation_status`).
 * What this file adds is *presentation* — a user-facing label, an accessible
 * tone, and the single next step that state affords.
 *
 * Two rules the API guide states explicitly are honoured throughout:
 *  - an unrecognized value is treated as unknown, never as a crash;
 *  - status is never communicated by colour alone (rule 103) — every tone
 *    carries a shape/label pair too.
 */

import type {
  BookStatus,
  GenerationStatus,
  JobStatus,
  ReviewFlag,
  StageName,
  StageStatus,
} from './api/types';

export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface StatusDisplay {
  label: string;
  tone: Tone;
  /** Longer sentence for tooltips and detail panes. */
  description: string;
  /** True while the backend is actively doing work in this state. */
  active: boolean;
}

const UNKNOWN: StatusDisplay = {
  label: 'Unknown',
  tone: 'neutral',
  description: 'This studio build does not recognise the state the server reported.',
  active: false,
};

// --------------------------------------------------------------- book status --

const BOOK_STATUS_DISPLAY: Record<BookStatus, StatusDisplay> = {
  CREATED: {
    label: 'Draft',
    tone: 'neutral',
    description: 'The project exists. Nothing has been uploaded yet.',
    active: false,
  },
  UPLOADED: {
    label: 'Source uploaded',
    tone: 'neutral',
    description: 'A source file is attached and waiting to be parsed.',
    active: false,
  },
  PARSING: {
    label: 'Reading the book',
    tone: 'progress',
    description: 'Extracting text, pages, and structure from the source file.',
    active: true,
  },
  PARSED: {
    label: 'Text extracted',
    tone: 'neutral',
    description: 'The text has been extracted and is being organised into chapters.',
    active: false,
  },
  STRUCTURED: {
    label: 'Structure ready',
    tone: 'neutral',
    description: 'Chapters and sections are identified. Ready for narrative analysis.',
    active: false,
  },
  ANALYZING: {
    label: 'Understanding the story',
    tone: 'progress',
    description: 'Finding characters, scenes, and who speaks which lines.',
    active: true,
  },
  ANALYZED: {
    label: 'Analysis complete',
    tone: 'neutral',
    description: 'Characters and scenes are identified. Ready to cast voices.',
    active: false,
  },
  CASTING: {
    label: 'Casting voices',
    tone: 'neutral',
    description: 'Characters are being matched to voices.',
    active: false,
  },
  SCRIPTING: {
    label: 'Directing',
    tone: 'progress',
    description: 'Turning the book into a performance script — delivery, emotion, and pacing.',
    active: true,
  },
  SCRIPTED: {
    label: 'Script ready',
    tone: 'neutral',
    description: 'The audio script is validated and ready to be performed.',
    active: false,
  },
  GENERATING: {
    label: 'Generating audio',
    tone: 'progress',
    description: 'Rendering the narration, chunk by chunk.',
    active: true,
  },
  ASSEMBLING: {
    label: 'Assembling audiobook',
    tone: 'progress',
    description: 'Joining chapters, mastering loudness, and packaging the audiobook.',
    active: true,
  },
  COMPLETED: {
    label: 'Ready',
    tone: 'success',
    description: 'The audiobook is finished and available to play or download.',
    active: false,
  },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    description: 'Work stopped because of an error. See the details for what to do next.',
    active: false,
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'neutral',
    description: 'Work was cancelled. Anything already finished has been kept.',
    active: false,
  },
  NEEDS_REVIEW: {
    label: 'Review required',
    tone: 'warning',
    description: 'Some decisions need a human. This is not a failure — the project is waiting.',
    active: false,
  },
};

export function bookStatusDisplay(status: string): StatusDisplay {
  return BOOK_STATUS_DISPLAY[status as BookStatus] ?? UNKNOWN;
}

// -------------------------------------------------------------- stage status --

const STAGE_STATUS_DISPLAY: Record<StageStatus, StatusDisplay> = {
  NOT_STARTED: {
    label: 'Not started',
    tone: 'neutral',
    description: 'This stage has not begun.',
    active: false,
  },
  QUEUED: {
    label: 'Queued',
    tone: 'progress',
    description: 'Waiting for a worker to pick this up.',
    active: true,
  },
  RUNNING: { label: 'Running', tone: 'progress', description: 'In progress.', active: true },
  VALIDATING: {
    label: 'Validating',
    tone: 'progress',
    description: 'The work finished and its output is being checked before it can be used.',
    active: true,
  },
  BLOCKED: {
    label: 'Blocked',
    tone: 'warning',
    description: 'Waiting on something else before it can run.',
    active: false,
  },
  PARTIAL: {
    label: 'Partly done',
    tone: 'warning',
    description: 'Some units finished and some did not.',
    active: false,
  },
  NEEDS_REVIEW: {
    label: 'Needs review',
    tone: 'warning',
    description: 'Finished, but flagged items are waiting on a decision.',
    active: false,
  },
  COMPLETED: { label: 'Complete', tone: 'success', description: 'Finished.', active: false },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    description: 'This stage stopped with an error.',
    active: false,
  },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', description: 'Cancelled.', active: false },
};

export function stageStatusDisplay(status: string): StatusDisplay {
  return STAGE_STATUS_DISPLAY[status as StageStatus] ?? UNKNOWN;
}

export const STAGE_LABELS: Record<StageName, string> = {
  ingestion: 'Reading the book',
  analysis: 'Understanding the story',
  director: 'Directing the performance',
  tts: 'Generating audio',
  assembly: 'Assembling the audiobook',
};

export const STAGE_UNIT_NOUNS: Record<StageName, { one: string; many: string }> = {
  ingestion: { one: 'page', many: 'pages' },
  analysis: { one: 'scene', many: 'scenes' },
  director: { one: 'script', many: 'scripts' },
  tts: { one: 'segment', many: 'segments' },
  assembly: { one: 'chapter', many: 'chapters' },
};

// ---------------------------------------------------------------- job status --

const JOB_STATUS_DISPLAY: Record<JobStatus, StatusDisplay> = {
  CREATED: {
    label: 'Created',
    tone: 'neutral',
    description: 'Recorded, not yet queued.',
    active: true,
  },
  QUEUED: {
    label: 'Queued',
    tone: 'progress',
    description: 'Waiting for a free worker. A busy fleet shows up here.',
    active: true,
  },
  RUNNING: { label: 'Running', tone: 'progress', description: 'Being worked on.', active: true },
  RETRYING: {
    label: 'Retrying',
    tone: 'warning',
    description: 'A previous attempt failed; the system is trying again on its own.',
    active: true,
  },
  BLOCKED: {
    label: 'Blocked',
    tone: 'warning',
    description: 'Waiting on a prerequisite.',
    active: false,
  },
  SUCCEEDED: { label: 'Succeeded', tone: 'success', description: 'Finished.', active: false },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    description: 'Stopped with an error and will not be retried automatically.',
    active: false,
  },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', description: 'Cancelled.', active: false },
  DEAD_LETTERED: {
    label: 'Dead-lettered',
    tone: 'danger',
    description: 'Exhausted its retry budget. Only an operator can replay it.',
    active: false,
  },
};

export function jobStatusDisplay(status: string): StatusDisplay {
  return JOB_STATUS_DISPLAY[status as JobStatus] ?? UNKNOWN;
}

export function isTerminalJobStatus(status: string): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'DEAD_LETTERED'
  );
}

/**
 * Whether offering "Cancel" is honest (rule 49).
 *
 * Cancellation is always accepted and always `200` — but on a terminal job it
 * is a no-op, so showing the control there would be a dead button (rule 160).
 */
export function isCancellable(status: string): boolean {
  return !isTerminalJobStatus(status);
}

// -------------------------------------------------- audiobook generation state --

const GENERATION_STATUS_DISPLAY: Record<GenerationStatus, StatusDisplay> = {
  NOT_STARTED: {
    label: 'Not assembled',
    tone: 'neutral',
    description: 'No audiobook has been assembled for this project yet.',
    active: false,
  },
  BLOCKED: {
    label: 'Blocked',
    tone: 'warning',
    description: 'Some chapters are not ready, so the audiobook cannot be assembled.',
    active: false,
  },
  ASSEMBLING: {
    label: 'Assembling',
    tone: 'progress',
    description: 'The audiobook is being put together.',
    active: true,
  },
  COMPLETED: {
    label: 'Ready',
    tone: 'success',
    description: 'The audiobook is assembled and available.',
    active: false,
  },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    description: 'Assembly stopped with an error.',
    active: false,
  },
  STALE: {
    label: 'Out of date',
    tone: 'warning',
    description:
      'The book or its story data changed after this audiobook was assembled. Reassemble to pick up the changes.',
    active: false,
  },
};

export function generationStatusDisplay(status: string): StatusDisplay {
  return GENERATION_STATUS_DISPLAY[status as GenerationStatus] ?? UNKNOWN;
}

// -------------------------------------------------------------- review flags --

/**
 * `review_flags[]` is a closed vocabulary (`api-usage-guide.md` §10). The API
 * does **not** supply a severity, so this ordering is a *presentation* choice
 * documented as such — rule 172 permits prioritisation only where the backend
 * supplies severity, so the UI groups by flag and never claims a
 * Critical/High/Medium/Low severity the API did not send.
 */
export const REVIEW_FLAG_DISPLAY: Record<ReviewFlag, { label: string; description: string }> = {
  UNKNOWN_SPEAKER: {
    label: 'Speaker not identified',
    description: 'The director could not tell who speaks this passage.',
  },
  LOW_CONFIDENCE: {
    label: 'Low confidence',
    description: 'The director made a call it was not confident about.',
  },
  DIRECTOR_FALLBACK: {
    label: 'Fallback used',
    description: 'A default performance was used because a specific one could not be derived.',
  },
  CAPABILITY_GAP: {
    label: 'Voice cannot do this',
    description:
      'The assigned voice does not support something the script asked for, so it was approximated.',
  },
  CHARACTER_METADATA_CHANGED: {
    label: 'Character changed since scripting',
    description: 'The character this passage refers to was edited after the script was written.',
  },
  PRONUNCIATION_LEXICON_CHANGED: {
    label: 'Pronunciation changed since scripting',
    description: 'The pronunciation lexicon changed after this passage was scripted.',
  },
  TEXT_HASH_MISMATCH: {
    label: 'Source text changed',
    description: 'The book text behind this passage no longer matches what was scripted.',
  },
};

export function reviewFlagDisplay(flag: string): { label: string; description: string } {
  return (
    REVIEW_FLAG_DISPLAY[flag as ReviewFlag] ?? {
      label: humanizeEnum(flag),
      description: 'This studio build does not recognise this review flag.',
    }
  );
}

// ------------------------------------------------------------- next action ----

export type ProjectRoute =
  | 'overview'
  | 'book'
  | 'characters'
  | 'voices'
  | 'generation'
  | 'review'
  | 'chapters'
  | 'audiobook'
  | 'jobs';

export interface NextAction {
  /** The one primary thing to do in this state (rule 169). */
  label: string;
  /** Where it goes, relative to the project workspace. */
  route: ProjectRoute;
  /** Why this is the next step — shown under the button. */
  rationale: string;
}

/**
 * The UX state machine (rule 171): backend state in, next step out.
 *
 * Every one of the sixteen `Book.status` values maps to an action, so no state
 * is a dead end (rule 170). This derives from backend state; it does not
 * maintain a lifecycle of its own.
 */
export function nextActionForBook(input: {
  status: string;
  needsReview: boolean;
  hasSourceFile: boolean;
  audiobookReady: boolean;
}): NextAction {
  // A review gate outranks the pipeline position: it is the thing actually
  // waiting on the user. The API's gate is advisory — the wording says
  // "waiting on you", never "blocked", because nothing stops generation.
  if (input.needsReview || input.status === 'NEEDS_REVIEW') {
    return {
      label: 'Review flagged passages',
      route: 'review',
      rationale: 'Some passages were flagged for a human decision.',
    };
  }

  switch (input.status as BookStatus) {
    case 'CREATED':
      return {
        label: input.hasSourceFile ? 'Start reading the book' : 'Upload the book',
        route: input.hasSourceFile ? 'overview' : 'book',
        rationale: input.hasSourceFile
          ? 'A source file is attached and ready to be parsed.'
          : 'Add a PDF or EPUB to get started.',
      };
    case 'UPLOADED':
    case 'PARSING':
    case 'PARSED':
      return {
        label: 'Watch progress',
        route: 'overview',
        rationale: 'The book is being read. Nothing is needed from you yet.',
      };
    case 'STRUCTURED':
      return {
        label: 'Review the structure',
        route: 'book',
        rationale: 'Check the chapters found in the book, then start the story analysis.',
      };
    case 'ANALYZING':
      return {
        label: 'Watch progress',
        route: 'overview',
        rationale: 'Characters and scenes are being identified.',
      };
    case 'ANALYZED':
    case 'CASTING':
      return {
        label: 'Cast the voices',
        route: 'voices',
        rationale: 'Every speaking character needs a voice before audio can be generated.',
      };
    case 'SCRIPTING':
      return {
        label: 'Watch progress',
        route: 'overview',
        rationale: 'The performance script is being written.',
      };
    case 'SCRIPTED':
      return {
        label: 'Configure and generate',
        route: 'generation',
        rationale: 'The script is validated. Choose the output settings and start generation.',
      };
    case 'GENERATING':
    case 'ASSEMBLING':
      return {
        label: 'Watch generation',
        route: 'generation',
        rationale: 'Audio is being produced. You can leave this page — progress is kept server-side.',
      };
    case 'COMPLETED':
      return {
        label: input.audiobookReady ? 'Listen or download' : 'Open the audiobook',
        route: 'audiobook',
        rationale: 'The audiobook is finished.',
      };
    case 'FAILED':
      return {
        label: 'See what failed',
        route: 'jobs',
        rationale: 'Work stopped with an error. The job list shows which step and why.',
      };
    case 'CANCELLED':
      return {
        label: 'Resume generation',
        route: 'generation',
        rationale: 'Work already finished was kept. Starting again picks up from there.',
      };
    case 'NEEDS_REVIEW':
      return {
        label: 'Review flagged passages',
        route: 'review',
        rationale: 'Some passages were flagged for a human decision.',
      };
    default:
      // An unrecognized status must still lead somewhere useful (rule 170).
      return {
        label: 'Open the project',
        route: 'overview',
        rationale: 'This studio build does not recognise the current state.',
      };
  }
}

// ------------------------------------------------------------------ helpers --

/** `NEEDS_REVIEW` → `Needs review`. For values with no curated label. */
export function humanizeEnum(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
