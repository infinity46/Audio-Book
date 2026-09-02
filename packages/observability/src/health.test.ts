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

  describe('concurrent jobs (F-24)', () => {
    function readyMachine(): WorkerHealthStateMachine {
      const machine = new WorkerHealthStateMachine();
      machine.transition('HEALTHY');
      machine.transition('MODEL_READY');
      machine.transition('IDLE');
      return machine;
    }

    it('survives overlapping jobs instead of throwing on the second one', () => {
      const machine = readyMachine();
      machine.beginWork();
      // The regression: this second concurrent job threw "Cannot transition
      // from PROCESSING to PROCESSING" straight out of the BullMQ process
      // function, dead-lettering a job whose handler never ran.
      expect(() => machine.beginWork()).not.toThrow();
      expect(machine.getState()).toBe('PROCESSING');
      expect(machine.getInFlight()).toBe(2);
    });

    it('stays PROCESSING until the LAST in-flight job finishes', () => {
      const machine = readyMachine();
      machine.beginWork();
      machine.beginWork();

      machine.endWork();
      // One job is still running: reporting IDLE here would be a readiness lie.
      expect(machine.getState()).toBe('PROCESSING');

      machine.endWork();
      expect(machine.getState()).toBe('IDLE');
      expect(machine.getInFlight()).toBe(0);
    });

    it('is safe to call from a finally block during shutdown', () => {
      const machine = readyMachine();
      machine.beginWork();
      machine.transition('DRAINING');
      // A job unwinding after drain started must not drag the process back to
      // IDLE, and must not throw over an already-failing path.
      expect(() => machine.endWork()).not.toThrow();
      expect(machine.getState()).toBe('DRAINING');
    });

    it('never drives the count below zero', () => {
      const machine = readyMachine();
      expect(() => machine.endWork()).not.toThrow();
      expect(machine.getInFlight()).toBe(0);
      expect(machine.getState()).toBe('IDLE');
    });
  });
});
