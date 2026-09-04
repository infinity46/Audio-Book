import { Prisma, PrismaClient } from '@prisma/client';
import {
  DeliveryFormat,
  DeliveryMode,
  Emotion,
  JobStatus,
  JobType,
  BookStatus,
} from '@prisma/client';

export { Prisma, PrismaClient };

/**
 * The closed vocabularies (`api-specification.md` §7.6 — "not extensible
 * within v1") re-exported as runtime objects.
 *
 * Prisma emits these as real values, not just types, but `@audio-book/database`
 * previously exported only `Prisma`/`PrismaClient`, so a consumer that wanted
 * to check a hand-written list against the database's own vocabulary had to
 * reach past this package into `@prisma/client`. Exporting them here keeps that
 * check possible without a second dependency edge, and is what lets
 * `platform.service.test.ts` fail the build when `GET /capabilities` and the
 * database disagree about what an emotion is.
 */
export { BookStatus, DeliveryFormat, DeliveryMode, Emotion, JobStatus, JobType };
export type Tx = Prisma.TransactionClient;

export interface CreatePrismaClientOptions {
  databaseUrl: string;
  poolMax?: number;
  logLevel?: Prisma.LogLevel[];
}

let singleton: PrismaClient | undefined;

/**
 * Single shared PrismaClient instance per process — business services should
 * inject this rather than instantiating `new PrismaClient()` themselves
 * (task requirement: "Business services should not instantiate raw Prisma
 * clients repeatedly").
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  if (singleton) return singleton;
  const url = withConnectionLimit(options.databaseUrl, options.poolMax);
  singleton = new PrismaClient({
    datasources: { db: { url } },
    log: options.logLevel ?? ['error', 'warn'],
  });
  return singleton;
}

export function withConnectionLimit(databaseUrl: string, poolMax?: number): string {
  if (!poolMax) return databaseUrl;
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', String(poolMax));
  return url.toString();
}

/** Runs `fn` inside a single Postgres transaction — the same-transaction guarantee Outbox/Inbox depend on. */
export function withTransaction<T>(client: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return client.$transaction((tx) => fn(tx));
}

/** Cheap liveness check for /ready — a single trivial query, never an expensive one (api-specification.md §19). */
export async function pingDatabase(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Graceful shutdown: let in-flight queries finish, then close the pool. */
export async function disconnectPrisma(client: PrismaClient): Promise<void> {
  await client.$disconnect();
}
