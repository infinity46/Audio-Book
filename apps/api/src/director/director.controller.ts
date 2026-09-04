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
  UseGuards,
} from '@nestjs/common';
import {
  reviseDirectorSchema,
  startDirectorSchema,
  updateAudioScriptChunkSchema,
} from '@audio-book/contracts';
import { MalformedRequestError } from '@audio-book/errors';
import type { FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { QuotaGuard } from '../common/guards/quota.guard.js';
import { BookPurgeGuard } from '../common/guards/book-purge.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import {
  DirectorService,
  type ReviseDirectorBody,
  type StartDirectorBody,
  type UpdateAudioScriptChunkBody,
} from './director.service.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal: AuthenticatedPrincipal;
}

function requireIdempotencyKey(key: string | undefined): string {
  if (!key) {
    throw new MalformedRequestError({
      code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key header is required.',
    });
  }
  return key;
}

/**
 * The Phase 4 Director surface: start/status, Audio Script (immutable,
 * read-only), and Audio Script chunks (read + bounded human-override PATCH)
 * (api-specification.md §16.13). Mirrors analysis.controller.ts's shape.
 */
@Controller('api/v1/books/:bookId')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard, QuotaGuard, BookPurgeGuard)
export class DirectorController {
  constructor(
    private readonly director: DirectorService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('director')
  @HttpCode(202)
  async startDirector(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(startDirectorSchema)) body: StartDirectorBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/director',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const outcome = await this.director.startDirector(request.principal, bookId, body);
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Get('director')
  async getDirectorState(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const state = await this.director.getDirectorState(request.principal, bookId);
    return { data: state };
  }

  @Post('director/revisions')
  @HttpCode(202)
  async reviseDirector(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(reviseDirectorSchema)) body: ReviseDirectorBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/director/revisions',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const outcome = await this.director.reviseDirector(request.principal, bookId, body);
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Get('audio-script')
  async getCurrentAudioScript(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const script = await this.director.getCurrentAudioScript(request.principal, bookId);
    return { data: script };
  }

  @Get('audio-scripts')
  async listAudioScripts(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('include_superseded') includeSuperseded: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.director.listAudioScripts(request.principal, bookId, {
      include_superseded: includeSuperseded,
      cursor,
      limit,
    });
  }

  @Get('audio-scripts/:audioScriptId')
  async getAudioScript(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('audioScriptId') audioScriptId: string,
  ): Promise<unknown> {
    const script = await this.director.getAudioScript(request.principal, bookId, audioScriptId);
    return { data: script };
  }

  @Get('audio-script-chunks')
  async listAudioScriptChunks(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('audio_script_id') audioScriptId: string | undefined,
    @Query('chapter_id') chapterId: string | undefined,
    @Query('scene_id') sceneId: string | undefined,
    @Query('character_id') characterId: string | undefined,
    @Query('speaker_type') speakerType: string | undefined,
    @Query('state') state: string | undefined,
    @Query('has_review_flags') hasReviewFlags: string | undefined,
    @Query('fallback_applied') fallbackApplied: string | undefined,
    @Query('min_confidence') minConfidence: string | undefined,
    @Query('max_confidence') maxConfidence: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.director.listAudioScriptChunks(request.principal, bookId, {
      audio_script_id: audioScriptId,
      chapter_id: chapterId,
      scene_id: sceneId,
      character_id: characterId,
      speaker_type: speakerType,
      state,
      has_review_flags: hasReviewFlags,
      fallback_applied: fallbackApplied,
      min_confidence: minConfidence,
      max_confidence: maxConfidence,
      cursor,
      limit,
    });
  }

  @Get('audio-script-chunks/:chunkId')
  async getAudioScriptChunk(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('chunkId') chunkId: string,
  ): Promise<unknown> {
    const chunk = await this.director.getAudioScriptChunk(request.principal, bookId, chunkId);
    return { data: chunk };
  }

  @Patch('audio-script-chunks/:chunkId')
  async updateAudioScriptChunk(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('chunkId') chunkId: string,
    @Body(new AjvValidationPipe(updateAudioScriptChunkSchema)) body: UpdateAudioScriptChunkBody,
  ): Promise<unknown> {
    const chunk = await this.director.updateAudioScriptChunk(
      request.principal,
      bookId,
      chunkId,
      body,
    );
    return { data: chunk };
  }
}
