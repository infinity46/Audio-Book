import { describe, expect, it } from 'vitest';
import {
  composeReadiness,
  InvalidWorkerStateTransitionError,
  WorkerHealthStateMachine,
} from './health.js';

describe('composeReadiness', () => {
  it('is ready only when every dependency check passes', async () => {
    const result = await composeReadiness([
      { name: 'database', check: () => Promise.resolve(true) },
      { name: 'redis', check: () => Promise.resolve(true) },
    ]);
    expect(result.status).toBe('ready');
    expect(result.reason_code).toBeUndefined();
  });

  it('reports not_ready with a reason_code but never names the failing dependency in the status', async () => {
    const result = await composeReadiness([
      { name: 'database', check: () => Promise.resolve(true) },
      { name: 'redis', check: () => Promise.resolve(false) },
    ]);
    expect(result.status).toBe('not_ready');
    expect(result.reason_code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('treats a throwing check as unhealthy rather than propagating', async () => {
    const result = await composeReadiness([
      { name: 'storage', check: () => Promise.reject(new Error('boom')) },
    ]);
    expect(result.status).toBe('not_ready');
  });
});

describe('WorkerHealthStateMachine', () => {
  it('models liveness vs readiness: HEALTHY is alive but not ready', () => {
    const machine = new WorkerHealthStateMachine();
    machine.transition('HEALTHY');
    expect(machine.isAlive()).toBe(true);
    expect(machine.isReady()).toBe(false);

    machine.transition('MODEL_READY');
    expect(machine.isReady()).toBe(true);
  });

  it('rejects invalid transitions', () => {
    const machine = new WorkerHealthStateMachine();
    expect(() => machine.transition('PROCESSING')).toThrow(InvalidWorkerStateTransitionError);
  });

  it('drains before stopping and is no longer alive once stopped', () => {
    const machine = new WorkerHealthStateMachine();
    machine.transition('HEALTHY');
    machine.transition('DRAINING');
    machine.transition('STOPPED');
    expect(machine.isAlive()).toBe(false);
  });
});
