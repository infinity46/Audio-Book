import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createAccessUrlSchema, startTtsSchema } from '@audio-book/contracts';
import { MalformedRequestError } from '@audio-book/errors';
import type { FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { type CreateAccessUrlBody, type StartTtsBody, TtsService } from './tts.service.js';

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
 * TTS generation and `AudioChunk` read surface (`api-specification.md` §16.15).
 * Mirrors `director.controller.ts`'s shape.
 */
@Controller('api/v1/books/:bookId')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard)
export class TtsController {
  constructor(
    private readonly tts: TtsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('tts')
  @HttpCode(202)
  async startTts(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(startTtsSchema)) body: StartTtsBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/tts',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const outcome = await this.tts.startTts(request.principal, bookId, body);
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Get('tts')
  async getTtsState(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    return { data: await this.tts.getTtsState(request.principal, bookId) };
  }

  @Get('audio-chunks')
  async listAudioChunks(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('chapter_id') chapterId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('character_id') characterId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.tts.listAudioChunks(request.principal, bookId, {
      chapter_id: chapterId,
      status,
      character_id: characterId,
      cursor,
      limit,
    });
  }

  @Get('audio-chunks/:audioChunkId')
  async getAudioChunk(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('audioChunkId') audioChunkId: string,
  ): Promise<unknown> {
    return { data: await this.tts.getAudioChunk(request.principal, bookId, audioChunkId) };
  }

  @Post('audio-chunks/:audioChunkId/access-urls')
  @HttpCode(200)
  async createAccessUrl(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('audioChunkId') audioChunkId: string,
    @Body(new AjvValidationPipe(createAccessUrlSchema)) body: CreateAccessUrlBody,
  ): Promise<unknown> {
    return {
      data: await this.tts.createAudioChunkAccessUrl(request.principal, bookId, audioChunkId, body),
    };
  }
}
