import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { createAccessUrlSchema, startAssemblySchema, updateAudiobookMetadataSchema } from '@audio-book/contracts';
import type { StartAssembly, UpdateAudiobookMetadata } from '@audio-book/contracts';
import { MalformedRequestError } from '@audio-book/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import {
  AssemblyService,
  type CreateAccessUrlBody,
  type PutAudiobookCoverBody,
} from './assembly.service.js';

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
 * Assembly, chapter-audio, and audiobook surface (`api-specification.md`
 * §16.16/§16.17/§16.20). Mirrors `tts.controller.ts`'s shape.
 */
@Controller('api/v1/books/:bookId')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard)
export class AssemblyController {
  constructor(
    private readonly assembly: AssemblyService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('assembly')
  @HttpCode(202)
  async startAssembly(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(startAssemblySchema)) body: StartAssembly,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/assembly',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const outcome = await this.assembly.startAssembly(request.principal, bookId, body);
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Get('assembly')
  async getAssemblyState(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    return { data: await this.assembly.getAssemblyState(request.principal, bookId) };
  }

  @Get('chapter-audio')
  async listChapterAudio(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('chapter_id') chapterId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.assembly.listChapterAudio(request.principal, bookId, {
      chapter_id: chapterId,
      status,
      cursor,
      limit,
    });
  }

  @Get('chapter-audio/:chapterAudioId')
  async getChapterAudio(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('chapterAudioId') chapterAudioId: string,
  ): Promise<unknown> {
    return {
      data: await this.assembly.getChapterAudio(request.principal, bookId, chapterAudioId),
    };
  }

  @Post('chapter-audio/:chapterAudioId/access-urls')
  @HttpCode(200)
  async createChapterAudioAccessUrl(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('chapterAudioId') chapterAudioId: string,
    @Body(new AjvValidationPipe(createAccessUrlSchema)) body: CreateAccessUrlBody,
  ): Promise<unknown> {
    return {
      data: await this.assembly.createChapterAudioAccessUrl(
        request.principal,
        bookId,
        chapterAudioId,
        body,
      ),
    };
  }

  @Get('audiobook')
  async getAudiobookProject(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    return { data: await this.assembly.getAudiobookProject(request.principal, bookId) };
  }

  @Get('audiobooks')
  async listAudiobooks(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('include_superseded') includeSuperseded: string | undefined,
    @Query('format') format: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.assembly.listAudiobooks(request.principal, bookId, {
      include_superseded: includeSuperseded,
      format,
      cursor,
      limit,
    });
  }

  @Get('audiobooks/:audiobookId')
  async getAudiobook(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('audiobookId') audiobookId: string,
  ): Promise<unknown> {
    return { data: await this.assembly.getAudiobook(request.principal, bookId, audiobookId) };
  }

  @Patch('audiobooks/:audiobookId')
  async updateAudiobookMetadata(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('audiobookId') audiobookId: string,
    @Body(new AjvValidationPipe(updateAudiobookMetadataSchema)) body: UpdateAudiobookMetadata,
  ): Promise<unknown> {
    return {
      data: await this.assembly.updateAudiobookMetadata(
        request.principal,
        bookId,
        audiobookId,
        body,
      ),
    };
  }

  @Put('audiobooks/:audiobookId/cover')
  async putAudiobookCover(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('bookId') bookId: string,
    @Param('audiobookId') audiobookId: string,
    @Body() body: PutAudiobookCoverBody,
  ): Promise<unknown> {
    const result = await this.assembly.putAudiobookCover(
      request.principal,
      bookId,
      audiobookId,
      body,
    );
    reply.status(result.status);
    return { data: result.body };
  }

  @Post('audiobooks/:audiobookId/access-urls')
  @HttpCode(200)
  async createAudiobookAccessUrl(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('audiobookId') audiobookId: string,
    @Body(new AjvValidationPipe(createAccessUrlSchema)) body: CreateAccessUrlBody,
  ): Promise<unknown> {
    return {
      data: await this.assembly.createAudiobookAccessUrl(
        request.principal,
        bookId,
        audiobookId,
        body,
      ),
    };
  }
}
