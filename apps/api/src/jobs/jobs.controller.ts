import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { cancelJobSchema } from '@audio-book/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { correlationFromReply } from '../common/audit.service.js';
import { type CancelJobBody, JobsService, type ListJobsQuery } from './jobs.service.js';
import { EventStreamService } from '../events/event-stream.service.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal: AuthenticatedPrincipal;
}

/**
 * `api-specification.md` §16.18 (jobs, attempts, cancellation) and the job
 * half of §16.19 (event stream).
 *
 * There is deliberately **no** `POST /jobs/{id}/retry`: §16.18 states retries
 * are the job system's own concern, and a user-visible retry is a scoped stage
 * command (`POST /books/{id}/{stage}` with `force`), which already exists.
 * Operator replay of a dead-lettered job lives on the admin surface.
 */
@Controller('api/v1/jobs')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly streams: EventStreamService,
  ) {}

  @Get()
  async listJobs(
    @Req() request: RequestWithPrincipal,
    @Query() query: ListJobsQuery,
  ): Promise<unknown> {
    return this.jobs.listJobs(request.principal, query);
  }

  @Get(':jobId')
  async getJob(
    @Req() request: RequestWithPrincipal,
    @Param('jobId') jobId: string,
  ): Promise<unknown> {
    return { data: await this.jobs.getJob(request.principal, jobId) };
  }

  @Get(':jobId/attempts')
  async listAttempts(
    @Req() request: RequestWithPrincipal,
    @Param('jobId') jobId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.jobs.listAttempts(request.principal, jobId, { cursor, limit });
  }

  /**
   * `200`, not `202`: §16.18 says the request itself is synchronous. The
   * *effect* on a RUNNING job is asynchronous, and the response says so via
   * `cancellation.effective`. No `Idempotency-Key` is required because
   * cancellation is idempotent by construction (§29.2) — repeated calls never
   * change the outcome.
   */
  @Post(':jobId/cancellation')
  @HttpCode(200)
  async cancelJob(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('jobId') jobId: string,
    @Body(new AjvValidationPipe(cancelJobSchema)) body: CancelJobBody,
  ): Promise<unknown> {
    return {
      data: await this.jobs.cancelJob(request.principal, jobId, body, {
        correlation: correlationFromReply(reply),
      }),
    };
  }

  @Get(':jobId/events')
  async streamJobEvents(
    @Req() request: RequestWithPrincipal,
    @Res() reply: FastifyReply,
    @Param('jobId') jobId: string,
  ): Promise<void> {
    // Authorization happens BEFORE the stream opens (§16.19): a cross-tenant
    // job id is a 404 with a normal error envelope, not an SSE frame.
    await this.jobs.getJob(request.principal, jobId);
    await this.streams.open(reply, request, {
      scope: 'job',
      id: jobId,
      principal: request.principal,
    });
  }
}
