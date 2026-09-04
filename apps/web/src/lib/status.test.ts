import { describe, expect, it } from 'vitest';
import { BOOK_STATUSES, JOB_STATUSES, STAGE_STATUSES } from './api/types';
import {
  bookStatusDisplay,
  isCancellable,
  isTerminalJobStatus,
  jobStatusDisplay,
  nextActionForBook,
  reviewFlagDisplay,
  stageStatusDisplay,
} from './status';

describe('status mapping completeness', () => {
  it('maps every Book.status the API can send', () => {
    for (const status of BOOK_STATUSES) {
      expect(bookStatusDisplay(status).label).not.toBe('Unknown');
    }
  });

  it('maps every stage state in the §20.5 projection', () => {
    for (const status of STAGE_STATUSES) {
      expect(stageStatusDisplay(status).label).not.toBe('Unknown');
    }
  });

  it('maps all nine ProcessingJob statuses', () => {
    expect(JOB_STATUSES).toHaveLength(9);
    for (const status of JOB_STATUSES) {
      expect(jobStatusDisplay(status).label).not.toBe('Unknown');
    }
  });

  it('degrades to "Unknown" rather than throwing on a value added after this build', () => {
    // api-usage-guide.md §7: "Treat an unrecognized value as unknown rather
    // than crashing."
    expect(bookStatusDisplay('SOME_FUTURE_STATE').label).toBe('Unknown');
    expect(stageStatusDisplay('SOME_FUTURE_STATE').label).toBe('Unknown');
    expect(jobStatusDisplay('SOME_FUTURE_STATE').label).toBe('Unknown');
    expect(reviewFlagDisplay('SOME_FUTURE_FLAG').label).toBe('Some future flag');
  });
});

describe('job terminality', () => {
  it('treats exactly the four terminal statuses as terminal', () => {
    expect(JOB_STATUSES.filter(isTerminalJobStatus)).toEqual([
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'DEAD_LETTERED',
    ]);
  });

  it('offers cancellation only where it is not a no-op', () => {
    // Cancelling a finished job is a 200 no-op, so the control would be dead.
    expect(isCancellable('RUNNING')).toBe(true);
    expect(isCancellable('QUEUED')).toBe(true);
    expect(isCancellable('SUCCEEDED')).toBe(false);
    expect(isCancellable('DEAD_LETTERED')).toBe(false);
  });
});

describe('nextActionForBook — the UX state machine', () => {
  const base = { needsReview: false, hasSourceFile: true, audiobookReady: false };

  it('gives every backend state a next step, so no state is a dead end', () => {
    for (const status of BOOK_STATUSES) {
      const action = nextActionForBook({ ...base, status });
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.route.length).toBeGreaterThan(0);
      expect(action.rationale.length).toBeGreaterThan(0);
    }
  });

  it('sends a project with no source file to upload one', () => {
    const action = nextActionForBook({ ...base, status: 'CREATED', hasSourceFile: false });
    expect(action.route).toBe('book');
    expect(action.label).toMatch(/upload/i);
  });

  it('prioritises a review decision over the pipeline position', () => {
    // A flagged book mid-generation is waiting on the human, not on a worker.
    const action = nextActionForBook({ ...base, status: 'GENERATING', needsReview: true });
    expect(action.route).toBe('review');
  });

  it('sends a validated script to configuration, not straight to generation', () => {
    expect(nextActionForBook({ ...base, status: 'SCRIPTED' }).route).toBe('generation');
  });

  it('sends a finished book to the audiobook', () => {
    const action = nextActionForBook({ ...base, status: 'COMPLETED', audiobookReady: true });
    expect(action.route).toBe('audiobook');
  });

  it('offers a resume path after cancellation rather than a dead end', () => {
    const action = nextActionForBook({ ...base, status: 'CANCELLED' });
    expect(action.route).toBe('generation');
    expect(action.rationale).toMatch(/kept/i);
  });

  it('still returns somewhere useful for an unrecognized status', () => {
    const action = nextActionForBook({ ...base, status: 'NOT_A_REAL_STATUS' });
    expect(action.route).toBe('overview');
  });
});
