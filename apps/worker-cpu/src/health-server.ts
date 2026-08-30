import { createServer, type Server } from 'node:http';
import { composeReadiness, type WorkerHealthStateMachine } from '@audio-book/observability';
import type { DependencyCheck } from '@audio-book/observability';

/**
 * Minimal HTTP health surface for non-API processes (workers have no public
 * routes, so a full Nest/Fastify app is unnecessary overhead here). Exposes
 * the same liveness/readiness split as the API: /health never touches
 * dependencies; /ready reflects both dependency health and the worker's own
 * STARTING/HEALTHY/MODEL_READY/... state.
 */
export function startHealthServer(
  port: number,
  stateMachine: WorkerHealthStateMachine,
  dependencyChecks: DependencyCheck[],
): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const alive = stateMachine.isAlive();
      res.writeHead(alive ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: alive ? 'alive' : 'stopped' }));
      return;
    }
    if (req.url === '/ready') {
      void (async () => {
        const readiness = await composeReadiness(dependencyChecks);
        const ready = readiness.status === 'ready' && stateMachine.isReady();
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: ready ? 'ready' : 'not_ready',
            reason_code: ready ? undefined : 'DEPENDENCY_UNAVAILABLE',
          }),
        );
      })();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port);
  return server;
}
