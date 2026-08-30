import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Baseline metrics catalog for Phase 1. Extension points for future
 * TTS/Director/GPU metrics are named but not populated here (§40 of the
 * task: "Do not implement GPU monitoring yet").
 */
export class MetricsRegistry {
  readonly registry: Registry;

  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status_code'>;
  readonly httpRequestDurationSeconds: Histogram<'method' | 'route' | 'status_code'>;
  readonly errorsTotal: Counter<'error_code' | 'category'>;

  readonly queueJobsTotal: Counter<'queue' | 'outcome'>;
  readonly queueJobDurationSeconds: Histogram<'queue'>;
  readonly queueDepth: Gauge<'queue' | 'state'>;

  readonly workerStatus: Gauge<'worker_kind' | 'status'>;
  readonly dependencyHealth: Gauge<'dependency'>;

  constructor(serviceName: string) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: serviceName });
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests processed',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.errorsTotal = new Counter({
      name: 'errors_total',
      help: 'Total errors by taxonomy code and category',
      labelNames: ['error_code', 'category'],
      registers: [this.registry],
    });

    this.queueJobsTotal = new Counter({
      name: 'queue_jobs_total',
      help: 'Total queue jobs processed, by outcome',
      labelNames: ['queue', 'outcome'],
      registers: [this.registry],
    });

    this.queueJobDurationSeconds = new Histogram({
      name: 'queue_job_duration_seconds',
      help: 'Queue job processing latency in seconds',
      labelNames: ['queue'],
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 300],
      registers: [this.registry],
    });

    this.queueDepth = new Gauge({
      name: 'queue_depth',
      help: 'Current queue depth by state',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
    });

    this.workerStatus = new Gauge({
      name: 'worker_status',
      help: 'Worker status (1 = current status, per worker_kind/status label pair)',
      labelNames: ['worker_kind', 'status'],
      registers: [this.registry],
    });

    this.dependencyHealth = new Gauge({
      name: 'dependency_health',
      help: 'Dependency health (1 = healthy, 0 = unhealthy)',
      labelNames: ['dependency'],
      registers: [this.registry],
    });
  }

  async toPrometheusText(): Promise<string> {
    return this.registry.metrics();
  }
}
