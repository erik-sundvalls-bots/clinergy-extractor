/** Uncompressed (STORE) zip writer/reader. Enough for a local image-pack zip of PNGs. */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function zipStore(files: Record<string, Uint8Array>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const names = Object.keys(files).sort();
  for (const name of names) {
    const path = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.split("/").includes("..")) throw new Error(`bad zip path: ${name}`);
    const data = files[name];
    const nameBytes = new TextEncoder().encode(path);
    const crc = crc32(data);
    const local = concat(
      new TextEncoder().encode("PK\x03\x04"),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    );
    locals.push(local);
    const central = concat(
      new TextEncoder().encode("PK\x01\x02"),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    );
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concat(...centrals);
  const eocd = concat(
    new TextEncoder().encode("PK\x05\x06"),
    u16(0),
    u16(0),
    u16(names.length),
    u16(names.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  );
  return concat(...locals, centralDir, eocd);
}

export function unzipStore(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i + 30 <= bytes.length) {
    const sig = dv.getUint32(i, true);
    if (sig !== 0x04034b50) break;
    const method = dv.getUint16(i + 8, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const csize = dv.getUint32(i + 18, true);
    const name = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    const data = bytes.subarray(start, start + csize);
    if (method !== 0) throw new Error(`zip entry ${name} is compressed (method ${method}); expected STORE`);
    const path = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (path && !path.split("/").includes("..") && !path.endsWith("/")) out[path] = data.slice();
    i = start + csize;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
