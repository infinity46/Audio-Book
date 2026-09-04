/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The BFF proxy is the security boundary between the browser and the API.
 * These tests assert the four properties it exists to provide.
 */

const readSessionToken = vi.fn<() => Promise<string | null>>();

vi.mock('./session', () => ({
  readSessionToken: () => readSessionToken(),
}));

vi.mock('./env', () => ({
  serverConfig: () => ({
    apiBaseUrl: 'http://api.internal:3000',
    auth: { issuer: 'https://auth.local', audience: 'audiobook-api' },
    cookieSecure: false,
    publicOrigin: 'https://studio.example',
  }),
}));

const { proxyToApi } = await import('./proxy');

const fetchMock = vi.fn();

beforeEach(() => {
  readSessionToken.mockResolvedValue('the-bearer-token');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://studio.example/bff/${path}`, init);
}

describe('proxyToApi', () => {
  it('attaches the bearer server-side, so the browser never holds it', async () => {
    await proxyToApi(req('api/v1/books'), ['api', 'v1', 'books']);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Headers).get('authorization')).toBe('Bearer the-bearer-token');
  });

  it('refuses every path outside the public /api/v1 surface', async () => {
    // The API's internal, metrics, and dependency-health surfaces must not be
    // reachable through an authenticated proxy.
    for (const path of [
      ['internal', 'v1', 'test', 'cleanup-jobs'],
      ['metrics'],
      ['health', 'dependencies'],
      ['api', 'v2', 'books'],
    ]) {
      const response = await proxyToApi(req(path.join('/')), path);
      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('answers 401 in the API’s own envelope when there is no session', async () => {
    readSessionToken.mockResolvedValue(null);
    const response = await proxyToApi(req('api/v1/books'), ['api', 'v1', 'books']);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    // Same shape as the API, so the client has one error parser, not two.
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin write', async () => {
    const response = await proxyToApi(
      req('api/v1/books', { method: 'POST', headers: { origin: 'https://evil.example' } }),
      ['api', 'v1', 'books'],
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a same-origin write', async () => {
    await proxyToApi(
      req('api/v1/books', {
        method: 'POST',
        headers: { origin: 'https://studio.example', 'content-type': 'application/json' },
        body: '{}',
      }),
      ['api', 'v1', 'books'],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not origin-check safe methods, which cannot mutate anything', async () => {
    const response = await proxyToApi(
      req('api/v1/books', { headers: { origin: 'https://evil.example' } }),
      ['api', 'v1', 'books'],
    );
    expect(response.status).toBe(200);
  });

  it('forwards only the allowlisted request headers', async () => {
    await proxyToApi(
      req('api/v1/books/b1/tts', {
        method: 'POST',
        headers: {
          origin: 'https://studio.example',
          'content-type': 'application/json',
          'idempotency-key': 'key-1',
          cookie: 'audiobook_session=secret',
          'x-forwarded-for': '10.0.0.1',
        },
        body: '{}',
      }),
      ['api', 'v1', 'books', 'b1', 'tts'],
    );
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Headers;
    expect(headers.get('idempotency-key')).toBe('key-1');
    // The session cookie is exchanged for a bearer here; forwarding it upstream
    // would leak a credential the API has no use for.
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBeNull();
  });

  it('forwards Last-Event-ID so an SSE reconnect resumes', async () => {
    await proxyToApi(
      req('api/v1/books/b1/events', { headers: { 'last-event-id': '01J9ZEVT0043' } }),
      ['api', 'v1', 'books', 'b1', 'events'],
    );
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Headers;
    expect(headers.get('last-event-id')).toBe('01J9ZEVT0043');
  });

  it('never follows a redirect on the user’s behalf', async () => {
    // Following one would forward the bearer to wherever it points.
    await proxyToApi(req('api/v1/books'), ['api', 'v1', 'books']);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.redirect).toBe('manual');
  });

  it('never forwards Set-Cookie back to the browser', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'set-cookie': 'evil=1', 'content-type': 'application/json' },
      }),
    );
    const response = await proxyToApi(req('api/v1/books'), ['api', 'v1', 'books']);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('preserves the correlation headers a client should log', async () => {
    const response = await proxyToApi(req('api/v1/books'), ['api', 'v1', 'books']);
    expect(response.headers.get('x-request-id')).toBe('req-1');
  });

  it('turns an unreachable API into a 503 in the standard envelope', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const response = await proxyToApi(req('api/v1/books'), ['api', 'v1', 'books']);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('preserves the query string when proxying', async () => {
    await proxyToApi(
      new Request('https://studio.example/bff/api/v1/books?status=COMPLETED&limit=25'),
      ['api', 'v1', 'books'],
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://api.internal:3000/api/v1/books?status=COMPLETED&limit=25',
    );
  });
});
