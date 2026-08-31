import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  completeUploadSessionSchema,
  createBookSchema,
  createUploadSessionSchema,
  requestIngestionSchema,
} from '@audio-book/contracts';
import { MalformedRequestError } from '@audio-book/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import {
  BooksService,
  type CompleteUploadSessionBody,
  type CreateBookBody,
  type CreateUploadSessionBody,
  type RequestIngestionBody,
} from './books.service.js';

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
 * The Phase 2 ingestion-critical surface from api-specification.md §16.3-
 * §16.8 (book creation, upload flow, ingestion, structural reads). Book
 * PATCH/DELETE/restoration/purge, multipart uploads, and SSE progress are
 * out of scope for this pass (see the plan's "Known limitations").
 */
@Controller('api/v1/books')
@UseGuards(JwtAuthGuard)
export class BooksController {
  constructor(
    private readonly books: BooksService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  async createBook(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(createBookSchema)) body: CreateBookBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      { principal: request.principal, method: 'POST', pathTemplate: '/api/v1/books', key, body },
      async () => {
        const book = await this.books.createBook(request.principal, body);
        return { status: 201, body: { data: book }, location: `/api/v1/books/${book.id}` };
      },
    );
    reply.status(result.status);
    if (result.location) reply.header('Location', result.location);
    return result.body;
  }

  @Get()
  async listBooks(@Req() request: RequestWithPrincipal): Promise<unknown> {
    const books = await this.books.listBooks(request.principal);
    return { data: books };
  }

  @Get(':bookId')
  async getBook(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const book = await this.books.getBook(request.principal, bookId);
    return { data: book };
  }

  @Post(':bookId/upload-sessions')
  async createUploadSession(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(createUploadSessionSchema)) body: CreateUploadSessionBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/upload-sessions',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const session = await this.books.createUploadSession(request.principal, bookId, body);
        return {
          status: 201,
          body: { data: session },
          location: `/api/v1/books/${bookId}/upload-sessions/${session.id}`,
        };
      },
    );
    reply.status(result.status);
    if (result.location) reply.header('Location', result.location);
    return result.body;
  }

  @Get(':bookId/upload-sessions/:sessionId')
  async getUploadSession(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<unknown> {
    const session = await this.books.getUploadSession(request.principal, bookId, sessionId);
    return { data: session };
  }

  @Delete(':bookId/upload-sessions/:sessionId')
  @HttpCode(204)
  async abortUploadSession(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    await this.books.abortUploadSession(request.principal, bookId, sessionId);
  }

  @Post(':bookId/upload-sessions/:sessionId/completion')
  @HttpCode(202)
  async completeUploadSession(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(completeUploadSessionSchema)) body: CompleteUploadSessionBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/upload-sessions/:sessionId/completion',
        key,
        body: { bookId, sessionId, ...body },
      },
      async () => {
        const outcome = await this.books.completeUploadSession(
          request.principal,
          bookId,
          sessionId,
          body,
        );
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Post(':bookId/ingestion')
  @HttpCode(202)
  async requestIngestion(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(requestIngestionSchema)) body: RequestIngestionBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/ingestion',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const outcome = await this.books.requestIngestion(request.principal, bookId, body);
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Get(':bookId/ingestion')
  async getIngestionStatus(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const state = await this.books.getIngestionStatus(request.principal, bookId);
    return { data: state };
  }

  @Get(':bookId/chapters')
  async listChapters(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const chapters = await this.books.listChapters(request.principal, bookId);
    return { data: chapters };
  }

  @Get(':bookId/chapters/:chapterId')
  async getChapter(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('chapterId') chapterId: string,
  ): Promise<unknown> {
    const chapter = await this.books.getChapter(request.principal, bookId, chapterId);
    return { data: chapter };
  }

  @Get(':bookId/sections')
  async listSections(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const sections = await this.books.listSections(request.principal, bookId);
    return { data: sections };
  }

  @Get(':bookId/paragraphs')
  async listParagraphs(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Query('chapter_id') chapterId: string | undefined,
  ): Promise<unknown> {
    if (!chapterId) {
      throw new MalformedRequestError({ message: 'chapter_id query parameter is required.' });
    }
    const paragraphs = await this.books.listParagraphs(request.principal, bookId, chapterId);
    return { data: paragraphs };
  }

  @Post(':bookId/text/access-urls')
  async createTextAccessUrl(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const accessUrl = await this.books.createTextAccessUrl(request.principal, bookId);
    return { data: accessUrl };
  }
}
