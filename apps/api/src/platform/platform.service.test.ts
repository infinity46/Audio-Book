import { describe, expect, it, vi } from 'vitest';
import { DeliveryFormat, DeliveryMode, Emotion } from '@audio-book/database';
import {
  DELIVERY_FORMATS,
  DELIVERY_MODE_VOCABULARY,
  EMOTION_VOCABULARY,
  PlatformService,
} from './platform.service.js';

/**
 * `GET /capabilities` exists so clients stop hard-coding vocabularies. That
 * only helps if the list it serves is the same one the database enforces — a
 * client rendering an emotion picker from a stale list offers a value the
 * Director will reject.
 *
 * These assertions turn that drift into a test failure at build time rather
 * than a `422` in production. They are the reason the literal lists in
 * `platform.service.ts` are safe to keep as literals.
 */
describe('capabilities vocabularies match the database enums exactly', () => {
  it('emotion', () => {
    expect([...EMOTION_VOCABULARY].sort()).toEqual(Object.values(Emotion).sort());
  });

  it('delivery mode', () => {
    expect([...DELIVERY_MODE_VOCABULARY].sort()).toEqual(Object.values(DeliveryMode).sort());
  });

  it('delivery format', () => {
    expect([...DELIVERY_FORMATS].sort()).toEqual(Object.values(DeliveryFormat).sort());
  });
});

function makeService(overrides: { workers?: number; ttsModels?: unknown[] } = {}) {
  const prisma = {
    modelVersion: {
      findMany: vi.fn((_args: { where: { deprecatedAt: unknown } }) =>
        Promise.resolve(overrides.ttsModels ?? ([] as unknown[])),
      ),
    },
    worker: { count: vi.fn(() => Promise.resolve(overrides.workers ?? 0)) },
  };
  const config = { http: { bodySizeLimitBytes: 512_000 } };
  return { service: new PlatformService(prisma as never, config as never), prisma };
}

describe('PlatformService.getCapabilities', () => {
  it('reports availability as unknown and degraded when no worker has registered', async () => {
    const { service } = makeService({
      workers: 0,
      ttsModels: [
        {
          id: 'mv-1',
          version: '1.0.0',
          config: null,
          modelRegistry: { providerId: 'kokoro', modelId: 'kokoro-82m', role: 'TTS' },
        },
      ],
    });
    const caps = await service.getCapabilities();

    // QA finding F-26: `worker` has no writer, so nothing can truthfully say a
    // provider is available. `available: true` here would be fabricated.
    expect(caps.degraded).toBe(true);
    expect(caps.degraded_reasons).toContain('WORKER_CAPABILITY_REGISTRY_UNAVAILABLE');
    expect(caps.tts_providers[0]?.available).toBeNull();
  });

  it('reports availability once workers are registered', async () => {
    const { service } = makeService({
      workers: 3,
      ttsModels: [
        {
          id: 'mv-1',
          version: '1.0.0',
          config: { supports_reference_audio: true },
          modelRegistry: { providerId: 'kokoro', modelId: 'kokoro-82m', role: 'TTS' },
        },
      ],
    });
    const caps = await service.getCapabilities();

    expect(caps.degraded).toBe(false);
    expect(caps.tts_providers[0]?.available).toBe(true);
    // Forwarded verbatim, not defaulted: an unregistered capability must read
    // as absent rather than as false.
    expect(caps.tts_providers[0]?.capabilities).toEqual({ supports_reference_audio: true });
  });

  it('never exposes fleet detail', async () => {
    const { service } = makeService({ workers: 7 });
    const caps = JSON.stringify(await service.getCapabilities());

    // §16.21: "worker counts, hostnames, VRAM, queue depths, GPU models,
    // model weights locations ... are operator metrics", not client data.
    for (const forbidden of ['worker_count', 'hostname', 'vram', 'queue_depth', 'weights']) {
      expect(caps).not.toContain(forbidden);
    }
    expect(caps).not.toContain('"7"');
  });

  it('serves the closed vocabularies a UI needs to render pickers', async () => {
    const { service } = makeService();
    const caps = await service.getCapabilities();

    expect(caps.vocabularies.emotion).toEqual([...EMOTION_VOCABULARY]);
    expect(caps.vocabularies.delivery_mode).toEqual([...DELIVERY_MODE_VOCABULARY]);
    expect(caps.delivery_formats).toEqual([...DELIVERY_FORMATS]);
  });

  it('does not advertise a multipart threshold, because there is no multipart path', async () => {
    const { service } = makeService();
    const caps = await service.getCapabilities();
    // Advertising a threshold would describe a protocol this API does not
    // implement — the upload flow mints a single PUT target.
    expect(caps.upload.multipart_threshold_bytes).toBeNull();
  });
});

describe('PlatformService.listModelVersions', () => {
  it('rejects an unknown role rather than passing it to Postgres', async () => {
    const { service } = makeService();
    await expect(service.listModelVersions({ role: 'ORACLE' })).rejects.toThrow();
  });

  it('hides deprecated entries from the public listing', async () => {
    const { service, prisma } = makeService();
    await service.listModelVersions({});
    const call = prisma.modelVersion.findMany.mock.calls.at(-1)?.[0];
    expect(call?.where.deprecatedAt).toBeNull();
  });

  it('omits weights locations from the model version resource', async () => {
    const { service, prisma } = makeService();
    prisma.modelVersion.findMany.mockResolvedValueOnce([
      {
        id: 'mv-1',
        version: '1.0.0',
        paramsFingerprint: 'a'.repeat(64),
        releasedAt: new Date(),
        deprecatedAt: null,
        quarantinedAt: null,
        createdAt: new Date(),
        weightsStorageKey: 'tenant/secret/weights.bin',
        weightsContentHash: 'b'.repeat(64),
        modelRegistry: {
          role: 'TTS',
          providerId: 'kokoro',
          modelId: 'kokoro-82m',
          displayName: 'Kokoro',
        },
      },
    ]);
    const page = await service.listModelVersions({});
    const serialized = JSON.stringify(page);

    // §14.9 / §3 rule 3: no public response names an object-storage location.
    expect(serialized).not.toContain('weights.bin');
    expect(serialized).not.toContain('weights_storage_key');
    // The reproducibility handle a client legitimately needs is still there.
    expect(page.data[0]?.params_fingerprint).toBe('a'.repeat(64));
  });
});
