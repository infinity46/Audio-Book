/**
 * Minimal PNG/JPEG dimension readers, implemented by hand rather than
 * pulling in an image-processing dependency (`sharp`, `image-size`, etc.)
 * for what is a ~30-line container-header read. No pixel decoding happens
 * here — just parsing the small set of well-known header bytes each format
 * guarantees.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImageDimensions {
  width: number;
  height: number;
}

function readPngDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // Bytes 8-11: IHDR chunk length: bytes 12-15: "IHDR"; width/height are the
  // next two big-endian uint32s (PNG spec §11.2.2).
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // resync — skip stray fill bytes (0xFF padding is legal between segments)
      continue;
    }
    const marker = buffer[offset + 1]!;
    // Standalone markers (no length field, no payload).
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 are the "start of frame"
    // markers that carry height/width; SOF markers exclude 0xC4 (DHT), 0xC8
    // (JPG reserved), and 0xCC (DAC).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    if (marker === 0xda) break; // start of scan — no more markers with useful headers
    offset += 2 + segmentLength;
  }
  return null;
}

export function readImageDimensions(buffer: Buffer, mimeType: string): ImageDimensions | null {
  if (mimeType === 'image/png') return readPngDimensions(buffer);
  if (mimeType === 'image/jpeg') return readJpegDimensions(buffer);
  return null;
}
