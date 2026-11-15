/**
 * Read the resources of Windows executables (EXE, DLL, OCX, ...):
 * 32/64-bit PE files (.rsrc section) and 16-bit NE files (resource table).
 * Only reads; nothing is executed.
 */

export interface Resource {
  /** numeric RT_* type or a string type name */
  type: number | string;
  /** numeric id or string name */
  name: number | string;
  /** language id (PE only; 0 for NE) */
  lang: number;
  data: Uint8Array;
}

export const RT = {
  CURSOR: 1,
  BITMAP: 2,
  ICON: 3,
  MENU: 4,
  DIALOG: 5,
  STRING: 6,
  RCDATA: 10,
  GROUP_CURSOR: 12,
  GROUP_ICON: 14,
  VERSION: 16,
  TOOLBAR: 241,
} as const;

/** "PE", "NE" or null for anything that is not a Windows executable. */
export function exeKind(b: Uint8Array): "PE" | "NE" | null {
  if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return null;
  const off = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0x3c, true);
  if (off + 4 > b.length) return null;
  if (b[off] === 0x50 && b[off + 1] === 0x45 && b[off + 2] === 0 && b[off + 3] === 0) return "PE";
  if (b[off] === 0x4e && b[off + 1] === 0x45) return "NE";
  return null;
}

/** All resources of a PE or NE file ([] if it has none or is not an executable). */
export function readResources(b: Uint8Array): Resource[] {
  const k = exeKind(b);
  return k === "PE" ? readPe(b) : k === "NE" ? readNe(b) : [];
}

function readPe(b: Uint8Array): Resource[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const pe = v.getUint32(0x3c, true);
  const nSections = v.getUint16(pe + 6, true);
  const optSize = v.getUint16(pe + 20, true);
  const opt = pe + 24;
  const magic = v.getUint16(opt, true); // 0x10b PE32, 0x20b PE32+
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  if (v.getUint32(opt + (magic === 0x20b ? 108 : 92), true) < 3) return [];
  const rsrcRva = v.getUint32(dirs + 2 * 8, true);
  if (!rsrcRva) return [];
  const sections: { va: number; size: number; raw: number }[] = [];
  for (let i = 0, s = opt + optSize; i < nSections; i++, s += 40) {
    sections.push({
      va: v.getUint32(s + 12, true),
      size: Math.max(v.getUint32(s + 8, true), v.getUint32(s + 16, true)),
      raw: v.getUint32(s + 20, true),
    });
  }
  const fileOff = (rva: number) => {
    const s = sections.find((s) => rva >= s.va && rva < s.va + s.size);
    return s ? rva - s.va + s.raw : -1;
  };
  const base = fileOff(rsrcRva);
  if (base < 0) return [];
  const name = (entryName: number): number | string => {
    if (!(entryName & 0x80000000)) return entryName & 0xffff;
    const q = base + (entryName & 0x7fffffff);
    const n = v.getUint16(q, true);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint16(q + 2 + i * 2, true));
    return s;
  };
  const entries = (dirOff: number) => {
    const q = base + dirOff;
    const n = v.getUint16(q + 12, true) + v.getUint16(q + 14, true);
    return [...Array(n)].map((_, i) => ({
      name: v.getUint32(q + 16 + i * 8, true),
      off: v.getUint32(q + 20 + i * 8, true),
    }));
  };
  const out: Resource[] = [];
  for (const t of entries(0)) {
    if (!(t.off & 0x80000000)) continue;
    for (const n of entries(t.off & 0x7fffffff)) {
      if (!(n.off & 0x80000000)) continue;
      for (const l of entries(n.off & 0x7fffffff)) {
        if (l.off & 0x80000000) continue;
        const d = base + l.off;
        const at = fileOff(v.getUint32(d, true)), size = v.getUint32(d + 4, true);
        if (at < 0 || at + size > b.length) continue;
        out.push({ type: name(t.name), name: name(n.name), lang: l.name & 0xffff, data: b.subarray(at, at + size) });
      }
    }
  }
  return out;
}

function readNe(b: Uint8Array): Resource[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ne = v.getUint32(0x3c, true);
  const rt = ne + v.getUint16(ne + 0x24, true);
  if (rt === ne || v.getUint16(ne + 0x24, true) === v.getUint16(ne + 0x26, true)) return [];
  const shift = v.getUint16(rt, true);
  const str = (off: number): string => {
    const q = rt + off, n = b[q];
    return String.fromCharCode(...b.subarray(q + 1, q + 1 + n));
  };
  const out: Resource[] = [];
  let q = rt + 2;
  while (q + 2 <= b.length) {
    const typeId = v.getUint16(q, true);
    if (!typeId) break;
    const count = v.getUint16(q + 2, true);
    q += 8;
    const type = typeId & 0x8000 ? typeId & 0x7fff : str(typeId);
    for (let i = 0; i < count; i++, q += 12) {
      const at = v.getUint16(q, true) << shift, len = v.getUint16(q + 2, true) << shift;
      const id = v.getUint16(q + 6, true);
      if (at + len > b.length) continue;
      out.push({ type, name: id & 0x8000 ? id & 0x7fff : str(id), lang: 0, data: b.subarray(at, at + len) });
    }
  }
  return out;
}

/** One image in an icon or cursor: a group directory entry plus its image data. */
export interface IconImage {
  width: number;
  height: number;
  bitCount: number;
  /** cursor hotspot (cursors only) */
  hotspot?: [number, number];
  /** DIB (or PNG) data, without the cursor hotspot prefix */
  data: Uint8Array;
}

/** Parse an .ico or .cur file. */
export function parseIcoFile(b: Uint8Array): { cursor: boolean; images: IconImage[] } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = v.getUint16(2, true);
  if (v.getUint16(0, true) !== 0 || (type !== 1 && type !== 2)) throw new Error("ico: bad header");
  const n = v.getUint16(4, true);
  const images: IconImage[] = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const size = v.getUint32(e + 8, true), off = v.getUint32(e + 12, true);
    if (off + size > b.length) continue;
    images.push({
      width: b[e] || 256,
      height: b[e + 1] || 256,
      bitCount: type === 1 ? v.getUint16(e + 6, true) : 0,
      hotspot: type === 2 ? [v.getUint16(e + 4, true), v.getUint16(e + 6, true)] : undefined,
      data: b.subarray(off, off + size),
    });
  }
  return { cursor: type === 2, images };
}

/**
 * Resolve an RT_GROUP_ICON / RT_GROUP_CURSOR resource into its images, using the
 * RT_ICON / RT_CURSOR resources of the same module.
 */
export function resolveGroup(group: Resource, all: Resource[]): IconImage[] {
  const cursor = group.type === RT.GROUP_CURSOR;
  const v = new DataView(group.data.buffer, group.data.byteOffset, group.data.byteLength);
  const n = v.getUint16(4, true);
  const out: IconImage[] = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 14;
    if (e + 14 > group.data.length) break;
    const id = v.getUint16(e + 12, true);
    const r = all.find((x) => x.type === (cursor ? RT.CURSOR : RT.ICON) && x.name === id);
    if (!r) continue;
    if (cursor) {
      const cv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      out.push({
        width: v.getUint16(e, true),
        height: v.getUint16(e + 2, true) / 2,
        bitCount: v.getUint16(e + 6, true),
        hotspot: [cv.getUint16(0, true), cv.getUint16(2, true)],
        data: r.data.subarray(4),
      });
    } else {
      out.push({
        width: group.data[e] || 256,
        height: group.data[e + 1] || 256,
        bitCount: v.getUint16(e + 6, true),
        data: r.data,
      });
    }
  }
  return out;
}

/** Build an .ico (or .cur) file from images. */
export function buildIcoFile(images: IconImage[], cursor = false): Uint8Array {
  const size = 6 + 16 * images.length + images.reduce((n, i) => n + i.data.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint16(2, cursor ? 2 : 1, true);
  v.setUint16(4, images.length, true);
  let off = 6 + 16 * images.length;
  images.forEach((im, i) => {
    const e = 6 + i * 16;
    out[e] = im.width >= 256 ? 0 : im.width;
    out[e + 1] = im.height >= 256 ? 0 : im.height;
    if (cursor) {
      v.setUint16(e + 4, im.hotspot?.[0] ?? 0, true);
      v.setUint16(e + 6, im.hotspot?.[1] ?? 0, true);
    } else {
      v.setUint16(e + 4, 1, true);
      v.setUint16(e + 6, im.bitCount, true);
    }
    v.setUint32(e + 8, im.data.length, true);
    v.setUint32(e + 12, off, true);
    out.set(im.data, off);
    off += im.data.length;
  });
  return out;
}
