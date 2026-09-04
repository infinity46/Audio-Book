import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { PlatformService } from './platform.service.js';

/**
 * `api-specification.md` §16.21.
 *
 * Note the guard chain: `JwtAuthGuard` and `RateLimitGuard`, but **not**
 * `TenantRoleGuard`. §16.21 says "any authenticated principal", and these
 * responses carry no tenant content — so refusing a `PLATFORM_ADMIN` here (as
 * `TenantRoleGuard` does on content surfaces, per §6.6) would deny an admin
 * the limits and vocabularies they need to interpret the admin surface, for no
 * safety gain.
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('capabilities')
  async getCapabilities(): Promise<unknown> {
    return { data: await this.platform.getCapabilities() };
  }

  @Get('model-versions')
  async listModelVersions(
    @Query('role') role: string | undefined,
    @Query('provider_id') providerId: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<unknown> {
    return this.platform.listModelVersions({ role, provider_id: providerId, cursor, limit });
  }

  @Get('model-versions/:modelVersionId')
  async getModelVersion(@Param('modelVersionId') modelVersionId: string): Promise<unknown> {
    return { data: await this.platform.getModelVersion(modelVersionId) };
  }
}
