import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { BookPurgeGuard } from '../common/guards/book-purge.guard.js';
import { EventStreamService } from '../events/event-stream.service.js';
import { ProgressService } from './progress.service.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal: AuthenticatedPrincipal;
}

/** `api-specification.md` §16.19 — the aggregate a frontend polls, and its SSE counterpart. */
@Controller('api/v1/books/:bookId')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard, BookPurgeGuard)
export class ProgressController {
  constructor(
    private readonly progress: ProgressService,
    private readonly streams: EventStreamService,
  ) {}

  @Get('progress')
  async getProgress(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    return { data: await this.progress.getBookProgress(request.principal, bookId) };
  }

  @Get('events')
  async streamBookEvents(
    @Req() request: RequestWithPrincipal,
    @Res() reply: FastifyReply,
    @Param('bookId') bookId: string,
  ): Promise<void> {
    // Ownership is proven before a single byte of the stream is written
    // (§16.19: "a cross-tenant bookId is 404 before the stream opens").
    await this.progress.getBookProgress(request.principal, bookId);
    await this.streams.open(reply, request, {
      scope: 'book',
      id: bookId,
      principal: request.principal,
    });
  }
}
