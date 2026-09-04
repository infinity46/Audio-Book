import { Module } from '@nestjs/common';
import { AuditService } from '../common/audit.service.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

@Module({
  controllers: [JobsController],
  providers: [JobsService, AuditService],
  exports: [JobsService],
})
export class JobsModule {}
