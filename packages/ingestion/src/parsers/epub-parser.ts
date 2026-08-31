/**
 * EPUB adapter: a dedicated reader over the spine/manifest (task §23/§73)
 * rather than converting to PDF or re-inferring structure the format
 * already states. EPUB is a ZIP container and therefore untrusted-archive
 * input — every entry is validated before it is ever decompressed
 * (path traversal, per-entry and cumulative decompressed-size caps, entry
 * count cap) per task §73/§105.
 */
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { Parser as HtmlParser } from 'htmlparser2';
import yauzl from 'yauzl';
import { CorruptedFileError, FileTooLargeError, SecurityViolationError } from '../errors.js';
import type { ExtractedBlock, ExtractedDocument, ParserIdentity } from '../model.js';
import type { DocumentParser, DocumentParserInput } from './parser.js';

const PARSER_IDENTITY: ParserIdentity = {
  providerId: 'audio-book-epub-reader',
  modelId: 'epub-spine-reader',
  version: '1.0.0',
};

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'li',
  'dt',
  'dd',
]);

export class EpubParser implements DocumentParser {
  readonly identity = PARSER_IDENTITY;

  async parse(input: DocumentParserInput): Promise<ExtractedDocument> {
    const zip = await openZip(input.buffer);
    const entries = await listEntries(zip, input.config);

    const containerXml = await readEntry(zip, entries, 'META-INF/container.xml', input.config);
    const opfPath = parseContainerXml(containerXml);

    const opfXml = await readEntry(zip, entries, opfPath, input.config);
    const { manifest, spine, title, language } = parseOpf(opfXml, opfPath);

    if (spine.length === 0) {
      throw new CorruptedFileError({ message: 'EPUB spine is empty or missing.' });
    }

    const blocks: ExtractedBlock[] = [];
    let order = 0;

    for (let spineIndex = 0; spineIndex < spine.length; spineIndex += 1) {
      const idref = spine[spineIndex]!;
      const href = manifest.get(idref);
      if (!href) continue; // spine references a manifest item that doesn't exist — skip, don't fabricate.

      const resolvedPath = resolveManifestPath(opfPath, href);
      const xhtml = await readEntry(zip, entries, resolvedPath, input.config);
      const spineBlocks = extractBlocksFromXhtml(xhtml, spineIndex);
      for (const block of spineBlocks) {
        blocks.push({ ...block, order: order++ });
      }
    }

    zip.close();

    return {
      sourceKind: 'EPUB',
      blocks,
      parserIdentity: this.identity,
      metadata: { title, language },
    };
  }
}

// ---- ZIP handling (yauzl, promisified, with security guards) ----

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries: false — yauzl fires 'entry' for the whole central
    // directory up front (cheap; no decompression happens here), and the
    // returned Entry objects remain valid for `openReadStream` at any time
    // afterward, which is what lets us do random-access-by-name below.
    yauzl.fromBuffer(buffer, { lazyEntries: false, decodeStrings: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new CorruptedFileError({ message: 'EPUB is not a valid ZIP archive.', cause: err }));
        return;
      }
      resolve(zipfile);
    });
  });
}

/**
 * Walks the central directory once, validating every entry name and
 * tallying declared sizes against the configured caps BEFORE anything is
 * decompressed — the zip-bomb and path-traversal guard (task §73/§105).
 */
function listEntries(
  zip: yauzl.ZipFile,
  config: DocumentParserInput['config'],
): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    let count = 0;
    let cumulativeUncompressed = 0;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      zip.removeAllListeners();
      zip.close();
      reject(err);
    };

    zip.on('entry', (entry: yauzl.Entry) => {
      if (settled) return;
      count += 1;
      if (count > config.maxEpubEntryCount) {
        fail(
          new SecurityViolationError({
            message: `EPUB has more than ${config.maxEpubEntryCount} entries.`,
          }),
        );
        return;
      }

      if (!isSafeEntryName(entry.fileName)) {
        fail(new SecurityViolationError({ message: `Unsafe EPUB entry name: ${entry.fileName}` }));
        return;
      }

      // Unix symlink bit (S_IFLNK = 0xA000) in the upper 16 bits of external attrs.
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (unixMode === 0xa000) {
        fail(new SecurityViolationError({ message: `EPUB entry is a symlink: ${entry.fileName}` }));
        return;
      }

      if (entry.uncompressedSize > config.maxEpubEntryUncompressedBytes) {
        fail(
          new FileTooLargeError({
            message: `EPUB entry ${entry.fileName} exceeds the per-entry size limit.`,
          }),
        );
        return;
      }

      cumulativeUncompressed += entry.uncompressedSize;
      if (cumulativeUncompressed > config.maxEpubUncompressedBytes) {
        fail(new FileTooLargeError({ message: 'EPUB exceeds the total decompressed-size limit.' }));
        return;
      }

      entries.set(entry.fileName, entry);
    });

    zip.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(entries);
      }
    });

    zip.on('error', (err) =>
      fail(new CorruptedFileError({ message: 'Error reading EPUB archive.', cause: err })),
    );
  });
}

function isSafeEntryName(fileName: string): boolean {
  if (fileName.length === 0) return false;
  if (fileName.startsWith('/') || fileName.startsWith('\\')) return false;
  const normalized = path.posix.normalize(fileName);
  if (normalized.startsWith('..') || normalized.includes('../')) return false;
  return true;
}

/**
 * Streams one named entry's decompressed bytes into memory. Bounded by the
 * entry's own declared size (already validated in listEntries) plus a hard
 * runtime abort as defense-in-depth against a header that lies about its
 * own size (task §73's zip-bomb guard applying to the actual byte stream,
 * not just the declared metadata).
 */
function readEntry(
  zip: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>,
  fileName: string,
  config: DocumentParserInput['config'],
): Promise<string> {
  const entry = entries.get(fileName);
  if (!entry) {
    throw new CorruptedFileError({ message: `EPUB is missing required entry: ${fileName}` });
  }

  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(
          new CorruptedFileError({ message: `Could not read EPUB entry: ${fileName}`, cause: err }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > config.maxEpubEntryUncompressedBytes) {
          stream.destroy();
          reject(
            new SecurityViolationError({
              message: `EPUB entry ${fileName} decompressed beyond its declared size limit.`,
            }),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', (streamErr) =>
        reject(
          new CorruptedFileError({
            message: `Error streaming EPUB entry: ${fileName}`,
            cause: streamErr,
          }),
        ),
      );
    });
  });
}

// ---- XML/OPF parsing ----

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // fast-xml-parser has no DTD/external-entity resolution at all (XXE-safe by omission).
});

function parseContainerXml(xml: string): string {
  const parsed = xmlParser.parse(xml) as {
    container?: {
      rootfiles?: { rootfile?: { '@_full-path'?: string } | { '@_full-path'?: string }[] };
    };
  };
  const rootfile = parsed.container?.rootfiles?.rootfile;
  const entry = Array.isArray(rootfile) ? rootfile[0] : rootfile;
  const fullPath = entry?.['@_full-path'];
  if (!fullPath) {
    throw new CorruptedFileError({ message: 'EPUB container.xml is missing a rootfile.' });
  }
  return fullPath;
}

interface OpfManifestItem {
  '@_id': string;
  '@_href': string;
}

interface OpfSpineItem {
  '@_idref': string;
}

function parseOpf(
  xml: string,
  opfPath: string,
): { manifest: Map<string, string>; spine: string[]; title?: string; language?: string } {
  const parsed = xmlParser.parse(xml) as {
    package?: {
      metadata?: {
        'dc:title'?: string | { '#text': string };
        'dc:language'?: string | { '#text': string };
      };
      manifest?: { item?: OpfManifestItem | OpfManifestItem[] };
      spine?: { itemref?: OpfSpineItem | OpfSpineItem[] };
    };
  };

  const pkg = parsed.package;
  if (!pkg) {
    throw new CorruptedFileError({
      message: `EPUB OPF at ${opfPath} is not a valid package document.`,
    });
  }

  const items = pkg.manifest?.item;
  const itemList = Array.isArray(items) ? items : items ? [items] : [];
  const manifest = new Map<string, string>();
  for (const item of itemList) {
    if (item['@_id'] && item['@_href']) manifest.set(item['@_id'], item['@_href']);
  }

  const itemrefs = pkg.spine?.itemref;
  const itemrefList = Array.isArray(itemrefs) ? itemrefs : itemrefs ? [itemrefs] : [];
  const spine = itemrefList
    .map((ref) => ref['@_idref'])
    .filter((idref): idref is string => Boolean(idref));

  return {
    manifest,
    spine,
    title: textOf(pkg.metadata?.['dc:title']),
    language: textOf(pkg.metadata?.['dc:language']),
  };
}

function textOf(value: string | { '#text': string } | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value['#text'];
}

function resolveManifestPath(opfPath: string, href: string): string {
  const dir = path.posix.dirname(opfPath);
  const resolved = path.posix.normalize(path.posix.join(dir, decodeURIComponent(href)));
  if (resolved.startsWith('..')) {
    throw new SecurityViolationError({
      message: `EPUB manifest href escapes the archive: ${href}`,
    });
  }
  return resolved;
}

// ---- XHTML block extraction ----

function extractBlocksFromXhtml(xhtml: string, spineIndex: number): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  const tagCounts = new Map<string, number>();
  let charOffset = 0;

  let currentTag: string | null = null;
  let currentText = '';
  let skipDepth = 0;

  const parser = new HtmlParser(
    {
      onopentag(name) {
        if (name === 'script' || name === 'style') {
          skipDepth += 1;
          return;
        }
        if (skipDepth > 0) return;
        if (BLOCK_TAGS.has(name)) {
          currentTag = name;
          currentText = '';
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        if (currentTag) currentText += text;
      },
      onclosetag(name) {
        if (name === 'script' || name === 'style') {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (skipDepth > 0) return;
        if (currentTag === name) {
          const text = currentText.replace(/\s+/g, ' ').trim();
          if (text.length > 0) {
            const count = (tagCounts.get(name) ?? 0) + 1;
            tagCounts.set(name, count);
            const headingLevel = /^h[1-6]$/.test(name) ? Number(name[1]) : undefined;
            blocks.push({
              order: 0, // reassigned by the caller across the whole document
              type: headingLevel
                ? 'HEADING'
                : name === 'blockquote'
                  ? 'BLOCKQUOTE'
                  : name === 'li'
                    ? 'LIST_ITEM'
                    : 'PARAGRAPH',
              text,
              headingLevel,
              locator: { kind: 'epub', spineIndex, xpath: `/${name}[${count}]`, charOffset },
              extractionMethod: 'EPUB_SPINE',
            });
            charOffset += text.length + 1;
          }
          currentTag = null;
          currentText = '';
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );

  parser.write(xhtml);
  parser.end();

  return blocks;
}
