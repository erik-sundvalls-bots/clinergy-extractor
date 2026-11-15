/**
 * Decode Windows device-independent bitmaps (DIBs) to RGBA:
 *  - .bmp files ("BM" file header + DIB),
 *  - bare DIBs as stored in RT_BITMAP resources,
 *  - icon/cursor images (DIB of double height: XOR colour image, then a 1-bit AND mask).
 * Header variants: BITMAPCOREHEADER (12), BITMAPINFOHEADER (40) and V2-V5 (52..124).
 * Bit depths 1, 4, 8, 16, 24, 32; BI_RGB, BI_RLE8, BI_RLE4, BI_BITFIELDS.
 * DIB rows are stored bottom-up unless the height is negative; the result is
 * always top row first.
 */

export interface Decoded {
  width: number;
  height: number;
  bitsPerPixel: number;
  /** RGBA, top row first */
  rgba: Uint8Array;
}

const BI_RGB = 0, BI_RLE8 = 1, BI_RLE4 = 2, BI_BITFIELDS = 3, BI_ALPHABITFIELDS = 6;

/** Decode a .bmp file (with its 14-byte "BM" header). */
export function decodeBmpFile(b: Uint8Array): Decoded {
  if (b[0] !== 0x42 || b[1] !== 0x4d) throw new Error("bmp: no BM signature");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return decodeDib(b.subarray(14), { pixelOffset: v.getUint32(10, true) - 14 });
}

/**
 * Decode a DIB. `icon` = icon/cursor layout (height covers XOR + AND mask).
 * `pixelOffset` = offset of the pixel array from the DIB start (file BMPs); otherwise
 * the pixels follow the header, masks and palette.
 */
export function decodeDib(b: Uint8Array, o: { icon?: boolean; pixelOffset?: number } = {}): Decoded {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hdr = v.getUint32(0, true);
  let width: number, height: number, bpp: number, compression = BI_RGB, clrUsed = 0;
  const core = hdr === 12;
  if (core) {
    width = v.getUint16(4, true);
    height = v.getInt16(6, true);
    bpp = v.getUint16(10, true);
  } else if (hdr >= 40 && hdr <= 124) {
    width = v.getInt32(4, true);
    height = v.getInt32(8, true);
    bpp = v.getUint16(14, true);
    compression = v.getUint32(16, true);
    clrUsed = v.getUint32(32, true);
  } else throw new Error(`bmp: unsupported header size ${hdr}`);
  const topDown = height < 0;
  height = Math.abs(height);
  if (o.icon) height = height / 2;
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new Error("bmp: bad dimensions");

  // channel masks
  let masks: number[] | null = null;
  let p = hdr;
  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    if (hdr >= 52) masks = [0, 1, 2, 3].map((i) => v.getUint32(40 + i * 4, true));
    else {
      const n = compression === BI_ALPHABITFIELDS ? 4 : 3;
      masks = [...Array(n)].map((_, i) => v.getUint32(hdr + i * 4, true));
      p += n * 4;
    }
  } else if (bpp === 16) masks = [0x7c00, 0x3e0, 0x1f, 0];
  if (masks && masks.length < 4) masks.push(0);

  // palette
  const palette: number[][] = [];
  if (bpp <= 8) {
    const n = clrUsed || 1 << bpp;
    const step = core ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const q = p + i * step;
      palette.push(q + 2 < b.length ? [b[q + 2], b[q + 1], b[q]] : [0, 0, 0]);
    }
    p += n * step;
  }
  if (o.pixelOffset !== undefined && o.pixelOffset > 0) p = o.pixelOffset;

  const rgba = new Uint8Array(width * height * 4);
  const put = (x: number, row: number, c: number[], a = 255) => {
    const y = topDown ? row : height - 1 - row;
    if (x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = c[0], rgba[i + 1] = c[1], rgba[i + 2] = c[2], rgba[i + 3] = a;
  };
  const pal = (i: number) => palette[i] ?? [0, 0, 0];
  const stride = Math.ceil((width * bpp) / 32) * 4;

  let alphaSeen = false;
  if (compression === BI_RLE8 || compression === BI_RLE4) {
    let x = 0, row = 0, q = p;
    const four = compression === BI_RLE4;
    while (q + 1 < b.length && row < height) {
      const n = b[q++], c = b[q++];
      if (n > 0) {
        for (let i = 0; i < n; i++) put(x++, row, pal(four ? (i & 1 ? c & 15 : c >> 4) : c));
      } else if (c === 0) x = 0, row++;
      else if (c === 1) break;
      else if (c === 2) x += b[q++], row += b[q++];
      else {
        for (let i = 0; i < c; i++) {
          const byte = b[q + (four ? i >> 1 : i)];
          put(x++, row, pal(four ? (i & 1 ? byte & 15 : byte >> 4) : byte));
        }
        const used = four ? Math.ceil(c / 2) : c;
        q += used + (used & 1);
      }
    }
  } else {
    for (let row = 0; row < height; row++) {
      const r = p + row * stride;
      for (let x = 0; x < width; x++) {
        if (bpp <= 8) {
          const bit = x * bpp;
          const byte = b[r + (bit >> 3)] ?? 0;
          put(x, row, pal((byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1)));
        } else if (bpp === 24) {
          const q = r + x * 3;
          put(x, row, [b[q + 2], b[q + 1], b[q]]);
        } else if (bpp === 16 || bpp === 32) {
          const q = r + x * (bpp / 8);
          const px = bpp === 16 ? v.getUint16(q, true) : v.getUint32(q, true);
          if (masks) {
            const [rm, gm, bm, am] = masks;
            const a = am ? channel(px, am) : 255;
            if (am) alphaSeen ||= a !== 0;
            put(x, row, [channel(px, rm), channel(px, gm), channel(px, bm)], a);
          } else {
            const a = b[q + 3];
            alphaSeen ||= a !== 0;
            put(x, row, [b[q + 2], b[q + 1], b[q]], o.icon ? a : 255);
          }
        } else throw new Error(`bmp: unsupported bit depth ${bpp}`);
      }
    }
    // a 32-bit image with an all-zero alpha channel is opaque
    if (bpp === 32 && !alphaSeen) { for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; }
    // icon AND mask: 1 = transparent (only when the colour image has no alpha)
    if (o.icon && !(bpp === 32 && alphaSeen)) {
      const mp = p + stride * height, ms = Math.ceil(width / 32) * 4;
      for (let row = 0; row < height; row++) {
        const y = topDown ? row : height - 1 - row;
        for (let x = 0; x < width; x++) {
          const byte = b[mp + row * ms + (x >> 3)];
          if (byte !== undefined && (byte >> (7 - (x & 7))) & 1) rgba[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
  }
  return { width, height, bitsPerPixel: bpp, rgba };
}

function channel(px: number, mask: number): number {
  if (!mask) return 0;
  let shift = 0;
  while (!((mask >>> shift) & 1)) shift++;
  const max = mask >>> shift;
  return Math.round((((px & mask) >>> shift) * 255) / max);
}
