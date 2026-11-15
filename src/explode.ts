/**
 * PKWARE Data Compression Library (DCL) "explode" decompressor.
 *
 * InstallShield 3 archives (the _SETUP.1.._SETUP.5 files inside
 * ClinergyDemo.zip) compress every file with the 1990s PKWARE DCL
 * "implode" format (not to be confused with the ZIP "implode" method).
 *
 * This is a TypeScript port of the algorithm in Mark Adler's public
 * `blast.c` (zlib contrib/blast, zlib licence), written from the format
 * description there:
 *
 *  - byte 0: 0 = literals stored as raw 8-bit bytes, 1 = literals Huffman coded
 *  - byte 1: dictionary size code 4, 5 or 6 (1 KB, 2 KB, 4 KB window)
 *  - then a bit stream read least-significant bit first. Each token starts
 *    with one flag bit: 0 = literal, 1 = (length, distance) back-reference.
 *  - Huffman codes are stored bit-inverted, so we invert while decoding.
 *  - length symbol 15 with all extra bits set (length 519) marks the end.
 *
 * The three fixed Huffman tables are given in a compact run-length form:
 * each byte is (repeat - 1) << 4 | codeLength.
 */

/** Canonical Huffman decoding table: counts per code length + symbols in code order. */
interface Huffman {
  count: Uint16Array; // count[len] = number of codes of that length (1..13)
  symbol: Uint16Array; // symbols ordered by (length, symbol)
}

const MAXBITS = 13;

/** Build a Huffman table from the compact run-length representation. */
export function construct(rep: number[]): Huffman & { lengths: number[] } {
  const lengths: number[] = [];
  for (const b of rep) {
    const len = b & 15;
    for (let r = (b >> 4) + 1; r > 0; r--) lengths.push(len);
  }
  const count = new Uint16Array(MAXBITS + 1);
  for (const l of lengths) count[l]++;
  const offs = new Uint16Array(MAXBITS + 1);
  for (let len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + count[len];
  const symbol = new Uint16Array(lengths.length);
  lengths.forEach((l, s) => {
    if (l !== 0) symbol[offs[l]++] = s;
  });
  return { count, symbol, lengths };
}

// Fixed tables from the DCL format (see blast.c).
const LITLEN = [
  11,
  124,
  8,
  7,
  28,
  7,
  188,
  13,
  76,
  4,
  10,
  8,
  12,
  10,
  12,
  10,
  8,
  23,
  8,
  9,
  7,
  6,
  7,
  8,
  7,
  6,
  55,
  8,
  23,
  24,
  12,
  11,
  7,
  9,
  11,
  12,
  6,
  7,
  22,
  5,
  7,
  24,
  6,
  11,
  9,
  6,
  7,
  22,
  7,
  11,
  38,
  7,
  9,
  8,
  25,
  11,
  8,
  11,
  9,
  12,
  8,
  12,
  5,
  38,
  5,
  38,
  5,
  11,
  7,
  5,
  6,
  21,
  6,
  10,
  53,
  8,
  7,
  24,
  10,
  27,
  44,
  253,
  253,
  253,
  252,
  252,
  252,
  13,
  12,
  45,
  12,
  45,
  12,
  61,
  12,
  45,
  44,
  173,
];
const LENLEN = [2, 35, 36, 53, 38, 23];
const DISTLEN = [2, 20, 53, 230, 247, 151, 248];
/** Base match length and number of extra bits for each of the 16 length symbols. */
export const LEN_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
export const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

export const LITCODE = construct(LITLEN);
export const LENCODE = construct(LENLEN);
export const DISTCODE = construct(DISTLEN);

/** Bit reader, least-significant bit first. */
class Bits {
  #pos = 0;
  #buf = 0;
  #cnt = 0;
  constructor(private data: Uint8Array, start: number) {
    this.#pos = start;
  }
  bit(): number {
    if (this.#cnt === 0) {
      if (this.#pos >= this.data.length) throw new Error("explode: unexpected end of input");
      this.#buf = this.data[this.#pos++];
      this.#cnt = 8;
    }
    const b = this.#buf & 1;
    this.#buf >>= 1;
    this.#cnt--;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v;
  }
  /** Decode one symbol with a canonical Huffman table (codes are stored inverted). */
  decode(h: Huffman): number {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= this.bit() ^ 1;
      const count = h.count[len];
      if (code - first < count) return h.symbol[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("explode: invalid Huffman code");
  }
}

/**
 * Decompress one complete DCL stream.
 * @param expectedSize optional output size hint (pre-allocates and is checked).
 */
export function explode(input: Uint8Array, expectedSize?: number): Uint8Array {
  if (input.length < 2) throw new Error("explode: input too short");
  const lit = input[0];
  const dict = input[1];
  if (lit > 1) throw new Error(`explode: bad literal flag ${lit}`);
  if (dict < 4 || dict > 6) throw new Error(`explode: bad dictionary size code ${dict}`);
  const s = new Bits(input, 2);
  let out = new Uint8Array(expectedSize ?? Math.max(1024, input.length * 4));
  let n = 0;
  const ensure = (extra: number) => {
    if (n + extra <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, n + extra));
    bigger.set(out.subarray(0, n));
    out = bigger;
  };
  for (;;) {
    if (s.bit()) {
      // back-reference: length then distance
      const sym = s.decode(LENCODE);
      const len = LEN_BASE[sym] + s.bits(LEN_EXTRA[sym]);
      if (len === 519) break; // end-of-stream marker
      const low = len === 2 ? 2 : dict; // length-2 matches use only 2 low distance bits
      let dist = s.decode(DISTCODE) << low;
      dist += s.bits(low);
      dist++;
      if (dist > n) throw new Error("explode: distance beyond start of output");
      ensure(len);
      for (let i = 0; i < len; i++, n++) out[n] = out[n - dist]; // may overlap: copy byte by byte
    } else {
      ensure(1);
      out[n++] = lit ? s.decode(LITCODE) : s.bits(8);
    }
  }
  if (expectedSize !== undefined && n !== expectedSize) {
    throw new Error(`explode: produced ${n} bytes, expected ${expectedSize}`);
  }
  return out.subarray(0, n);
}
