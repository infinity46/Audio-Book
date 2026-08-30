import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { QueueManager, type QueueJobEnvelope } from '@audio-book/queue';

/**
 * Exercises the real BullMQ/Redis path (task §64 "Queue Verification"):
 * enqueue -> success; enqueue -> failure -> retry -> success; and
 * DLQ-after-max-attempts. Requires Redis reachable at REDIS_URL (see
 * docker-compose.yml `redis` service, or the CI `integration` job's
 * Redis service container).
 */
describe('QueueManager (maintenance queue)', () => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  let manager: QueueManager;

  afterEach(async () => {
    await manager?.close();
  });

  function envelope(): QueueJobEnvelope {
    return {
      job_id: randomUUID(),
      correlation_id: randomUUID(),
      tenant_id: randomUUID(),
      payload: {},
    };
  }

  it('enqueue -> worker succeeds on the first attempt', async () => {
    manager = new QueueManager({ redisUrl, backoff: { baseMs: 10, ceilingMs: 100 } });
    const seen: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const worker = manager.createWorker(
        'maintenance',
        (job) => {
          seen.push(job.data.job_id);
          return Promise.resolve();
        },
        { concurrency: 1, maxAttempts: 3 },
      );
      worker.on('completed', () => resolve());
      worker.on('failed', (_job, err) => reject(err));
      void manager.enqueue('maintenance', envelope(), { jobName: 'noop', maxAttempts: 3 });
    });

    expect(seen).toHaveLength(1);
  });

  it('enqueue -> transient failure -> retry -> eventual success', async () => {
    manager = new QueueManager({ redisUrl, backoff: { baseMs: 10, ceilingMs: 100 } });
    let attempts = 0;

    await new Promise<void>((resolve, reject) => {
      const worker = manager.createWorker(
        'maintenance',
        (_job) => {
          attempts += 1;
          if (attempts < 2) throw new Error('transient failure');
          return Promise.resolve();
        },
        { concurrency: 1, maxAttempts: 3 },
      );
      worker.on('completed', (job) => {
        if (job.attemptsMade >= 2) resolve();
      });
      worker.on('failed', (_job, err) => {
        if (attempts >= 3) reject(err);
      });
      void manager.enqueue('maintenance', envelope(), { jobName: 'noop', maxAttempts: 3 });
    });

    expect(attempts).toBe(2);
  });

  it('a job that exhausts every attempt lands in the queue-specific DLQ', async () => {
    manager = new QueueManager({ redisUrl, backoff: { baseMs: 5, ceilingMs: 20 } });
    const jobId = randomUUID();

    await new Promise<void>((resolve, reject) => {
      const worker = manager.createWorker(
        'maintenance',
        () => {
          throw new Error('permanent failure');
        },
        { concurrency: 1, maxAttempts: 2 },
      );
      let finalFailureSeen = false;
      worker.on('failed', (job) => {
        if (job && job.attemptsMade >= 2) finalFailureSeen = true;
      });
      const timer = setInterval(() => {
        void manager
          .dlq('maintenance')
          .getJob(jobId)
          .then((dlqJob) => {
            if (dlqJob) {
              clearInterval(timer);
              resolve();
            } else if (finalFailureSeen) {
              // give the 'failed' handler's async DLQ write a moment to land
            }
          })
          .catch(reject);
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('Timed out waiting for job to land in DLQ'));
      }, 10_000);

      void manager.enqueue(
        'maintenance',
        { job_id: jobId, correlation_id: randomUUID(), tenant_id: randomUUID(), payload: {} },
        { jobName: 'noop', maxAttempts: 2 },
      );
    });
  }, 15_000);
});
