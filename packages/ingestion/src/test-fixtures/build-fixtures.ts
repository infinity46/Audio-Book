/**
 * Synthetic, public-domain-style fixture builders for ingestion tests
 * (task §99: "do not commit copyrighted full books" — nothing here is a
 * real book, everything is generated at test time).
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { ZipFile } from 'yazl';

const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 600;
const BODY_SIZE = 12;
const HEADING_SIZE = 20;
const LINE_HEIGHT = 16;
const MARGIN_TOP = PAGE_HEIGHT - 40;

interface PageSpec {
  header?: string;
  footer?: string;
  lines: Array<{ text: string; heading?: boolean }>;
}

async function buildPdf(pages: PageSpec[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const spec of pages) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = MARGIN_TOP;

    if (spec.header) {
      page.drawText(spec.header, {
        x: 20,
        y: PAGE_HEIGHT - 20,
        size: 9,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }

    for (const line of spec.lines) {
      const size = line.heading ? HEADING_SIZE : BODY_SIZE;
      page.drawText(line.text, { x: 20, y, size, font });
      y -= line.heading ? LINE_HEIGHT * 1.8 : LINE_HEIGHT;
    }

    if (spec.footer) {
      page.drawText(spec.footer, {
        x: PAGE_WIDTH / 2 - 5,
        y: 20,
        size: 9,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/** A short multi-chapter text PDF (fixture #1). */
export function buildSimpleMultiChapterPdf(): Promise<Buffer> {
  return buildPdf([
    {
      lines: [
        { text: 'Chapter 1', heading: true },
        { text: 'It was a bright cold day in the story, and the clocks' },
        { text: 'were striking thirteen in the distance.' },
        { text: '' },
        { text: 'She walked through the door without looking back at all.' },
      ],
    },
    {
      lines: [
        { text: 'Chapter 2', heading: true },
        { text: 'The second chapter begins here, quite differently than' },
        { text: 'the first one ever did, with new characters arriving.' },
      ],
    },
  ]);
}

/** A PDF with a repeated header/footer and page numbers across many pages (fixture #2). */
export function buildPdfWithRepeatedHeaderFooter(): Promise<Buffer> {
  const pages: PageSpec[] = [];
  for (let i = 1; i <= 6; i += 1) {
    pages.push({
      header: 'THE GREAT BOOK',
      footer: String(i),
      lines:
        i === 1
          ? [
              { text: 'Chapter 1', heading: true },
              { text: `This is the narrative content of page ${i}.` },
            ]
          : [{ text: `This is the narrative content of page ${i}, continuing the story onward.` }],
    });
  }
  return buildPdf(pages);
}

/** A PDF containing a hard line-break hyphenation to exercise dehyphenation (fixture #3). */
export function buildHyphenatedPdf(): Promise<Buffer> {
  return buildPdf([
    {
      lines: [
        { text: 'Chapter 1', heading: true },
        { text: 'It was truly an extra-' },
        { text: 'ordinary afternoon in the valley below the hills.' },
      ],
    },
  ]);
}

/** A PDF with dialogue/quotation punctuation (fixture #8). */
export function buildDialoguePdf(): Promise<Buffer> {
  return buildPdf([
    {
      lines: [
        { text: 'Chapter 1', heading: true },
        { text: '“Hello,” she said, “is anyone home?”' },
        { text: 'No one answered — the house was silent.' },
      ],
    },
  ]);
}

/** A truncated/malformed PDF (fixture #7). */
export function buildMalformedPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< this is not valid pdf content');
}

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** A page with only an embedded raster image and no text — simulates a scanned page (task #26/#50). */
export async function buildScannedLookingPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(Buffer.from(MINIMAL_PNG_BASE64, 'base64'));
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawImage(png, { x: 20, y: 20, width: 300, height: 400 });
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/** Renders `text` onto a plain white raster image — the shared building block for OCR fixtures. */
export function renderTextImage(text: string, width = 800, height = 200, fontSize = 40): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'black';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillText(text, 20, Math.round(height / 2));
  return canvas.toBuffer('image/png');
}

/** A "scanned" page: an image containing real, OCR-readable text, with no PDF text layer at all. */
export async function buildScannedPdfWithText(
  text = 'This page was scanned from paper.',
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const png = renderTextImage(text, 800, 300, 40);
  const embedded = await doc.embedPng(png);
  const page = doc.addPage([800, 300]);
  page.drawImage(embedded, { x: 0, y: 0, width: 800, height: 300 });
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/** A standalone PNG image with OCR-readable text — fixture for ImageParser tests. */
export function buildImageWithText(text = 'Chapter One of a scanned book.'): Buffer {
  return renderTextImage(text, 800, 200, 40);
}

/** A file with a PNG magic-byte-like extension but garbage bytes — not decodable. */
export function buildCorruptedImage(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
}

// ---- EPUB fixtures ----

interface EpubChapter {
  id: string;
  fileName: string;
  title: string;
  paragraphs: string[];
}

async function buildEpub(chapters: EpubChapter[], epubVersion: '2.0' | '3.0'): Promise<Buffer> {
  const zip = new ZipFile();

  // `mimetype` must be the first entry, stored uncompressed, for EPUB sniffing.
  zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });

  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  zip.addBuffer(Buffer.from(containerXml), 'META-INF/container.xml');

  const manifestItems = chapters
    .map((c) => `<item id="${c.id}" href="${c.fileName}" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spineItems = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n');
  const navItem =
    epubVersion === '3.0'
      ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
      : '';

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${epubVersion}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Synthetic Test Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:test-fixture</dc:identifier>
  </metadata>
  <manifest>
    ${manifestItems}
    ${navItem}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;
  zip.addBuffer(Buffer.from(opf), 'OEBPS/content.opf');

  if (epubVersion === '3.0') {
    const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>${chapters.map((c) => `<li><a href="${c.fileName}">${c.title}</a></li>`).join('')}</ol></nav></body>
</html>`;
    zip.addBuffer(Buffer.from(nav), 'OEBPS/nav.xhtml');
  }

  for (const chapter of chapters) {
    const body = chapter.paragraphs.map((p) => `<p>${p}</p>`).join('\n');
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>${chapter.title}</h1>
    ${body}
  </body>
</html>`;
    zip.addBuffer(Buffer.from(xhtml), `OEBPS/${chapter.fileName}`);
  }

  zip.end();
  return streamToBuffer(zip.outputStream);
}

/** A minimal EPUB2 book with two chapters (fixture #4). */
export function buildEpub2(): Promise<Buffer> {
  return buildEpub(
    [
      {
        id: 'c1',
        fileName: 'chapter1.xhtml',
        title: 'Chapter 1',
        paragraphs: [
          'It was a bright cold day when the story began.',
          'She walked through the door without looking back.',
        ],
      },
      {
        id: 'c2',
        fileName: 'chapter2.xhtml',
        title: 'Chapter 2',
        paragraphs: ['The second chapter begins here, quite differently than the first.'],
      },
    ],
    '2.0',
  );
}

/** A minimal EPUB3 book with a nav document (fixture #5). */
export function buildEpub3(): Promise<Buffer> {
  return buildEpub(
    [
      {
        id: 'c1',
        fileName: 'chapter1.xhtml',
        title: 'Chapter 1',
        paragraphs: ['This is an EPUB3 fixture with a navigation document.'],
      },
      {
        id: 'c2',
        fileName: 'chapter2.xhtml',
        title: 'Chapter 2',
        paragraphs: ['Its second chapter has its own paragraph content.'],
      },
    ],
    '3.0',
  );
}

/** A ZIP that isn't a valid EPUB (missing container.xml) (fixture #6). */
export function buildMalformedEpub(): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });
  zip.addBuffer(Buffer.from('not xml'), 'OEBPS/junk.txt');
  zip.end();
  return streamToBuffer(zip.outputStream);
}

/** An EPUB whose manifest tries to escape the archive root via a traversal href. */
export function buildEpubWithPathTraversal(): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    'META-INF/container.xml',
  );
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest><item id="c1" href="../../../etc/evil.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
    ),
    'OEBPS/content.opf',
  );
  zip.end();
  return streamToBuffer(zip.outputStream);
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
