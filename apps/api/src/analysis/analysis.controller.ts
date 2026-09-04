import {
  Body,
  Controller,
  Delete,
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
import {
  createCharacterAliasSchema,
  createCharacterMergeSchema,
  createPronunciationEntrySchema,
  startAnalysisSchema,
  updateCharacterAliasSchema,
  updateCharacterSchema,
  updatePronunciationEntrySchema,
} from '@audio-book/contracts';
import { MalformedRequestError } from '@audio-book/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { QuotaGuard } from '../common/guards/quota.guard.js';
import { BookPurgeGuard } from '../common/guards/book-purge.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import {
  AnalysisService,
  type CreateCharacterAliasBody,
  type CreateCharacterMergeBody,
  type CreatePronunciationEntryBody,
  type StartAnalysisBody,
  type UpdateCharacterAliasBody,
  type UpdateCharacterBody,
  type UpdatePronunciationEntryBody,
} from './analysis.service.js';

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
 * The Phase 3 narrative-understanding surface: analysis lifecycle, scenes,
 * character registry, story bible, and pronunciations
 * (api-specification.md §16.9-16.12). Mirrors books.controller.ts's shape.
 */
@Controller('api/v1/books/:bookId')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard, QuotaGuard, BookPurgeGuard)
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('analysis')
  @HttpCode(202)
  async startAnalysis(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(startAnalysisSchema)) body: StartAnalysisBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/analysis',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const outcome = await this.analysis.startAnalysis(request.principal, bookId, body);
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Get('analysis')
  async getAnalysisStatus(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const state = await this.analysis.getAnalysisStatus(request.principal, bookId);
    return { data: state };
  }

  @Get('scenes')
  async listScenes(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('chapter_id') chapterId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.analysis.listScenes(request.principal, bookId, {
      chapter_id: chapterId,
      cursor,
      limit,
    });
  }

  @Get('scenes/:sceneId')
  async getScene(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('sceneId') sceneId: string,
  ): Promise<unknown> {
    const scene = await this.analysis.getScene(request.principal, bookId, sceneId);
    return { data: scene };
  }

  @Get('characters')
  async listCharacters(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('status') status: string | undefined,
    @Query('speaking') speaking: string | undefined,
    @Query('include_sentinels') includeSentinels: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.analysis.listCharacters(request.principal, bookId, {
      status,
      speaking,
      include_sentinels: includeSentinels,
      cursor,
      limit,
    });
  }

  @Get('characters/:characterId')
  async getCharacter(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
  ): Promise<unknown> {
    const character = await this.analysis.getCharacter(request.principal, bookId, characterId);
    return { data: character };
  }

  @Patch('characters/:characterId')
  async updateCharacter(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
    @Body(new AjvValidationPipe(updateCharacterSchema)) body: UpdateCharacterBody,
  ): Promise<unknown> {
    const character = await this.analysis.updateCharacter(
      request.principal,
      bookId,
      characterId,
      body,
    );
    return { data: character };
  }

  @Get('characters/:characterId/aliases')
  async listCharacterAliases(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
  ): Promise<unknown> {
    const aliases = await this.analysis.listCharacterAliases(
      request.principal,
      bookId,
      characterId,
    );
    return { data: aliases };
  }

  @Post('characters/:characterId/aliases')
  @HttpCode(201)
  async createCharacterAlias(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
    @Body(new AjvValidationPipe(createCharacterAliasSchema)) body: CreateCharacterAliasBody,
  ): Promise<unknown> {
    const alias = await this.analysis.createCharacterAlias(
      request.principal,
      bookId,
      characterId,
      body,
    );
    reply.header(
      'Location',
      `/api/v1/books/${bookId}/characters/${characterId}/aliases/${alias.id}`,
    );
    return { data: alias };
  }

  @Patch('characters/:characterId/aliases/:aliasId')
  async updateCharacterAlias(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
    @Param('aliasId') aliasId: string,
    @Body(new AjvValidationPipe(updateCharacterAliasSchema)) body: UpdateCharacterAliasBody,
  ): Promise<unknown> {
    const alias = await this.analysis.updateCharacterAlias(
      request.principal,
      bookId,
      characterId,
      aliasId,
      body,
    );
    return { data: alias };
  }

  @Delete('characters/:characterId/aliases/:aliasId')
  @HttpCode(204)
  async deleteCharacterAlias(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
    @Param('aliasId') aliasId: string,
  ): Promise<void> {
    await this.analysis.deleteCharacterAlias(request.principal, bookId, characterId, aliasId);
  }

  @Post('character-merges')
  @HttpCode(201)
  async createCharacterMerge(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(createCharacterMergeSchema)) body: CreateCharacterMergeBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/character-merges',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const merge = await this.analysis.createCharacterMerge(request.principal, bookId, body);
        return { status: 201, body: { data: merge } };
      },
    );
    return result.body;
  }

  @Get('character-merges')
  async listCharacterMerges(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.analysis.listCharacterMerges(request.principal, bookId, { cursor, limit });
  }

  @Get('story-bible')
  async getStoryBible(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('sections') sections: string | undefined,
    @Query('snapshot_version') snapshotVersion: string | undefined,
  ): Promise<unknown> {
    const bible = await this.analysis.getStoryBible(request.principal, bookId, {
      sections,
      snapshot_version: snapshotVersion,
    });
    return { data: bible };
  }

  @Get('story-bible/snapshots')
  async listStoryBibleSnapshots(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('chapter_id') chapterId: string | undefined,
    @Query('scene_id') sceneId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.analysis.listStoryBibleSnapshots(request.principal, bookId, {
      chapter_id: chapterId,
      scene_id: sceneId,
      cursor,
      limit,
    });
  }

  @Get('story-bible/snapshots/:snapshotId')
  async getStoryBibleSnapshot(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('snapshotId') snapshotId: string,
  ): Promise<unknown> {
    const snapshot = await this.analysis.getStoryBibleSnapshot(
      request.principal,
      bookId,
      snapshotId,
    );
    return { data: snapshot };
  }

  @Get('director-context')
  async getDirectorContext(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('paragraph_id') paragraphId: string | undefined,
    @Query('token_budget') tokenBudget: string | undefined,
  ): Promise<unknown> {
    if (!paragraphId) {
      throw new MalformedRequestError({ message: 'paragraph_id query parameter is required.' });
    }
    const context = await this.analysis.getDirectorContext(request.principal, bookId, {
      paragraph_id: paragraphId,
      token_budget: tokenBudget,
    });
    return { data: context };
  }

  @Get('story-bible/pronunciations')
  async listPronunciations(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.analysis.listPronunciations(request.principal, bookId, { cursor, limit });
  }

  @Post('story-bible/pronunciations')
  @HttpCode(201)
  async createPronunciation(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Body(new AjvValidationPipe(createPronunciationEntrySchema)) body: CreatePronunciationEntryBody,
  ): Promise<unknown> {
    const entry = await this.analysis.createPronunciation(request.principal, bookId, body);
    return { data: entry };
  }

  @Patch('story-bible/pronunciations/:entryId')
  async updatePronunciation(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('entryId') entryId: string,
    @Body(new AjvValidationPipe(updatePronunciationEntrySchema)) body: UpdatePronunciationEntryBody,
  ): Promise<unknown> {
    const entry = await this.analysis.updatePronunciation(request.principal, bookId, entryId, body);
    return { data: entry };
  }

  @Delete('story-bible/pronunciations/:entryId')
  @HttpCode(204)
  async deletePronunciation(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('entryId') entryId: string,
  ): Promise<void> {
    await this.analysis.deletePronunciation(request.principal, bookId, entryId);
  }
}
