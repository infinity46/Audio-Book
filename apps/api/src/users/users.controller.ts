import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Req, Res, UseGuards } from '@nestjs/common';
import { updateCurrentUserSchema } from '@audio-book/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { decodeSessionId } from '../auth/token.service.js';
import { type UpdateCurrentUserBody, UsersService } from './users.service.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal: AuthenticatedPrincipal;
}

/** `api-specification.md` §16.2. Self only — there is no `GET /users/{userId}` in v1. */
@Controller('api/v1/users/me')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async getMe(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const { data, etag } = await this.users.getCurrentUser(request.principal);
    // §2.7: ETag on single-resource GET of a mutable resource.
    void reply.header('ETag', etag);
    return { data };
  }

  @Patch()
  async updateMe(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new AjvValidationPipe(updateCurrentUserSchema)) body: UpdateCurrentUserBody,
  ): Promise<unknown> {
    const { data, etag } = await this.users.updateCurrentUser(request.principal, body, ifMatch);
    void reply.header('ETag', etag);
    return { data };
  }

  @Get('quotas')
  async getQuotas(@Req() request: RequestWithPrincipal): Promise<unknown> {
    return { data: await this.users.getQuotas(request.principal) };
  }

  /** §16.2 — the current request's own session is marked `current: true`. */
  @Get('sessions')
  async listSessions(
    @Req() request: RequestWithPrincipal,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<unknown> {
    const bearer = authorization?.slice('Bearer '.length);
    const currentSessionId = bearer ? decodeSessionId(bearer) : undefined;
    return { data: await this.users.listSessions(request.principal, currentSessionId) };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async revokeSession(
    @Req() request: RequestWithPrincipal,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    await this.users.revokeSession(request.principal, sessionId);
  }
}
