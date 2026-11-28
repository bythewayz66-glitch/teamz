/**
 * Minimal ZIP reader for `.agent` imports (stored + deflate, no zip64, no
 * encryption). It exists so the importer needs no new dependency; anything it
 * does not understand is refused, never guessed at.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export interface ZipLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

/** Gamut accepts 10,000 files; the total is far lower here because it is held in browser memory. */
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxFiles: 10_000, maxTotalBytes: 50 * 1024 * 1024 };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(data: Uint8Array, expected: number, max: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot decompress ZIP entries (DecompressionStream is missing).');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ZipError('An entry inflates past the size limit; refusing it.');
    }
    chunks.push(value);
  }
  if (total !== expected) throw new ZipError('An entry inflated to a different size than the archive declares.');
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipEntry[]> {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP archive: no end-of-central-directory record.');
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported.');
  }
  if (count > limits.maxFiles) throw new ZipError(`The archive holds ${count} entries; the limit is ${limits.maxFiles}.`);
  if (cdOffset + cdSize > bytes.length) throw new ZipError('The ZIP central directory is out of bounds.');

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) throw new ZipError('The ZIP central directory is damaged.');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (path.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`${path} is encrypted; encrypted archives are not supported.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('The archive is larger than the import size limit.');
    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) {
      throw new ZipError(`${path} has a damaged local header.`);
    }
    const start = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    if (start + compSize > bytes.length) throw new ZipError(`${path} runs past the end of the archive.`);
    const raw = bytes.subarray(start, start + compSize);
    let data: Uint8Array;
    if (method === 0) {
      if (compSize !== size) throw new ZipError(`${path} declares inconsistent sizes.`);
      data = raw.slice();
    } else if (method === 8) {
      data = await inflateRaw(raw, size, limits.maxTotalBytes);
    } else {
      throw new ZipError(`${path} uses compression method ${method}, which is not supported.`);
    }
    entries.push({ path, data });
  }
  return entries;
}
