import { Module } from '@nestjs/common';
import { MaintenanceTestController } from './maintenance.controller.js';

@Module({
  controllers: [MaintenanceTestController],
})
export class MaintenanceModule {}
