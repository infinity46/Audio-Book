import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from './msw/server';

/**
 * Test environment.
 *
 * MSW intercepts at the network layer, so components under test exercise the
 * **real** API client, the real error normalization, and the real query layer —
 * only the transport is faked. A test that passes here is testing the code that
 * ships, not a mock of it.
 *
 * `onUnhandledRequest: 'error'` is deliberate: a request no handler covers is a
 * test that is silently exercising a path nobody described, which is how a
 * contract drift hides.
 */
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  if (isDom) cleanup();
});

afterAll(() => {
  server.close();
});

/**
 * DOM shims below apply only under jsdom. Server-only modules (`proxy.ts`,
 * `session.ts`) run their suites under the `node` environment, where none of
 * these globals exist and none are needed.
 */
const isDom = typeof window !== 'undefined';

// jsdom implements neither of these, and both are used by the studio's
// virtualized lists and dialogs.
if (isDom && !('ResizeObserver' in globalThis)) {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}

if (isDom && typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  }
}

// jsdom's HTMLMediaElement has no playback implementation.
if (isDom) {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(),
  });
}
