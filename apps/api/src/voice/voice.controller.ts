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
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  approveVoiceProfileVersionSchema,
  assignVoiceSchema,
  createVoicePreviewSchema,
  createVoiceProfileSchema,
  createVoiceProfileVersionSchema,
  lockVoiceProfileVersionSchema,
  narratorFallbackSchema,
  updateVoiceProfileSchema,
} from '@audio-book/contracts';
import { MalformedRequestError } from '@audio-book/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import {
  type ApproveVoiceProfileVersionBody,
  type AssignVoiceBody,
  type CreateVoicePreviewBody,
  type CreateVoiceProfileBody,
  type CreateVoiceProfileVersionBody,
  type LockVoiceProfileVersionBody,
  type NarratorFallbackBody,
  type UpdateVoiceProfileBody,
  VoiceService,
} from './voice.service.js';

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
 * The Voice Registry surface (`api-specification.md` §16.14): voice profile / version
 * lifecycle, previews, character voice assignment, casting readiness. See
 * `voice.service.ts`'s docstring for this pass's documented scope limitations
 * (no reference-audio cloning, no SYSTEM-profile snapshot-on-assign).
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard)
export class VoiceController {
  constructor(
    private readonly voice: VoiceService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('voice-profiles')
  async listVoiceProfiles(
    @Req() request: RequestWithPrincipal,
    @Query('scope') scope: string | undefined,
    @Query('book_id') bookId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    const data = await this.voice.listVoiceProfiles(request.principal, {
      scope,
      book_id: bookId,
      cursor,
      limit,
    });
    return { data };
  }

  @Post('voice-profiles')
  async createVoiceProfile(
    @Req() request: RequestWithPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(createVoiceProfileSchema)) body: CreateVoiceProfileBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/voice-profiles',
        key,
        body,
      },
      async () => ({
        status: 201,
        body: { data: await this.voice.createVoiceProfile(request.principal, body) },
      }),
    );
    return result.body;
  }

  @Get('voice-profiles/:voiceProfileId')
  async getVoiceProfile(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
  ): Promise<unknown> {
    return { data: await this.voice.getVoiceProfile(request.principal, voiceProfileId) };
  }

  @Patch('voice-profiles/:voiceProfileId')
  async updateVoiceProfile(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Body(new AjvValidationPipe(updateVoiceProfileSchema)) body: UpdateVoiceProfileBody,
  ): Promise<unknown> {
    return { data: await this.voice.updateVoiceProfile(request.principal, voiceProfileId, body) };
  }

  @Delete('voice-profiles/:voiceProfileId')
  async deleteVoiceProfile(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
  ): Promise<void> {
    await this.voice.deleteVoiceProfile(request.principal, voiceProfileId);
  }

  @Get('voice-profiles/:voiceProfileId/versions')
  async listVersions(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
  ): Promise<unknown> {
    return { data: await this.voice.listVoiceProfileVersions(request.principal, voiceProfileId) };
  }

  @Post('voice-profiles/:voiceProfileId/versions')
  async createVersion(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(createVoiceProfileVersionSchema))
    body: CreateVoiceProfileVersionBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/voice-profiles/:voiceProfileId/versions',
        key,
        body: { voiceProfileId, ...body },
      },
      async () => ({
        status: 201,
        body: {
          data: await this.voice.createVoiceProfileVersion(request.principal, voiceProfileId, body),
        },
      }),
    );
    return result.body;
  }

  @Get('voice-profiles/:voiceProfileId/versions/:version')
  async getVersion(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Param('version') version: string,
  ): Promise<unknown> {
    return {
      data: await this.voice.getVoiceProfileVersion(
        request.principal,
        voiceProfileId,
        Number(version),
      ),
    };
  }

  @Post('voice-profiles/:voiceProfileId/versions/:version/approval')
  @HttpCode(200)
  async approveVersion(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Param('version') version: string,
    @Body(new AjvValidationPipe(approveVoiceProfileVersionSchema))
    body: ApproveVoiceProfileVersionBody,
  ): Promise<unknown> {
    return {
      data: await this.voice.approveVoiceProfileVersion(
        request.principal,
        voiceProfileId,
        Number(version),
        body,
      ),
    };
  }

  @Post('voice-profiles/:voiceProfileId/versions/:version/lock')
  @HttpCode(200)
  async lockVersion(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Param('version') version: string,
    @Body(new AjvValidationPipe(lockVoiceProfileVersionSchema)) body: LockVoiceProfileVersionBody,
  ): Promise<unknown> {
    return {
      data: await this.voice.lockVoiceProfileVersion(
        request.principal,
        voiceProfileId,
        Number(version),
        body,
      ),
    };
  }

  @Post('voice-profiles/:voiceProfileId/versions/:version/retirement')
  @HttpCode(200)
  async retireVersion(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Param('version') version: string,
  ): Promise<unknown> {
    return {
      data: await this.voice.retireVoiceProfileVersion(
        request.principal,
        voiceProfileId,
        Number(version),
      ),
    };
  }

  @Post('voice-profiles/:voiceProfileId/versions/:version/previews')
  async createPreviews(
    @Req() request: RequestWithPrincipal,
    // Without an explicit reply, the `status: 202` computed below is
    // discarded and Nest's `@Post` default (201) is sent instead — but
    // preview synthesis is asynchronous work, which api-specification.md
    // §16.13 specifies as `202` + job. Mirrors books/assembly controllers.
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('voiceProfileId') voiceProfileId: string,
    @Param('version') version: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(createVoicePreviewSchema)) body: CreateVoicePreviewBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/voice-profiles/:voiceProfileId/versions/:version/previews',
        key,
        body: { voiceProfileId, version, ...body },
      },
      async () => ({
        status: 202,
        body: {
          data: {
            accepted: await this.voice.createVoicePreviews(
              request.principal,
              voiceProfileId,
              Number(version),
              body,
            ),
          },
        },
      }),
    );
    reply.status(result.status);
    return result.body;
  }

  @Get('voice-profiles/:voiceProfileId/versions/:version/previews')
  async listPreviews(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Param('version') version: string,
  ): Promise<unknown> {
    return {
      data: await this.voice.listVoicePreviews(request.principal, voiceProfileId, Number(version)),
    };
  }

  @Get('voice-profiles/:voiceProfileId/versions/:version/previews/:previewId')
  async getPreview(
    @Req() request: RequestWithPrincipal,
    @Param('voiceProfileId') voiceProfileId: string,
    @Param('version') version: string,
    @Param('previewId') previewId: string,
  ): Promise<unknown> {
    return {
      data: await this.voice.getVoicePreview(
        request.principal,
        voiceProfileId,
        Number(version),
        previewId,
      ),
    };
  }

  @Get('books/:bookId/characters/:characterId/voice')
  async getCharacterVoice(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
  ): Promise<unknown> {
    return { data: await this.voice.getCharacterVoice(request.principal, bookId, characterId) };
  }

  @Put('books/:bookId/characters/:characterId/voice')
  @HttpCode(200)
  async assignCharacterVoice(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
    @Body(new AjvValidationPipe(assignVoiceSchema)) body: AssignVoiceBody,
  ): Promise<unknown> {
    return {
      data: await this.voice.assignCharacterVoice(request.principal, bookId, characterId, body),
    };
  }

  @Delete('books/:bookId/characters/:characterId/voice')
  async clearCharacterVoice(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('characterId') characterId: string,
  ): Promise<void> {
    await this.voice.clearCharacterVoice(request.principal, bookId, characterId);
  }

  @Get('books/:bookId/casting')
  async getCastingState(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    return { data: await this.voice.getCastingState(request.principal, bookId) };
  }

  @Post('books/:bookId/casting/narrator-fallback')
  @HttpCode(200)
  async acceptNarratorFallback(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Body(new AjvValidationPipe(narratorFallbackSchema)) body: NarratorFallbackBody,
  ): Promise<unknown> {
    return { data: await this.voice.acceptNarratorFallback(request.principal, bookId, body) };
  }
}
