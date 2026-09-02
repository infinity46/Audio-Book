/**
 * Real (not simulated) metadata stripping for cover images, implemented as a
 * direct binary edit of the container rather than a full pixel re-encode:
 *
 * - **JPEG**: EXIF lives in the APP1 (`0xFFE1`) marker segment. JPEG marker
 *   segments are self-delimiting (each carries its own length), so an APP1
 *   segment can be cut out of the byte stream without touching the
 *   entropy-coded scan data or decoding a single pixel. This removes EXIF
 *   (and, incidentally, XMP if it was carried in APP1) but deliberately
 *   leaves other segments — including ICC color profiles (APP2) — alone,
 *   since those affect how the image renders.
 * - **PNG**: EXIF (and other free-text metadata) lives in named ancillary
 *   chunks. This drops the `eXIf`, `tEXt`, `zTXt`, `iTXt`, and `tIME` chunks
 *   by the same cut-and-splice approach (PNG chunks are also
 *   self-delimiting: 4-byte length + 4-byte type + payload + 4-byte CRC).
 *   Critical chunks (`IHDR`, `PLTE`, `IDAT`, `IEND`) and rendering-relevant
 *   ancillary chunks (`tRNS`, `gAMA`, `cHRM`, `sRGB`, `iCCP`, `pHYs`, …) are
 *   left untouched.
 *
 * Anything other than these two formats is returned unmodified — callers
 * only invoke this after `detectFormat` has confirmed JPEG or PNG.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNK_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripJpegExif(buffer: Buffer): Buffer {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return buffer;
  const out: Buffer[] = [buffer.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      out.push(buffer.subarray(offset));
      return Buffer.concat(out);
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd9) {
      out.push(buffer.subarray(offset));
      return Buffer.concat(out);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) {
      out.push(buffer.subarray(offset));
      return Buffer.concat(out);
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const segmentEnd = offset + 2 + segmentLength;
    if (marker === 0xda) {
      // Start of scan: everything from here to EOI is entropy-coded data —
      // copy it through verbatim, untouched.
      out.push(buffer.subarray(offset));
      return Buffer.concat(out);
    }
    if (marker === 0xe1) {
      // APP1 — EXIF (and/or XMP). Drop the segment entirely.
      offset = segmentEnd;
      continue;
    }
    out.push(buffer.subarray(offset, segmentEnd));
    offset = segmentEnd;
  }
  return Buffer.concat(out);
}

function stripPngMetadata(buffer: Buffer): Buffer {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer;
  const out: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length; // length + type(4) + data + crc(4)
    if (chunkEnd > buffer.length) {
      out.push(buffer.subarray(offset));
      break;
    }
    if (!PNG_METADATA_CHUNK_TYPES.has(type)) {
      out.push(buffer.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
  }
  return Buffer.concat(out);
}

export function stripExif(buffer: Buffer, mimeType: string): Buffer {
  if (mimeType === 'image/jpeg') return stripJpegExif(buffer);
  if (mimeType === 'image/png') return stripPngMetadata(buffer);
  return buffer;
}
