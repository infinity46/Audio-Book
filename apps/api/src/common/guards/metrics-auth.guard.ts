import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AuthenticationError } from '@audio-book/errors';
import type { FastifyRequest } from 'fastify';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '@audio-book/config';

/**
 * Gates GET /metrics and GET /health/dependencies behind a static service
 * token (api-specification.md §19 table: "Service token" auth, never public).
 * This is deliberately not the end-user JWT guard — these are
 * operator/scraper surfaces.
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const expected = `Bearer ${this.config.secrets.metricsServiceToken}`;
    if (header !== expected) {
      throw new AuthenticationError({ message: 'Invalid or missing service token.' });
    }
    return true;
  }
}
