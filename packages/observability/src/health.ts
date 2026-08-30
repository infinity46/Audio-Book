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

  getState(): WorkerState {
    return this.state;
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
