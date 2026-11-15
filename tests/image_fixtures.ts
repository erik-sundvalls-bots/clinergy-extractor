// Builders for synthetic image test data: BMP/DIB, ICO, PE and NE files with resources.
// Everything is generated here; no real files are used.

type Rgb = [number, number, number];

/** A DIB with BITMAPINFOHEADER. pixels = palette indices (bpp <= 8) or RGB triples, top row first. */
export function dib(o: {
  width: number;
  height: number;
  bpp: 1 | 4 | 8 | 24;
  palette?: Rgb[];
  pixels: (number | Rgb)[][];
  topDown?: boolean;
  /** icon layout: double height + AND mask (1 = transparent), top row first */
  mask?: number[][];
}): Uint8Array {
  const { width, height, bpp } = o;
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const mstride = Math.ceil(width / 32) * 4;
  const pal = bpp <= 8 ? (o.palette ?? []).length || 1 << bpp : 0;
  const size = 40 + pal * 4 + stride * height + (o.mask ? mstride * height : 0);
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 40, true);
  v.setInt32(4, width, true);
  v.setInt32(8, (o.topDown ? -1 : 1) * height * (o.mask ? 2 : 1), true);
  v.setUint16(12, 1, true);
  v.setUint16(14, bpp, true);
  v.setUint32(32, bpp <= 8 ? pal : 0, true);
  (o.palette ?? []).forEach(([r, g, bl], i) => b.set([bl, g, r, 0], 40 + i * 4));
  const px = 40 + pal * 4;
  for (let y = 0; y < height; y++) {
    const row = px + (o.topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const p = o.pixels[y][x];
      if (bpp === 24) b.set([(p as Rgb)[2], (p as Rgb)[1], (p as Rgb)[0]], row + x * 3);
      else {
        const bit = x * bpp;
        b[row + (bit >> 3)] |= (p as number) << (8 - bpp - (bit & 7));
      }
    }
    if (o.mask) {
      const mrow = px + stride * height + (o.topDown ? y : height - 1 - y) * mstride;
      for (let x = 0; x < width; x++) if (o.mask[y][x]) b[mrow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return b;
}

/** A .bmp file: "BM" header + DIB. */
export function bmpFile(d: Uint8Array): Uint8Array {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const bpp = v.getUint16(14, true);
  const pal = bpp <= 8 ? (v.getUint32(32, true) || 1 << bpp) : 0;
  const out = new Uint8Array(14 + d.length);
  const w = new DataView(out.buffer);
  out.set([0x42, 0x4d]);
  w.setUint32(2, out.length, true);
  w.setUint32(10, 14 + 40 + pal * 4, true);
  out.set(d, 14);
  return out;
}

/** An .ico file with one image. */
export function icoFile(image: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(6 + 16 + image.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, 1, true);
  out[6] = width, out[7] = height;
  v.setUint16(10, 1, true);
  v.setUint16(12, bpp, true);
  v.setUint32(14, image.length, true);
  v.setUint32(18, 22, true);
  out.set(image, 22);
  return out;
}

/** RT_GROUP_ICON data pointing at RT_ICON ids. */
export function groupIcon(entries: { width: number; height: number; bpp: number; size: number; id: number }[]) {
  const out = new Uint8Array(6 + 14 * entries.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, entries.length, true);
  entries.forEach((e, i) => {
    const o = 6 + i * 14;
    out[o] = e.width, out[o + 1] = e.height;
    v.setUint16(o + 4, 1, true);
    v.setUint16(o + 6, e.bpp, true);
    v.setUint32(o + 8, e.size, true);
    v.setUint16(o + 12, e.id, true);
  });
  return out;
}

export interface Res {
  type: number;
  name: number | string;
  data: Uint8Array;
}

/** A minimal 32-bit PE file whose only section is .rsrc with the given resources. */
export function peFile(resources: Res[]): Uint8Array {
  const RVA = 0x1000, RAW = 0x200;
  // group: type -> name -> data (one language, 0x409)
  const types = [...new Set(resources.map((r) => r.type))].sort((a, b) => a - b);
  const sec: number[] = [];
  const u16 = (o: number, x: number) => (sec[o] = x & 255, sec[o + 1] = (x >> 8) & 255);
  const u32 = (o: number, x: number) => (u16(o, x & 0xffff), u16(o + 2, x >>> 16));
  const alloc = (n: number) => {
    const o = sec.length;
    for (let i = 0; i < n; i++) sec.push(0);
    return o;
  };
  const dir = (n: number, named = 0) => {
    const o = alloc(16 + 8 * n);
    u16(o + 12, named);
    u16(o + 14, n - named);
    return o;
  };
  const strings: [number, string][] = [];
  const datas: [number, Uint8Array][] = [];
  const root = dir(types.length);
  types.forEach((t, ti) => {
    const rs = resources.filter((r) => r.type === t);
    const named = rs.filter((r) => typeof r.name === "string");
    const sorted = [...named, ...rs.filter((r) => typeof r.name === "number")];
    const td = dir(rs.length, named.length);
    u32(root + 16 + ti * 8, t);
    u32(root + 20 + ti * 8, 0x80000000 | td);
    sorted.forEach((r, ni) => {
      const ld = dir(1);
      if (typeof r.name === "string") strings.push([td + 16 + ni * 8, r.name]);
      else u32(td + 16 + ni * 8, r.name);
      u32(td + 20 + ni * 8, 0x80000000 | ld);
      const de = alloc(16);
      u32(ld + 16, 0x409);
      u32(ld + 20, de);
      datas.push([de, r.data]);
    });
  });
  for (const [at, s] of strings) {
    const o = alloc(2 + s.length * 2);
    u16(o, s.length);
    for (let i = 0; i < s.length; i++) u16(o + 2 + i * 2, s.charCodeAt(i));
    u32(at, 0x80000000 | o);
  }
  for (const [de, d] of datas) {
    while (sec.length % 4) sec.push(0);
    const o = alloc(d.length);
    d.forEach((x, i) => sec[o + i] = x);
    u32(de, RVA + o);
    u32(de + 4, d.length);
  }
  const out = new Uint8Array(RAW + sec.length);
  const v = new DataView(out.buffer);
  out.set([0x4d, 0x5a]);
  v.setUint32(0x3c, 0x40, true);
  out.set([0x50, 0x45, 0, 0], 0x40);
  const coff = 0x44;
  v.setUint16(coff, 0x14c, true);
  v.setUint16(coff + 2, 1, true);
  v.setUint16(coff + 16, 224, true);
  const opt = coff + 20;
  v.setUint16(opt, 0x10b, true);
  v.setUint32(opt + 92, 16, true);
  v.setUint32(opt + 96 + 16, RVA, true);
  v.setUint32(opt + 96 + 20, sec.length, true);
  const sh = opt + 224;
  out.set([0x2e, 0x72, 0x73, 0x72, 0x63], sh);
  v.setUint32(sh + 8, sec.length, true);
  v.setUint32(sh + 12, RVA, true);
  v.setUint32(sh + 16, sec.length, true);
  v.setUint32(sh + 20, RAW, true);
  out.set(sec, RAW);
  return out;
}

/** A minimal 16-bit NE file with a resource table (alignment shift 4). */
export function neFile(resources: Res[]): Uint8Array {
  const NE = 0x40, RT = NE + 0x40;
  const types = [...new Set(resources.map((r) => r.type))];
  const tableSize = 2 + types.reduce((n, t) => n + 8 + 12 * resources.filter((r) => r.type === t).length, 0) + 2;
  let dataAt = Math.ceil((RT + tableSize) / 16) * 16;
  const total = dataAt + resources.reduce((n, r) => n + Math.ceil(r.data.length / 16) * 16, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set([0x4d, 0x5a]);
  v.setUint32(0x3c, NE, true);
  out.set([0x4e, 0x45], NE);
  v.setUint16(NE + 0x24, RT - NE, true); // resource table
  v.setUint16(NE + 0x26, RT - NE + tableSize, true); // resident names (after it)
  let q = RT;
  v.setUint16(q, 4, true);
  q += 2;
  for (const t of types) {
    const rs = resources.filter((r) => r.type === t);
    v.setUint16(q, 0x8000 | t, true);
    v.setUint16(q + 2, rs.length, true);
    q += 8;
    for (const r of rs) {
      v.setUint16(q, dataAt >> 4, true);
      v.setUint16(q + 2, Math.ceil(r.data.length / 16), true);
      v.setUint16(q + 6, 0x8000 | (r.name as number), true);
      out.set(r.data, dataAt);
      dataAt += Math.ceil(r.data.length / 16) * 16;
      q += 12;
    }
  }
  return out;
}
