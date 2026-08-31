/**
 * Real OCR engine (task follow-up to the UnavailableOcrProvider stub):
 * Tesseract via tesseract.js — matches context.md §23's stated OCR
 * baseline ("Tesseract baseline, with a pluggable OCR interface") and runs
 * as pure JS/WASM, so it needs no native binary in the Node worker-cpu
 * runtime (unlike a native Tesseract binding).
 *
 * Language data: tesseract.js fetches trained-data files over the network
 * on first use unless `langPath` points to a local directory. For a
 * self-hosted, network-averse deployment, set `langPath` to a directory
 * baked into the worker image (infra/docker/worker-cpu.Dockerfile
 * pre-fetches the configured default languages at build time) so no
 * runtime network call is made — this is the "no silent fallback" /
 * explicit-configuration point (task §29/§128): if `langPath` is unset,
 * that's a deliberate choice to allow the network fetch, not an oversight.
 */
import { createWorker, type Worker } from 'tesseract.js';
import type { OCRProvider, OcrPageInput, OcrPageResult } from './ocr-provider.js';

const TESSERACT_JS_VERSION = '5.1.1';

export interface TesseractOcrProviderOptions {
  /** BCP-47-ish / tesseract language code(s), e.g. "eng" or "eng+fra". */
  language: string;
  /** Local directory containing pre-fetched *.traineddata(.gz) files; omit to allow tesseract.js's default network fetch. */
  langPath?: string;
}

export class TesseractOcrProvider implements OCRProvider {
  readonly identity: { providerId: string; modelId: string; version: string };
  private readonly options: TesseractOcrProviderOptions;
  private workerPromise: Promise<Worker> | null = null;

  constructor(options: TesseractOcrProviderOptions) {
    this.options = options;
    this.identity = {
      providerId: 'tesseract.js',
      modelId: `tesseract-${options.language}`,
      version: TESSERACT_JS_VERSION,
    };
  }

  private async getWorker(): Promise<Worker> {
    this.workerPromise ??= createWorker(this.options.language, undefined, {
      langPath: this.options.langPath,
    });
    return this.workerPromise;
  }

  async ocrPage(input: OcrPageInput): Promise<OcrPageResult> {
    // The worker's language is fixed at construction time (this.options.language);
    // per-call `input.language` is not used to switch languages mid-flight, so the
    // result always reports the language the worker was actually configured with —
    // never echoing back a request that may not match what actually ran.
    const worker = await this.getWorker();
    const { data } = await worker.recognize(input.image);
    return {
      text: data.text,
      // tesseract.js reports confidence on a 0-100 scale; the rest of this
      // codebase (ParsedPage.confidence, OcrPageResult) uses 0..1.
      confidence: data.confidence / 100,
      engine: 'tesseract',
      engineVersion: data.version,
      language: this.options.language,
    };
  }

  /** Releases the underlying WASM worker/thread — call once on process shutdown. */
  async terminate(): Promise<void> {
    if (!this.workerPromise) return;
    const worker = await this.workerPromise;
    await worker.terminate();
    this.workerPromise = null;
  }
}
