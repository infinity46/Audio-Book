import { describe, expect, it, vi } from 'vitest';
import { MalformedRequestError } from '@audio-book/errors';
import { AssemblyController } from './assembly.controller.js';

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: [], scopes: [] };

function makeController() {
  const assembly = {
    startAssembly: vi.fn(() => Promise.resolve({ accepted: { scope: 'AUDIOBOOK' } })),
    getAssemblyState: vi.fn(() => Promise.resolve({ object: 'assembly_state' })),
    listChapterAudio: vi.fn(() => Promise.resolve({ data: [], page: {} })),
    getChapterAudio: vi.fn(() => Promise.resolve({ id: 'ca-1' })),
    createChapterAudioAccessUrl: vi.fn(() => Promise.resolve({ object: 'access_url' })),
    getAudiobookProject: vi.fn(() => Promise.resolve({ object: 'audiobook_project' })),
    listAudiobooks: vi.fn(() => Promise.resolve({ data: [], page: {} })),
    getAudiobook: vi.fn(() => Promise.resolve({ id: 'ab-1' })),
    updateAudiobookMetadata: vi.fn(() => Promise.resolve({ id: 'ab-1' })),
    putAudiobookCover: vi.fn(() =>
      Promise.resolve({ status: 201, body: { object: 'audiobook_cover_upload_session' } }),
    ),
    createAudiobookAccessUrl: vi.fn(() => Promise.resolve({ object: 'access_url' })),
  };
  const idempotency = {
    run: vi.fn(async (_params: unknown, handler: () => Promise<{ status: number; body: unknown }>) => {
      const result = await handler();
      return result;
    }),
  };
  const controller = new AssemblyController(assembly as never, idempotency as never);
  return { controller, assembly, idempotency };
}

describe('AssemblyController', () => {
  it('startAssembly requires an Idempotency-Key header', async () => {
    const { controller } = makeController();
    const request = { principal } as never;
    await expect(
      controller.startAssembly(request, 'book-1', undefined, { scope: 'AUDIOBOOK' } as never),
    ).rejects.toThrow(MalformedRequestError);
  });

  it('startAssembly runs through IdempotencyService and returns its body', async () => {
    const { controller, assembly, idempotency } = makeController();
    const request = { principal } as never;
    const result = await controller.startAssembly(request, 'book-1', 'idem-key-1', {
      scope: 'AUDIOBOOK',
    } as never);
    expect(idempotency.run).toHaveBeenCalledTimes(1);
    expect(assembly.startAssembly).toHaveBeenCalledWith(principal, 'book-1', { scope: 'AUDIOBOOK' });
    expect(result).toEqual({ data: { accepted: { scope: 'AUDIOBOOK' } } });
  });

  it('getAssemblyState wraps the service result in { data }', async () => {
    const { controller, assembly } = makeController();
    const request = { principal } as never;
    const result = await controller.getAssemblyState(request, 'book-1');
    expect(assembly.getAssemblyState).toHaveBeenCalledWith(principal, 'book-1');
    expect(result).toEqual({ data: { object: 'assembly_state' } });
  });

  it('putAudiobookCover sets the reply status from the service result', async () => {
    const { controller, assembly } = makeController();
    const request = { principal } as never;
    const reply = { status: vi.fn() };
    const result = await controller.putAudiobookCover(
      request,
      reply as never,
      'book-1',
      'ab-1',
      { declared_mime_type: 'image/png', declared_size_bytes: 1000, declared_content_hash: { algorithm: 'SHA256', value: 'h'.repeat(64) } } as never,
    );
    expect(assembly.putAudiobookCover).toHaveBeenCalledWith(principal, 'book-1', 'ab-1', expect.any(Object));
    expect(reply.status).toHaveBeenCalledWith(201);
    expect(result).toEqual({ data: { object: 'audiobook_cover_upload_session' } });
  });

  it('createAudiobookAccessUrl wraps the service result in { data }', async () => {
    const { controller, assembly } = makeController();
    const request = { principal } as never;
    const result = await controller.createAudiobookAccessUrl(request, 'book-1', 'ab-1', {});
    expect(assembly.createAudiobookAccessUrl).toHaveBeenCalledWith(principal, 'book-1', 'ab-1', {});
    expect(result).toEqual({ data: { object: 'access_url' } });
  });
});
