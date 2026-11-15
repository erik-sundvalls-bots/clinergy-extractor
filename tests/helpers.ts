/**
 * Test helpers that BUILD synthetic archives, so the tests never need any
 * Clinergy content: a tiny PKWARE DCL encoder, an InstallShield 3 archive
 * writer and a ZIP writer. They are deliberately simple (greedy matching,
 * no CRCs) and only exist to exercise the readers in src/.
 */
import { DISTCODE, LEN_BASE, LEN_EXTRA, LENCODE, LITCODE } from "../src/explode.ts";

/** Canonical Huffman codes (value, length) per symbol, matching construct(). */
function codes(lengths: number[]): { code: number; len: number }[] {
  const max = Math.max(...lengths);
  const count = new Array(max + 1).fill(0);
  for (const l of lengths) if (l) count[l]++;
  const next = new Array(max + 2).fill(0);
  let code = 0;
  for (let len = 1; len <= max; len++) {
    next[len] = code;
    code = (code + count[len]) << 1;
  }
  return lengths.map((len) => ({ code: len ? next[len]++ : 0, len }));
}
const LIT = codes(LITCODE.lengths), LEN = codes(LENCODE.lengths), DIST = codes(DISTCODE.lengths);

class BitWriter {
  bytes: number[] = [];
  #cur = 0;
  #n = 0;
  bit(b: number) {
    this.#cur |= (b & 1) << this.#n;
    if (++this.#n === 8) {
      this.bytes.push(this.#cur);
      this.#cur = 0;
      this.#n = 0;
    }
  }
  bits(v: number, n: number) {
    for (let i = 0; i < n; i++) this.bit(v >> i);
  }
  /** Huffman codes are stored MSB first and bit-inverted. */
  huff(c: { code: number; len: number }) {
    for (let i = c.len - 1; i >= 0; i--) this.bit(((c.code >> i) & 1) ^ 1);
  }
  finish() {
    if (this.#n) this.bytes.push(this.#cur);
    return new Uint8Array(this.bytes);
  }
}

/** Compress with the DCL format. dict: 4/5/6; codedLiterals: Huffman-code literals. */
export function implode(data: Uint8Array, dict = 4, codedLiterals = false): Uint8Array {
  const w = new BitWriter();
  w.bits(codedLiterals ? 1 : 0, 8);
  w.bits(dict, 8);
  const window = 64 << dict;
  const writeLen = (len: number) => {
    // find the symbol whose [base, base + 2^extra) range holds len (bases start 3, 2, 4, ...)
    let sym = 15;
    for (let s = 0; s < 16; s++) {
      if (len >= LEN_BASE[s] && len < LEN_BASE[s] + (1 << LEN_EXTRA[s])) {
        sym = s;
        break;
      }
    }
    w.huff(LEN[sym]);
    w.bits(len - LEN_BASE[sym], LEN_EXTRA[sym]);
  };
  let i = 0;
  while (i < data.length) {
    // greedy longest match within the window
    let bestLen = 0, bestDist = 0;
    for (let d = 1; d <= Math.min(i, window); d++) {
      let l = 0;
      while (l < 518 && i + l < data.length && data[i + l] === data[i + l - d]) l++;
      if (l > bestLen && (l > 2 || d <= 256)) {
        bestLen = l;
        bestDist = d;
      }
    }
    if (bestLen >= 2) {
      w.bit(1);
      writeLen(bestLen);
      const low = bestLen === 2 ? 2 : dict;
      const d = bestDist - 1;
      w.huff(DIST[d >> low]);
      w.bits(d & ((1 << low) - 1), low);
      i += bestLen;
    } else {
      w.bit(0);
      if (codedLiterals) w.huff(LIT[data[i]]);
      else w.bits(data[i], 8);
      i++;
    }
  }
  w.bit(1);
  writeLen(519); // end marker
  return w.finish();
}

const enc = new TextEncoder();
const u16 = (v: DataView, o: number, x: number) => v.setUint16(o, x, true);
const u32 = (v: DataView, o: number, x: number) => v.setUint32(o, x, true);

export interface Is3Input {
  path: string;
  data: Uint8Array;
  stored?: boolean;
}

/**
 * Build a split InstallShield 3 archive. `splitAfter` bytes of compressed data
 * go into part 1; the remainder continues in part 2, so a file can span parts.
 * With splitAfter = Infinity a single unsplit archive is produced.
 */
export function buildIs3(files: Is3Input[], splitAfter = Infinity): Uint8Array[] {
  const dirs = [...new Set(files.map((f) => f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""))];
  const packed = files.map((f) => ({ ...f, comp: f.stored ? f.data : implode(f.data) }));
  const split = Number.isFinite(splitAfter);
  // Lay out data streams: part 1 from 255, part 2 continues at 255.
  type Placed = { p: typeof packed[0]; start: number; startPart: number; endPart: number; offset: number };
  const placed: Placed[] = [];
  const partData: number[][] = [[], []];
  let part = 0;
  let integral2 = -1;
  for (const p of packed) {
    const startPart = part, offset = 255 + partData[part].length;
    for (let k = 0; k < p.comp.length; k++) {
      if (part === 0 && partData[0].length >= splitAfter) part = 1;
      partData[part].push(p.comp[k]);
    }
    if (startPart === 1 && integral2 < 0) integral2 = offset;
    placed.push({ p, start: 0, startPart: startPart + 1, endPart: part + 1, offset });
  }
  if (integral2 < 0) integral2 = 255 + partData[1].length;
  const makePart = (id: number, withFiles: boolean) => {
    const data = partData[id - 1];
    const dirBytes = dirs.map((
      d,
    ) => [...le16(0), ...le16(11 + d.length), ...le16(d.length), ...enc.encode(d), 0, 0, 0, 0, 0]);
    const fileBytes = placed.map((x) => {
      const name = enc.encode(x.p.path.slice(x.p.path.lastIndexOf("/") + 1));
      const h = new Uint8Array(30 + name.length + 1 + 12);
      const v = new DataView(h.buffer);
      h[0] = x.endPart;
      u16(v, 1, dirs.indexOf(x.p.path.includes("/") ? x.p.path.slice(0, x.p.path.lastIndexOf("/")) : ""));
      u32(v, 3, x.p.data.length);
      u32(v, 7, x.p.comp.length);
      u32(v, 11, x.offset);
      u16(v, 23, h.length);
      u16(v, 25, (x.p.stored ? 0x10 : 0) | (x.startPart !== x.endPart ? 0x100 : 0));
      h[28] = x.startPart;
      h[29] = name.length;
      h.set(name, 30);
      return [...h];
    });
    const dirsOffset = 255 + data.length;
    const dirFlat = dirBytes.flat(), fileFlat = withFiles ? fileBytes.flat() : [];
    const out = new Uint8Array(dirsOffset + dirFlat.length + fileFlat.length);
    const v = new DataView(out.buffer);
    u32(v, 0, 0x8c655d13);
    out[4] = 0x3a;
    u16(v, 10, split ? 1 : 0);
    u16(v, 12, withFiles ? files.length : 0);
    out[30] = split ? 2 : 1;
    out[31] = id;
    u32(v, 37, id === 2 ? integral2 : 255);
    u32(v, 41, dirsOffset);
    u32(v, 45, dirFlat.length);
    u16(v, 49, dirs.length);
    u32(v, 51, dirsOffset + dirFlat.length);
    u32(v, 55, fileFlat.length);
    out.set(data, 255);
    out.set(dirFlat, dirsOffset);
    out.set(fileFlat, dirsOffset + dirFlat.length);
    return out;
  };
  return split ? [makePart(1, false), makePart(2, true)] : [makePart(1, true)];
}
const le16 = (x: number) => [x & 255, x >> 8];

/** Build a ZIP (stored entries, plus deflate for names listed in `deflate`). */
export async function buildZip(entries: Record<string, Uint8Array>, deflate: string[] = []): Promise<Uint8Array> {
  const local: number[] = [], central: number[] = [];
  let count = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const method = deflate.includes(name) ? 8 : 0;
    const data = method
      ? new Uint8Array(
        await new Response(
          new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw")),
        ).arrayBuffer(),
      )
      : raw;
    const n = enc.encode(name);
    const off = local.length;
    const lh = new Uint8Array(30), lv = new DataView(lh.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 8, method);
    u32(lv, 18, data.length);
    u32(lv, 22, raw.length);
    u16(lv, 26, n.length);
    local.push(...lh, ...n, ...data);
    const ch = new Uint8Array(46), cv = new DataView(ch.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 10, method);
    u32(cv, 20, data.length);
    u32(cv, 24, raw.length);
    u16(cv, 28, n.length);
    u32(cv, 42, off);
    central.push(...ch, ...n);
    count++;
  }
  const e = new Uint8Array(22), ev = new DataView(e.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, count);
  u16(ev, 10, count);
  u32(ev, 12, central.length);
  u32(ev, 16, local.length);
  return new Uint8Array([...local, ...central, ...e]);
}
