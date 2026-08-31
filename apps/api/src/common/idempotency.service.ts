import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { ConflictError } from '@audio-book/errors';
import { generateId } from '@audio-book/events';
import { PRISMA } from './tokens.js';
import type { AuthenticatedPrincipal } from './guards/jwt-auth.guard.js';

export interface IdempotentResponse<T> {
  status: number;
  body: T;
  location?: string;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Wraps a request handler with the HTTP-layer idempotency registry
 * (database-schema.md §15.4, `IdempotencyKey` table) so a client retrying
 * the same `Idempotency-Key` on the same route+body gets back the exact
 * original response instead of creating a second Book/BookFile/ProcessingJob
 * (task §12 "do not parse books inside the HTTP request" pairs with this:
 * every state-changing POST that kicks off async work must be idempotent).
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async run<T>(
    params: {
      principal: AuthenticatedPrincipal;
      method: string;
      pathTemplate: string;
      key: string;
      body: unknown;
    },
    handler: () => Promise<IdempotentResponse<T>>,
  ): Promise<IdempotentResponse<T>> {
    const { principal, method, pathTemplate, key, body } = params;
    const requestBodyHash = createHash('sha256').update(stableStringify(body)).digest('hex');

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: {
        tenantId_principalId_method_pathTemplate_key: {
          tenantId: principal.tenantId,
          principalId: principal.sub,
          method,
          pathTemplate,
          key,
        },
      },
    });

    if (existing) {
      if (existing.requestBodyHash !== requestBodyHash) {
        throw new ConflictError({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'This Idempotency-Key was already used with a different request body.',
        });
      }
      if (existing.status === 'COMPLETED') {
        return {
          status: existing.responseStatusCode ?? 200,
          body: existing.responseBody as T,
          location: existing.responseLocation ?? undefined,
        };
      }
      if (existing.status === 'IN_PROGRESS') {
        throw new ConflictError({
          code: 'REQUEST_IN_PROGRESS',
          message: 'A request with this Idempotency-Key is already in progress.',
        });
      }
      // FAILED — fall through and retry the handler, reusing the same row id.
    }

    const id = existing?.id ?? generateId();
    const now = new Date();
    await this.prisma.idempotencyKey.upsert({
      where: {
        tenantId_principalId_method_pathTemplate_key: {
          tenantId: principal.tenantId,
          principalId: principal.sub,
          method,
          pathTemplate,
          key,
        },
      },
      create: {
        id,
        tenantId: principal.tenantId,
        principalId: principal.sub,
        method,
        pathTemplate,
        key,
        requestBodyHash,
        status: 'IN_PROGRESS',
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
      update: { status: 'IN_PROGRESS', requestBodyHash },
    });

    try {
      const result = await handler();
      await this.prisma.idempotencyKey.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          responseStatusCode: result.status,
          responseBody: result.body as object,
          responseLocation: result.location,
          completedAt: new Date(),
        },
      });
      return result;
    } catch (err) {
      await this.prisma.idempotencyKey
        .update({ where: { id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw err;
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
