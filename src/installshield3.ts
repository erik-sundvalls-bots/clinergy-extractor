/**
 * Reader for InstallShield 3 ".Z" archives (single or split into .1, .2, ...).
 *
 * ClinergyDemo.zip is a 1998 InstallShield 3 installer; the actual program
 * and data files live in the split archive _SETUP.1 ... _SETUP.5. Each part
 * starts with the same header and ends with a copy of the directory and file
 * tables. File data is PKWARE DCL compressed (see explode.ts).
 *
 * The format was documented by Philippe Valembois' "idecomp"
 * (github.com/lephilousophe/idecomp, GPL-3.0); this is an independent
 * TypeScript implementation of the same layout:
 *
 *  Part header, at offset 0 (little-endian):
 *    0  u32 magic 0x8C655D13        4  u8  header size (0x3A)
 *    10 u16 flags (1 = split, 2 = split contiguously)
 *    12 u16 number of files         31 u8  this part's id (1-based)
 *    37 u32 start of first file that lies wholly in this part ("integral data")
 *    41 u32 directory table offset  49 u16 number of directories
 *    51 u32 file table offset
 *  Directory entry: u16 fileCount, u16 entrySize, u16 nameLen, name, NUL, 4 unused bytes
 *  File entry (30-byte head): u8 endPart, u16 dirIndex, u32 originalSize,
 *    u32 compressedSize, u32 dataOffset, u32 dosDateTime, u32 attributes,
 *    u16 entrySize, u16 flags (0x10 stored, 0x100 spans parts), u8 pad,
 *    u8 startPart, u8 nameLen; then name, NUL, 12 bytes of version info.
 *
 *  A file that spans parts continues at offset 255 of the next part (just
 *  after the header area) and, in its last part, runs up to that part's
 *  "integral data" offset. The tables in the LAST part (or in an unsplit
 *  archive) carry the correct offsets for every file, so we read those.
 */
import { explode } from "./explode.ts";

const MAGIC = 0x8c655d13;

export interface Is3File {
  /** Directory + name inside the installer, e.g. "Group4/Selector.ini". */
  path: string;
  originalSize: number;
  compressedSize: number;
  dataOffset: number;
  startPart: number;
  endPart: number;
  flags: number;
}

interface PartHeader {
  flags: number;
  numFiles: number;
  partId: number;
  startIntegral: number;
  dirsOffset: number;
  numDirs: number;
  filesOffset: number;
}

function readHeader(b: Uint8Array): PartHeader {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(0, true) !== MAGIC) throw new Error("installshield3: bad magic (not an InstallShield 3 archive)");
  return {
    flags: v.getUint16(10, true),
    numFiles: v.getUint16(12, true),
    partId: v.getUint8(31),
    startIntegral: v.getUint32(37, true),
    dirsOffset: v.getUint32(41, true),
    numDirs: v.getUint16(49, true),
    filesOffset: v.getUint32(51, true),
  };
}

/** Parse the directory and file tables of one archive part. */
export function listFiles(part: Uint8Array): Is3File[] {
  const h = readHeader(part);
  const v = new DataView(part.buffer, part.byteOffset, part.byteLength);
  const dec = new TextDecoder("windows-1252");
  const dirs: string[] = [];
  let p = h.dirsOffset;
  for (let i = 0; i < h.numDirs; i++) {
    const entrySize = v.getUint16(p + 2, true);
    const nameLen = v.getUint16(p + 4, true);
    dirs.push(dec.decode(part.subarray(p + 6, p + 6 + nameLen)).replaceAll("\\", "/"));
    p += entrySize;
  }
  const files: Is3File[] = [];
  p = h.filesOffset;
  for (let i = 0; i < h.numFiles; i++) {
    const nameLen = v.getUint8(p + 29);
    const dir = dirs[v.getUint16(p + 1, true)] ?? "";
    const name = dec.decode(part.subarray(p + 30, p + 30 + nameLen));
    files.push({
      path: dir ? `${dir}/${name}` : name,
      endPart: v.getUint8(p),
      originalSize: v.getUint32(p + 3, true),
      compressedSize: v.getUint32(p + 7, true),
      dataOffset: v.getUint32(p + 11, true),
      flags: v.getUint16(p + 25, true),
      startPart: v.getUint8(p + 28),
    });
    p += v.getUint16(p + 23, true);
  }
  return files;
}

/**
 * Extract every file of a (possibly split) InstallShield 3 archive.
 * @param parts the archive parts in order (parts[0] is part 1).
 * @returns map from path to file contents.
 */
export function extractAll(parts: Uint8Array[]): Map<string, Uint8Array> {
  const headers = parts.map(readHeader);
  const split = (headers[0].flags & 3) !== 0;
  const files = listFiles(parts[parts.length - 1]); // last part has correct offsets for all files
  const out = new Map<string, Uint8Array>();
  for (const f of files) {
    // Gather the compressed bytes, which may be spread over several parts.
    const chunks: Uint8Array[] = [];
    const first = split ? f.startPart : 1, last = split ? f.endPart : 1;
    for (let id = first; id <= last; id++) {
      const part = parts[id - 1], h = headers[id - 1];
      if (!part) throw new Error(`installshield3: part ${id} missing for ${f.path}`);
      const start = id === first ? f.dataOffset : 255;
      const end = !(f.flags & 0x100) ? start + f.compressedSize : id === last ? h.startIntegral : h.dirsOffset;
      chunks.push(part.subarray(start, end));
    }
    const data = concat(chunks);
    if (data.length !== f.compressedSize) {
      throw new Error(`installshield3: ${f.path}: read ${data.length} bytes, expected ${f.compressedSize}`);
    }
    out.set(f.path, f.flags & 0x10 ? data.slice() : explode(data, f.originalSize));
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
