import { Module } from '@nestjs/common';
import { BooksController } from './books.controller.js';
import { BooksService } from './books.service.js';
import { UploadSessionStore } from './upload-session.store.js';

@Module({
  controllers: [BooksController],
  providers: [BooksService, UploadSessionStore],
})
export class BooksModule {}
