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
  completeUploadSessionSchema,
  createBookSchema,
  createUploadSessionSchema,
  purgeBookSchema,
  requestIngestionSchema,
  restoreBookSchema,
  updateBookSchema,
} from '@audio-book/contracts';
import { MalformedRequestError, ValidationError } from '@audio-book/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AjvValidationPipe } from '../common/pipes/ajv-validation.pipe.js';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { QuotaGuard } from '../common/guards/quota.guard.js';
import { BookPurgeGuard } from '../common/guards/book-purge.guard.js';
import { TenantRoleGuard } from '../common/guards/tenant-role.guard.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { ProgressService } from '../progress/progress.service.js';
import {
  BooksService,
  type CompleteUploadSessionBody,
  type CreateBookBody,
  type CreateUploadSessionBody,
  type ListBooksQuery,
  type PurgeBookBody,
  type RequestIngestionBody,
  type UpdateBookBody,
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
 * The book surface of `api-specification.md` §16.3-§16.8: creation, the upload
 * flow, ingestion, structural reads, metadata update with optimistic
 * concurrency, soft delete, source-file reads, the `include=stages` pipeline
 * overview, and — added in Phase 10 — restoration and purge (§16.6.2/
 * §16.6.3), completing the deletion lifecycle `deleteBook` starts.
 *
 * Still out of scope, deliberately rather than by omission: multipart upload
 * (§16.6 describes a single PUT target and no client needs more yet) and
 * `POST /books/{id}/text/access-urls`' streaming variants.
 */
@Controller('api/v1/books')
@UseGuards(JwtAuthGuard, TenantRoleGuard, RateLimitGuard, QuotaGuard, BookPurgeGuard)
export class BooksController {
  constructor(
    private readonly books: BooksService,
    private readonly idempotency: IdempotencyService,
    // Injected rather than reimplemented: `include=stages` must return exactly
    // what `GET /books/{id}/progress` reports, or a UI rendering a pipeline
    // overview and a progress bar from the same book would show two different
    // stories (§4: no business-logic duplication).
    private readonly progress: ProgressService,
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
  async listBooks(
    @Req() request: RequestWithPrincipal,
    @Query() query: ListBooksQuery,
  ): Promise<unknown> {
    return this.books.listBooks(request.principal, query);
  }

  @Get(':bookId')
  async getBook(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('bookId') bookId: string,
    @Query('include') include: string | undefined,
  ): Promise<unknown> {
    const { data, etag } = await this.books.getBook(request.principal, bookId);
    // §2.7: ETag on single-resource GET of a mutable resource.
    void reply.header('ETag', etag);

    // §16.5: `include=stages` and nothing else. An unrecognized value is
    // rejected rather than ignored, so a client that misspells it learns so
    // instead of silently receiving a response without the data it asked for.
    if (include === undefined) return { data };
    if (include !== 'stages') {
      throw new ValidationError({
        message: "include accepts only the value 'stages'.",
        details: [{ field: 'include', issue: 'invalid_enum' }],
      });
    }
    return { data: { ...data, stages: await this.progress.getStageSummary(bookId) } };
  }

  @Patch(':bookId')
  async updateBook(
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('bookId') bookId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new AjvValidationPipe(updateBookSchema)) body: UpdateBookBody,
  ): Promise<unknown> {
    const { data, etag } = await this.books.updateBook(request.principal, bookId, body, ifMatch);
    void reply.header('ETag', etag);
    return { data };
  }

  /** §16.6.1 — soft delete, `204`, naturally idempotent. */
  @Delete(':bookId')
  @HttpCode(204)
  async deleteBook(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<void> {
    await this.books.deleteBook(request.principal, bookId);
  }

  /** §16.6.2 — undo a soft delete within the retention window. `TENANT_OWNER` only. */
  @Post(':bookId/restoration')
  @HttpCode(200)
  async restoreBook(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Body(new AjvValidationPipe(restoreBookSchema)) _body: unknown,
  ): Promise<unknown> {
    return this.books.restoreBook(request.principal, bookId);
  }

  /** §16.6.3 — irreversible purge. `TENANT_OWNER` only, `Idempotency-Key` required. */
  @Post(':bookId/purge')
  @HttpCode(202)
  async purgeBook(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new AjvValidationPipe(purgeBookSchema)) body: PurgeBookBody,
  ): Promise<unknown> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.run(
      {
        principal: request.principal,
        method: 'POST',
        pathTemplate: '/api/v1/books/:bookId/purge',
        key,
        body: { bookId, ...body },
      },
      async () => {
        const outcome = await this.books.purgeBook(request.principal, bookId, body);
        return { status: 202, body: { data: outcome } };
      },
    );
    return result.body;
  }

  @Get(':bookId/files')
  async listFiles(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    return this.books.listBookFiles(request.principal, bookId);
  }

  @Get(':bookId/files/:bookFileId')
  async getFile(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
    @Param('bookFileId') bookFileId: string,
  ): Promise<unknown> {
    return { data: await this.books.getBookFile(request.principal, bookId, bookFileId) };
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
  @HttpCode(200)
  async createTextAccessUrl(
    @Req() request: RequestWithPrincipal,
    @Param('bookId') bookId: string,
  ): Promise<unknown> {
    const accessUrl = await this.books.createTextAccessUrl(request.principal, bookId);
    return { data: accessUrl };
  }
}
