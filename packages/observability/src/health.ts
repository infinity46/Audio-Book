/**
 * Readiness composition for API/worker /ready endpoints. Checks must be
 * cheap (api-specification.md §19: "Do not perform expensive queries").
 * A failed check never reveals which dependency failed in the HTTP
 * response body — only a reason_code — matching the api-spec's rule that
 * /ready must not name the dependency in its response.
 */
export interface DependencyCheck {
  name: string;
  check: () => Promise<boolean>;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  reason_code?: 'DEPENDENCY_UNAVAILABLE';
  /** Per-dependency detail — only for the authenticated /health/dependencies surface, never /ready. */
  dependencies: Record<string, boolean>;
}

export async function composeReadiness(checks: DependencyCheck[]): Promise<ReadinessResult> {
  const results = await Promise.all(
    checks.map(async (c) => {
      try {
        return [c.name, await c.check()] as const;
      } catch {
        return [c.name, false] as const;
      }
    }),
  );
  const dependencies = Object.fromEntries(results);
  const allHealthy = results.every(([, healthy]) => healthy);
  return allHealthy
    ? { status: 'ready', dependencies }
    : { status: 'not_ready', reason_code: 'DEPENDENCY_UNAVAILABLE', dependencies };
}

/**
 * Generic worker health/readiness state machine
 * (tts-provider-specification.md §52.1): liveness (STARTING/HEALTHY) is
 * distinct from readiness (MODEL_READY) — a worker can be alive with all
 * dependencies reachable while still not ready to accept work because no
 * model is loaded yet. Phase 1 workers drive this with a stub model step;
 * no real model loading happens here.
 */
export type WorkerState =
  | 'STARTING'
  | 'HEALTHY'
  | 'MODEL_READY'
  | 'PROCESSING'
  | 'IDLE'
  | 'DRAINING'
  | 'STOPPED'
  | 'FAILED_START';

const VALID_TRANSITIONS: Record<WorkerState, WorkerState[]> = {
  STARTING: ['HEALTHY', 'FAILED_START'],
  HEALTHY: ['MODEL_READY', 'DRAINING'],
  MODEL_READY: ['PROCESSING', 'IDLE', 'DRAINING'],
  PROCESSING: ['IDLE', 'DRAINING'],
  IDLE: ['PROCESSING', 'DRAINING'],
  DRAINING: ['STOPPED'],
  STOPPED: [],
  FAILED_START: [],
};

export class InvalidWorkerStateTransitionError extends Error {}

export class WorkerHealthStateMachine {
  private state: WorkerState = 'STARTING';
  private inFlight = 0;

  getState(): WorkerState {
    return this.state;
  }

  /** Jobs currently in flight, for tests and diagnostics. */
  getInFlight(): number {
    return this.inFlight;
  }

  /**
   * Marks one job as started. PROCESSING/IDLE describe the *process*, but a
   * worker runs `concurrency` jobs at once and each one used to drive
   * `transition()` directly — so the second overlapping job threw
   * "Cannot transition from PROCESSING to PROCESSING" out of the BullMQ
   * process function, before any handler logic ran. The job failed, retried
   * into the same collision, and dead-lettered, while its ProcessingJob row
   * stayed at CREATED/attempt_count=0 because nothing had touched it yet
   * (QA finding F-24). worker-cpu shares one state machine across four queue
   * workers, so this needed only two jobs to overlap anywhere in the process.
   *
   * The count also fixes the mirror-image bug: the first job to finish used
   * to flip the whole process to IDLE while its siblings were still running,
   * and the last one's `finally` then hit an IDLE -> IDLE throw that masked
   * whatever real error was propagating.
   */
  beginWork(): void {
    this.inFlight += 1;
    if (this.inFlight === 1 && (this.state === 'IDLE' || this.state === 'MODEL_READY')) {
      this.transition('PROCESSING');
    }
  }

  /**
   * Marks one job as finished; only the last one in flight returns the
   * process to IDLE. Safe to call from a `finally` — during DRAINING/STOPPED
   * shutdown has already claimed the state and must not be dragged back.
   */
  endWork(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    if (this.inFlight === 0 && this.state === 'PROCESSING') {
      this.transition('IDLE');
    }
  }

  transition(to: WorkerState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      throw new InvalidWorkerStateTransitionError(`Cannot transition from ${this.state} to ${to}`);
    }
    this.state = to;
  }

  isAlive(): boolean {
    return this.state !== 'STOPPED' && this.state !== 'FAILED_START';
  }

  isReady(): boolean {
    return this.state === 'MODEL_READY' || this.state === 'PROCESSING' || this.state === 'IDLE';
  }
}
