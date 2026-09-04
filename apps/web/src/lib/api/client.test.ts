import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import { apiError } from '@/test/msw/handlers';
import { ApiError, NetworkError } from './errors';
import { buildPath, getAllPages, getOne, getPage, newIdempotencyKey, post, request } from './client';

const BASE = '/bff/api/v1';

/**
 * The status matrix rule 132 asks for, exercised against the **real** client
 * with only the transport faked. Each case asserts the behaviour the error
 * contract specifies, not merely that an error was thrown.
 */
describe('request — status handling', () => {
  const cases: {
    status: number;
    code: string;
    retryable: boolean;
    note: string;
  }[] = [
    { status: 400, code: 'MALFORMED_REQUEST', retryable: false, note: 'never retry unchanged' },
    { status: 401, code: 'UNAUTHENTICATED', retryable: false, note: 're-authenticate' },
    { status: 403, code: 'FORBIDDEN', retryable: false, note: 'do not retry' },
    { status: 404, code: 'BOOK_NOT_FOUND', retryable: false, note: 'may be a tenant boundary' },
    { status: 409, code: 'CASTING_INCOMPLETE', retryable: false, note: 'fix the cause first' },
    { status: 422, code: 'VALIDATION_FAILED', retryable: false, note: 'read details[]' },
    { status: 429, code: 'QUOTA_EXCEEDED', retryable: false, note: 'retrying will not help' },
  ];

  for (const testCase of cases) {
    it(`surfaces ${testCase.status} ${testCase.code} without retrying (${testCase.note})`, async () => {
      const hits = vi.fn();
      server.use(
        http.get(`${BASE}/books`, () => {
          hits();
          return apiError(testCase.status, testCase.code, 'nope', { retryable: testCase.retryable });
        }),
      );

      await expect(getPage('/api/v1/books')).rejects.toMatchObject({
        status: testCase.status,
        code: testCase.code,
      });
      expect(hits).toHaveBeenCalledTimes(1);
    });
  }

  it('retries a retryable 503 on a safe method and succeeds', async () => {
    let attempts = 0;
    server.use(
      http.get(`${BASE}/books`, () => {
        attempts += 1;
        if (attempts < 3) {
          return apiError(503, 'STORAGE_UNAVAILABLE', 'Try later.', { retryable: true });
        }
        return HttpResponse.json({ data: [], page: { limit: 25, has_more: false, next_cursor: null, prev_cursor: null, total: null } });
      }),
    );

    const page = await getPage('/api/v1/books');
    expect(page.data).toEqual([]);
    expect(attempts).toBe(3);
  });

  it('never retries a POST, even a retryable one', async () => {
    // Rule 78: repeating an expensive generation command on the client's own
    // initiative is exactly what must not happen.
    const hits = vi.fn();
    server.use(
      http.post(`${BASE}/books/b1/tts`, () => {
        hits();
        return apiError(503, 'QUEUE_UNAVAILABLE', 'Try later.', { retryable: true });
      }),
    );

    await expect(post('/api/v1/books/b1/tts', { body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(hits).toHaveBeenCalledTimes(1);
  });

  it('reports a transport failure as a NetworkError, not an ApiError', async () => {
    server.use(http.get(`${BASE}/books`, () => HttpResponse.error()));
    await expect(getPage('/api/v1/books')).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns 204 responses without trying to parse a body', async () => {
    server.use(http.delete(`${BASE}/books/b1`, () => new HttpResponse(null, { status: 204 })));
    const response = await request('/api/v1/books/b1', { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(response.data).toBeNull();
  });
});

describe('request — headers', () => {
  it('sends Idempotency-Key when given, and never invents one', async () => {
    let seen: string | null = null;
    let seenOnGet: string | null = 'unset';
    server.use(
      http.post(`${BASE}/books`, ({ request: req }) => {
        seen = req.headers.get('idempotency-key');
        return HttpResponse.json({ data: { id: 'b1' } }, { status: 201 });
      }),
      http.get(`${BASE}/books`, ({ request: req }) => {
        seenOnGet = req.headers.get('idempotency-key');
        return HttpResponse.json({ data: [], page: { limit: 25, has_more: false, next_cursor: null, prev_cursor: null, total: null } });
      }),
    );

    await post('/api/v1/books', { body: { title: 'x' }, idempotencyKey: 'key-1' });
    expect(seen).toBe('key-1');

    await getPage('/api/v1/books');
    expect(seenOnGet).toBeNull();
  });

  it('sends If-Match for optimistic concurrency when an ETag is held', async () => {
    let seen: string | null = null;
    server.use(
      http.patch(`${BASE}/books/b1`, ({ request: req }) => {
        seen = req.headers.get('if-match');
        return HttpResponse.json({ data: { id: 'b1' } });
      }),
    );
    await request('/api/v1/books/b1', { method: 'PATCH', body: {}, ifMatch: '"9f2c"' });
    expect(seen).toBe('"9f2c"');
  });

  it('exposes the ETag so a later write can send it back', async () => {
    server.use(
      http.get(`${BASE}/books/b1`, () =>
        HttpResponse.json({ data: { id: 'b1' } }, { headers: { etag: '"abc"' } }),
      ),
    );
    const response = await request('/api/v1/books/b1');
    expect(response.etag).toBe('"abc"');
  });
});

describe('pagination helpers', () => {
  it('walks next_cursor to completion', async () => {
    server.use(
      http.get(`${BASE}/books/b1/chapters`, ({ request: req }) => {
        const cursor = new URL(req.url).searchParams.get('cursor');
        if (!cursor) {
          return HttpResponse.json({
            data: [{ id: 'c1' }],
            page: { limit: 100, has_more: true, next_cursor: 'CURSOR-2', prev_cursor: null, total: null },
          });
        }
        return HttpResponse.json({
          data: [{ id: 'c2' }],
          page: { limit: 100, has_more: false, next_cursor: null, prev_cursor: null, total: null },
        });
      }),
    );

    const all = await getAllPages<{ id: string }>('/api/v1/books/b1/chapters');
    expect(all.map((row) => row.id)).toEqual(['c1', 'c2']);
  });

  it('stops at maxPages so a runaway cursor cannot pin the browser', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/books/b1/chapters`, () => {
        calls += 1;
        // A server that always claims another page.
        return HttpResponse.json({
          data: [{ id: `c${calls}` }],
          page: { limit: 100, has_more: true, next_cursor: `CURSOR-${calls}`, prev_cursor: null, total: null },
        });
      }),
    );

    const all = await getAllPages<{ id: string }>('/api/v1/books/b1/chapters', { maxPages: 3 });
    expect(all).toHaveLength(3);
    expect(calls).toBe(3);
  });
});

describe('buildPath', () => {
  it('omits empty, null, and undefined parameters instead of sending blanks', () => {
    expect(
      buildPath('/api/v1/books', { status: 'COMPLETED', cursor: undefined, q: '', limit: 25 }),
    ).toBe('/api/v1/books?status=COMPLETED&limit=25');
  });

  it('leaves a path without query parameters untouched', () => {
    expect(buildPath('/api/v1/books')).toBe('/api/v1/books');
  });
});

describe('newIdempotencyKey', () => {
  it('produces distinct UUID-shaped keys', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('getOne', () => {
  it('unwraps the { data } envelope', async () => {
    const capabilities = await getOne<{ object: string }>('/api/v1/capabilities');
    expect(capabilities.object).toBe('capabilities');
  });
});
