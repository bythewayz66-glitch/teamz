import { deflateRawSync } from 'node:zlib';

export interface FixtureFile {
  path: string;
  data: string | Uint8Array;
  method?: 0 | 8 | 9;
  flags?: number;
  /** Declared uncompressed size override, for zip-bomb tests. */
  declaredSize?: number;
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Test-only ZIP writer. */
export function makeZip(files: FixtureFile[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const w16 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const w32 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const cat = (...a: Uint8Array[]) => {
    const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of a) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };
  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const method = f.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = enc.encode(f.path);
    const flags = f.flags ?? 0;
    const size = f.declaredSize ?? raw.length;
    const local = cat(w32(0x04034b50), w16(20), w16(flags), w16(method), w16(0), w16(0), w32(crc32(raw)), w32(body.length), w32(size), w16(name.length), w16(0), name, body);
    central.push(cat(w32(0x02014b50), w16(20), w16(20), w16(flags), w16(method), w16(0), w16(0), w32(crc32(raw)), w32(body.length), w32(size), w16(name.length), w16(0), w16(0), w16(0), w16(0), w32(0), w32(offset), name));
    parts.push(local);
    offset += local.length;
  }
  const cd = cat(...central);
  const end = cat(w32(0x06054b50), w16(0), w16(0), w16(files.length), w16(files.length), w32(cd.length), w32(offset), w16(0));
  return cat(...parts, cd, end);
}
