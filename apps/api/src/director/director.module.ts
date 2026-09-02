import { Module } from '@nestjs/common';
import { DirectorController } from './director.controller.js';
import { DirectorService } from './director.service.js';

@Module({
  controllers: [DirectorController],
  providers: [DirectorService],
})
export class DirectorModule {}
