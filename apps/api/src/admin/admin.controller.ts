import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { cancelJobSchema, replayJobSchema, updateTenantQuotasSchema } from '@audio-book/contracts';
import { MalformedRequestError } from '@audio-book/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { correlationFromReply } from '../common/audit.service.js';
import { AdminService, type UpdateTenantQuotasBody } from './admin.service.js';
import { type CancelJobBody, JobsService, type ListJobsQuery } from '../jobs/jobs.service.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal: AuthenticatedPrincipal;
}

/**
 * `api-specification.md` §16.22.
 *
 * The route prefix (`/api/v1/admin`) and the guard (`PlatformAdminGuard`)
 * together are what §133 of the Phase 8 brief asks for — administrative
 * operations separated *clearly* from user APIs, not merely gated by a
 * conditional inside a shared handler. Nothing here shares a controller with a
 * tenant surface, so a route cannot accidentally inherit the wrong guard.
 */
@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard, RateLimitGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly jobs: JobsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('tenants')
  async listTenants(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('status') status: string | undefined,
  ): Promise<unknown> {
    return this.admin.listTenants(
      request.principal,
      { cursor, limit, status },
      correlationFromReply(reply),
    );
  }

  @Get('tenants/:tenantId')
  async getTenant(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('tenantId') tenantId: string,
  ): Promise<unknown> {
    return {
      data: await this.admin.getTenant(request.principal, tenantId, correlationFromReply(reply)),
    };
  }

  @Patch('tenants/:tenantId/quotas')
  async updateQuotas(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('tenantId') tenantId: string,
    @Body(new AjvValidationPipe(updateTenantQuotasSchema)) body: UpdateTenantQuotasBody,
  ): Promise<unknown> {
    return {
      data: await this.admin.updateTenantQuotas(
        request.principal,
        tenantId,
        body,
        correlationFromReply(reply),
      ),
    };
  }

  @Get('users')
  async listUsers(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('tenant_id') tenantId: string | undefined,
    @Query('email') email: string | undefined,
  ): Promise<unknown> {
    return this.admin.listUsers(
      request.principal,
      { cursor, limit, tenant_id: tenantId, email },
      correlationFromReply(reply),
    );
  }

  @Get('jobs')
  async listJobs(@Query() query: ListJobsQuery & { tenant_id?: string }): Promise<unknown> {
    return this.jobs.listJobsAcrossTenants(query);
  }

  /** §16.22: same semantics and idempotency as §16.18, but across tenants. */
  @Post('jobs/:jobId/cancellation')
  @HttpCode(200)
  async cancelAnyJob(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('jobId') jobId: string,
    @Body(new AjvValidationPipe(cancelJobSchema)) body: CancelJobBody,
  ): Promise<unknown> {
    return {
      data: await this.jobs.cancelJob(request.principal, jobId, body, {
        crossTenant: true,
        correlation: correlationFromReply(reply),
      }),
    };
  }

  /**
   * `202` + a **new** job handle (§16.22). `Idempotency-Key` is required
   * because a retried replay would otherwise create a second job for the same
   * fix — the exact duplicate-pipeline failure §18 of the Phase 8 brief warns
   * about, made worse here by being an operator action taken during an
   * incident.
   */
  @Post('jobs/:jobId/replay')
  @HttpCode(202)
  async replayJob(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('jobId') jobId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(replayJobSchema)) body: { reason?: string },
  ): Promise<unknown> {
    if (!idempotencyKey) {
      throw new MalformedRequestError({
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required.',
      });
    }
    const correlation = correlationFromReply(reply);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/admin/jobs/:jobId/replay',
        key: idempotencyKey,
        body: { jobId, ...body },
      },
      async () => {
        const job = await this.jobs.replayJob(request.principal, jobId, correlation);
        return { status: 202, body: { data: { job } }, location: `/api/v1/jobs/${job.id}` };
      },
    );
    if (result.location) void reply.header('Location', result.location);
    return result.body;
  }

  @Get('dead-letters')
  async listDeadLetters(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('tenant_id') tenantId: string | undefined,
    @Query('type') type: string | undefined,
  ): Promise<unknown> {
    return this.admin.listDeadLetters(
      request.principal,
      { cursor, limit, tenant_id: tenantId, type },
      correlationFromReply(reply),
    );
  }

  @Get('model-versions')
  async listModelVersions(): Promise<unknown> {
    return this.admin.listModelVersionsIncludingRetired();
  }

  @Get('workers')
  async listWorkers(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    return this.admin.listWorkers(request.principal, correlationFromReply(reply));
  }
}
