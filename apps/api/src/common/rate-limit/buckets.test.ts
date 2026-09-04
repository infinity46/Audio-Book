import { describe, expect, it } from 'vitest';
import { resolveBucket } from './buckets.js';

/**
 * The bucket table in api-specification.md §14.3, asserted against real paths
 * from this API's own routes. The important property is total coverage: any
 * request resolves to some bucket, so no route is silently unlimited.
 */
describe('resolveBucket', () => {
  it('puts every read on the read bucket', () => {
    expect(resolveBucket('GET', '/api/v1/books')).toBe('read');
    expect(resolveBucket('GET', '/api/v1/books/b1/chapters')).toBe('read');
    expect(resolveBucket('GET', '/api/v1/books/b1/audio-chunks?limit=50')).toBe('read');
    expect(resolveBucket('HEAD', '/api/v1/books/b1')).toBe('read');
  });

  it('gives signed-URL minting its own bucket wherever it hangs off', () => {
    expect(resolveBucket('POST', '/api/v1/books/b1/text/access-urls')).toBe('access_url');
    expect(resolveBucket('POST', '/api/v1/books/b1/audio-chunks/c1/access-urls')).toBe('access_url');
    expect(resolveBucket('POST', '/api/v1/books/b1/audiobooks/a1/access-urls')).toBe('access_url');
    expect(resolveBucket('POST', '/api/v1/books/b1/chapter-audio/ca1/access-urls')).toBe(
      'access_url',
    );
  });

  it('routes upload-session traffic to the upload bucket', () => {
    expect(resolveBucket('POST', '/api/v1/books/b1/upload-sessions')).toBe('upload');
    expect(resolveBucket('POST', '/api/v1/books/b1/upload-sessions/s1/completion')).toBe('upload');
    expect(resolveBucket('DELETE', '/api/v1/books/b1/upload-sessions/s1')).toBe('upload');
  });

  it('routes pipeline starts to the expensive bucket', () => {
    expect(resolveBucket('POST', '/api/v1/books/b1/ingestion')).toBe('expensive');
    expect(resolveBucket('POST', '/api/v1/books/b1/analysis')).toBe('expensive');
    expect(resolveBucket('POST', '/api/v1/books/b1/director')).toBe('expensive');
    expect(resolveBucket('POST', '/api/v1/books/b1/tts')).toBe('expensive');
    expect(resolveBucket('POST', '/api/v1/books/b1/assembly')).toBe('expensive');
    expect(resolveBucket('POST', '/api/v1/voice-profile-versions/v1/previews')).toBe('expensive');
  });

  it('treats other mutations as ordinary writes', () => {
    expect(resolveBucket('POST', '/api/v1/books')).toBe('write');
    expect(resolveBucket('PATCH', '/api/v1/books/b1/characters/c1')).toBe('write');
    expect(resolveBucket('PUT', '/api/v1/books/b1/characters/c1/voice')).toBe('write');
    expect(resolveBucket('DELETE', '/api/v1/voice-profiles/v1')).toBe('write');
  });

  it('is unaffected by query strings and trailing slashes', () => {
    expect(resolveBucket('POST', '/api/v1/books/b1/text/access-urls/')).toBe('access_url');
    expect(resolveBucket('POST', '/api/v1/books/b1/ingestion?force=true')).toBe('expensive');
  });

  it('routes /auth/** to its own strictest bucket, even for POST', () => {
    expect(resolveBucket('POST', '/api/v1/auth/register')).toBe('auth');
    expect(resolveBucket('POST', '/api/v1/auth/login')).toBe('auth');
    expect(resolveBucket('POST', '/api/v1/auth/mfa')).toBe('auth');
    expect(resolveBucket('POST', '/api/v1/auth/refresh')).toBe('auth');
    expect(resolveBucket('POST', '/api/v1/auth/logout')).toBe('auth');
    expect(resolveBucket('POST', '/api/v1/auth/password-reset')).toBe('auth');
    expect(resolveBucket('POST', '/api/v1/auth/password-reset/confirm')).toBe('auth');
  });

  it('never returns undefined for an unrecognized route', () => {
    // A route nobody thought about must still land somewhere restrictive-ish,
    // never fall through unlimited.
    expect(resolveBucket('POST', '/api/v1/some/future/route')).toBe('write');
    expect(resolveBucket('GET', '/api/v1/some/future/route')).toBe('read');
  });
});
