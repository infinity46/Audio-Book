import { Module } from '@nestjs/common';
import { AuditService } from '../common/audit.service.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/**
 * Imports `JobsModule` rather than re-implementing job listing and
 * cancellation: §4 of the Phase 8 brief forbids duplicating domain logic, and
 * two implementations of the cancellation state table would drift.
 */
@Module({
  imports: [JobsModule],
  controllers: [AdminController],
  providers: [AdminService, AuditService],
})
export class AdminModule {}
