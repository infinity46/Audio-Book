import { Module } from '@nestjs/common';
import { AssemblyController } from './assembly.controller.js';
import { AssemblyService } from './assembly.service.js';
import { CoverUploadSessionStore } from './cover-upload-session.store.js';

@Module({
  controllers: [AssemblyController],
  providers: [AssemblyService, CoverUploadSessionStore],
})
export class AssemblyModule {}
