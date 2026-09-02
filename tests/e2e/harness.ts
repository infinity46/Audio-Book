import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface E2EPrincipal {
  sub: string;
  tenantId: string;
  roles: string[];
}

export interface E2EHarness {
  baseUrl: string;
  /** Mints a real RS256 token the running API will actually verify. */
  token(principal: E2EPrincipal): Promise<string>;
  request(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; headers: Headers; body: unknown }>;
  /**
   * Captured stdout/stderr of every spawned service, newest last. A failure
   * in a child process is otherwise invisible to the test that provoked it —
   * the same diagnosability problem F-12 fixed for the API's own logs.
   */
  logs(filter?: string): string;
  stop(): Promise<void>;
}

export interface StartHarnessOptions {
  /** Also start worker-cpu, so queued jobs are actually consumed. */
  withWorker?: boolean;
  /**
   * Python workers to start: 'ai' consumes the `ai` queue (analysis,
   * Director), 'gpu' consumes the `gpu` queue (TTS, voice previews). Both
   * default to their deterministic/mock providers, so neither needs a GPU or
   * a network model.
   */
  pythonWorkers?: ('ai' | 'gpu')[];
  /** Per-window bucket overrides, for exercising 429s without thousands of requests. */
  rateLimits?: Partial<Record<'read' | 'write' | 'upload' | 'expensive' | 'access_url', number>>;
  env?: Record<string, string>;
}

const ISSUER = 'https://e2e.test';
const AUDIENCE = 'audiobook-api-e2e';

/**
 * Boots the REAL compiled services as child processes and talks to them over
 * real HTTP.
 *
 * Deliberately runs `dist/` rather than the TypeScript sources: NestJS
 * resolves constructor injection from `design:paramtypes`, which only `tsc`
 * emits — esbuild-based runners (tsx, and vitest's own transform) do not, so
 * an in-process Nest app under vitest would fail to inject anything. Running
 * the compiled output is also what production runs, which is the point of an
 * end-to-end test. Callers must build first (`pnpm -r run build`).
 */
/**
 * Refuses to start if a worker from an earlier run is still alive.
 *
 * A survivor consumes the same shared Redis queues, so this run's jobs can be
 * executed by that run's code — which surfaces later as impossible-looking
 * data (a chapter whose audio chunks carry two different statuses, written
 * milliseconds apart) rather than as an obvious process problem. Failing here,
 * loudly, converts a silent-corruption class into an immediate, legible error.
 */
function assertNoStaleWorkers(): void {
  let listing: string;
  try {
    listing = execSync('ps -eo pid,command', { encoding: 'utf8' });
  } catch {
    return; // Non-POSIX or ps unavailable — skip rather than fail the suite.
  }
  // Match the actual service processes only. A substring search is not enough:
  // any shell, editor, or `grep` whose own command line happens to mention a
  // worker name would match it, and this guard then fails the suite for no
  // reason (it did exactly that, on the monitoring commands used to debug it).
  // Anchor on how these processes are really invoked instead.
  const servicePatterns = [
    /^\s*\d+\s+node\s+\S*dist\/main\.js\b/, // apps/api, apps/worker-cpu
    /^\s*\d+\s+\S*uv\s+run\s+--package\s+worker-(ai|gpu)\b/, // the uv wrapper
    /^\s*\d+\s+\S*\/\.venv\/bin\/python\S*\s+\S*\/worker-(ai|gpu)\b/, // its interpreter
  ];
  const ours = listing
    .split('\n')
    .filter((line) => servicePatterns.some((re) => re.test(line)));
  if (ours.length > 0) {
    throw new Error(
      'Refusing to start: service processes from a previous run are still alive and ' +
        'will consume this run\'s jobs.\n' +
        ours.map((l) => `  ${l.trim()}`).join('\n') +
        '\nKill them (e.g. `pkill -f worker-ai; pkill -f worker-gpu; pkill -f dist/main.js`) and re-run.',
    );
  }
  assertNoWorkerContainers();
}

/**
 * The same guard, for workers running as containers.
 *
 * `ps` above sees only host processes, so a `docker compose up` worker is
 * invisible to it — while still consuming the same Redis queues, because
 * docker-compose points at the very same broker this harness uses. That is
 * not hypothetical: a `worker-gpu` container left running for 25 hours on an
 * image predating a fix silently split every run's TTS chunks with the
 * harness's own worker, producing rows in two different statuses from two
 * different builds. The evidence looked impossible precisely because the
 * process-based guard could not, even in principle, see the other writer.
 */
function assertNoWorkerContainers(): void {
  let listing: string;
  try {
    listing = execSync(
      'docker ps --filter "status=running" --format "{{.Names}}\t{{.Image}}\t{{.Status}}"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return; // No docker, or the daemon is down: nothing containerised can be racing us.
  }
  // Only the services that consume queues. Postgres/Redis/MinIO are the shared
  // infrastructure this harness deliberately connects to and must keep running.
  const workers = listing
    .split('\n')
    .filter((line) => /worker-(cpu|ai|gpu)|[-_]api[-_]/.test(line) && line.trim().length > 0);
  if (workers.length > 0) {
    throw new Error(
      'Refusing to start: worker/API containers are running and consume the same Redis ' +
        'queues as this harness, so jobs will be split between their image and this ' +
        "run's freshly built code.\n" +
        workers.map((l) => `  ${l.replace(/\t/g, '  ')}`).join('\n') +
        '\nStop them (e.g. `docker compose stop api worker-cpu worker-gpu`) and re-run. ' +
        'Leave postgres/redis/minio up — the harness needs them.',
    );
  }
}

export async function startHarness(options: StartHarnessOptions = {}): Promise<E2EHarness> {
  assertNoStaleWorkers();
  // The private key stays in this process and signs test tokens; only the
  // public half is handed to the service as configuration, exactly as a real
  // deployment would.
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const verifyingKey = await exportSPKI(publicKey);

  const port = 3200 + Math.floor(Math.random() * 400);
  const baseUrl = `http://127.0.0.1:${port}`;

  const sharedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'test',
    SERVICE_NAME: 'api',
    LOG_LEVEL: 'warn',
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
    STORAGE_REGION: process.env.STORAGE_REGION ?? 'us-east-1',
    STORAGE_BUCKET: process.env.STORAGE_BUCKET ?? 'audiobook-dev',
    STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID ?? 'minioadmin',
    STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'minioadmin',
    STORAGE_FORCE_PATH_STYLE: 'true',
    METRICS_SERVICE_TOKEN: 'e2e-metrics-token',
    AUTH_JWT_ISSUER: ISSUER,
    AUTH_JWT_AUDIENCE: AUDIENCE,
    AUTH_JWT_PUBLIC_KEY: verifyingKey,
    // The generated keypair is this process's own and never leaves it; an
    // empty JWKS URL is left set on purpose, since that is what
    // `.env.example` produces and it must not defeat the public key (F-11).
    AUTH_JWT_JWKS_URL: '',
    ...options.env,
  };

  const apiEnv: Record<string, string> = { ...sharedEnv, PORT: String(port) };
  for (const [bucket, limit] of Object.entries(options.rateLimits ?? {})) {
    apiEnv[`RATE_LIMIT_${bucket.toUpperCase()}_PER_WINDOW`] = String(limit);
  }

  const children: ChildProcess[] = [];
  const logs: string[] = [];

  /**
   * Every service is spawned `detached`, i.e. as its own process-group
   * leader, so teardown can signal the whole group.
   *
   * This matters more than it looks: `uv run` execs a child interpreter, and
   * signalling only the `uv` process leaves that grandchild alive. An orphaned
   * worker keeps consuming the shared Redis queues, so a later test run's job
   * can be picked up by a *previous* run's worker — whose logs nothing is
   * reading. That failure mode cost real debugging time here: a Director job
   * showed as RUNNING with no error and no mention in the live worker's log,
   * because a leaked worker from an earlier run had taken it.
   */
  function spawnTracked(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    label: string,
  ): ChildProcess {
    const child = spawn(command, args, {
      cwd: resolve(repoRoot, cwd),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const capture = (chunk: Buffer) => logs.push(`[${label}] ${chunk.toString()}`);
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    children.push(child);
    return child;
  }

  function spawnService(cwd: string, env: Record<string, string>, label: string): ChildProcess {
    return spawnTracked('node', ['dist/main.js'], cwd, env, label);
  }

  spawnService('apps/api', apiEnv, 'api');
  if (options.withWorker) {
    spawnService(
      'apps/worker-cpu',
      { ...sharedEnv, SERVICE_NAME: 'worker-cpu', WORKER_HEALTH_PORT: String(port + 1000) },
      'worker-cpu',
    );
  }

  // The Python workers take the same infrastructure but name their variables
  // differently (STORAGE_ENDPOINT_URL, not STORAGE_ENDPOINT) and are launched
  // through uv, which is typically installed under ~/.local/bin.
  const pythonHealthPorts: number[] = [];
  for (const [index, kind] of (options.pythonWorkers ?? []).entries()) {
    const healthPort = port + 1100 + index;
    pythonHealthPorts.push(healthPort);
    const pkg = kind === 'ai' ? 'worker-ai' : 'worker-gpu';
    spawnTracked(
      'uv',
      ['run', '--package', pkg, pkg],
      'python',
      {
        ...(process.env as Record<string, string>),
        PATH: `${process.env.HOME ?? ''}/.local/bin:${process.env.PATH ?? ''}`,
        ENVIRONMENT: 'development',
        SERVICE_NAME: pkg,
        SERVICE_VERSION: '0.0.0-e2e',
        WORKER_ID: `e2e-${kind}-${port}`,
        QUEUE_NAME: kind,
        HEALTH_PORT: String(healthPort),
        MODEL_ID: kind === 'ai' ? 'stub-director-v0' : 'mock-tts',
        // The Python config enum is uppercase; the TypeScript one is
        // lowercase, and the inherited parent env carries the latter.
        LOG_LEVEL: 'INFO',
        DATABASE_URL: sharedEnv.DATABASE_URL,
        REDIS_URL: sharedEnv.REDIS_URL,
        STORAGE_ENDPOINT_URL: sharedEnv.STORAGE_ENDPOINT,
        STORAGE_BUCKET: sharedEnv.STORAGE_BUCKET,
        STORAGE_ACCESS_KEY_ID: sharedEnv.STORAGE_ACCESS_KEY_ID,
        STORAGE_SECRET_ACCESS_KEY: sharedEnv.STORAGE_SECRET_ACCESS_KEY,
        // Explicit rather than relying on the default: this suite must never
        // reach for a real TTS model.
        TTS_PROVIDER: 'mock',
      },
      pkg,
    );
  }

  /** Signals the child's whole process group, so wrappers like `uv run` don't leak their interpreter. */
  function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group may already be gone; fall back to the direct child.
      try {
        child.kill(signal);
      } catch {
        /* already reaped */
      }
    }
  }

  /** True while any process in the group is still alive (signal 0 probes without delivering). */
  function groupAlive(child: ChildProcess): boolean {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stops every service and does not resolve until each process GROUP is
   * actually gone.
   *
   * Waiting on the direct child's `exit` event is not enough, and getting that
   * wrong cost real debugging time: `uv run` forwards SIGTERM to its
   * interpreter and then exits promptly, while the interpreter begins a
   * 30-second graceful drain. The wrapper's `exit` therefore fires almost
   * immediately, `stop()` resolves, the test file finishes, and the Node
   * process can exit before any SIGKILL fallback timer fires — leaving the
   * worker alive. A survivor keeps consuming the shared Redis queues, so the
   * *next* run's jobs get picked up by the *previous* run's code. That
   * produced a genuinely baffling result here: one chapter's audio chunks came
   * back as a 50/50 mix of two different status values, written milliseconds
   * apart by two workers running different versions of the same file.
   */
  const stop = async (): Promise<void> => {
    // Always persist the complete captured output before tearing down.
    // Failure messages can only ever carry a tail, and a tail is a partial
    // view that is easy to mistake for the whole: counting occurrences in a
    // truncated excerpt gave a wrong answer here and sent the investigation
    // sideways. The full logs belong on disk, where they can be counted.
    try {
      const dir = mkdtempSync(join(tmpdir(), 'audiobook-e2e-'));
      const byLabel = new Map<string, string[]>();
      for (const line of logs) {
        const label = /^\[([^\]]+)\]/.exec(line)?.[1] ?? 'unlabelled';
        (byLabel.get(label) ?? byLabel.set(label, []).get(label)!).push(line);
      }
      for (const [label, lines] of byLabel) {
        writeFileSync(join(dir, `${label}.log`), lines.join(''));
      }
      console.info(`[e2e] service logs written to ${dir}`);
    } catch {
      /* logging must never break teardown */
    }

    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        signalGroup(child, 'SIGTERM');
      }
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && children.some(groupAlive)) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // Anything still standing after the grace period gets SIGKILL, and we keep
    // waiting — resolving with a live process is the failure mode this exists
    // to prevent.
    for (const child of children.filter(groupAlive)) {
      signalGroup(child, 'SIGKILL');
    }
    const hardDeadline = Date.now() + 5_000;
    while (Date.now() < hardDeadline && children.some(groupAlive)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const survivors = children.filter(groupAlive);
    if (survivors.length > 0) {
      // Loud rather than silent: a survivor will corrupt later runs, and the
      // symptom appears far from the cause.
      console.warn(
        `harness.stop(): ${survivors.length} process group(s) survived SIGKILL: ` +
          survivors.map((c) => c.pid).join(', '),
      );
    }
  };

  try {
    await waitForHealth(baseUrl);
    // A Python worker reports `ready` only once its model provider has
    // loaded, so waiting on readiness (not liveness) is what guarantees it
    // will actually pick a job up rather than sit in a loading state.
    for (const healthPort of pythonHealthPorts) {
      await waitForWorkerReady(`http://127.0.0.1:${healthPort}`);
    }
  } catch (err) {
    await stop();
    throw new Error(`services did not become healthy.\n${logs.join('')}\n${String(err)}`);
  }

  return {
    baseUrl,
    async token(principal) {
      return new SignJWT({
        tenant_id: principal.tenantId,
        roles: principal.roles,
        scopes: [],
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(principal.sub)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(privateKey);
    },
    async request(method, path, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* keep the raw text — a non-JSON body is itself the finding */
      }
      return { status: response.status, headers: response.headers, body };
    },
    logs(filter) {
      const joined = logs.join('');
      if (!filter) return joined;
      return joined
        .split('\n')
        .filter((line) => line.includes(filter))
        .join('\n');
    },
    stop,
  };
}

/** Waits for a Python worker's control surface to report `ready` (model loaded, dependencies up). */
async function waitForWorkerReady(baseUrl: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      const body = (await response.json()) as { ready?: boolean; state?: string };
      if (body.ready) return;
      last = JSON.stringify(body);
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`worker at ${baseUrl} never became ready; last: ${last}`);
}

async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error = new Error('timed out waiting for /health');
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`/health returned ${response.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastError;
}
