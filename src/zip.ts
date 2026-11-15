/**
 * Minimal, dependency-free ZIP reader.
 *
 * Supports what we need for ClinergyDemo.zip and the OpenGALEN 8 downloads:
 * "stored" (method 0) and "deflate" (method 8) entries, no ZIP64, no
 * encryption. Deflate data is inflated with the web-standard
 * `DecompressionStream("deflate-raw")` built into Deno.
 *
 * Layout reminder (all little-endian):
 *   [local header + data]* ... [central directory entries] [end of central directory]
 * We locate the End Of Central Directory record (signature 0x06054b50) by
 * scanning backwards, walk the central directory (0x02014b50) for names,
 * sizes and local-header offsets, and read each entry's data after its
 * local header (0x04034b50).
 */

/** One file inside a ZIP archive. */
export interface ZipEntry {
  /** Path inside the archive, with "/" separators. */
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header. */
  localHeaderOffset: number;
  /** True for directory entries (name ends with "/"). */
  isDirectory: boolean;
}

/** A parsed ZIP archive held in memory. */
export class ZipArchive {
  readonly entries: ZipEntry[];
  #bytes: Uint8Array;
  #view: DataView;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.entries = this.#readCentralDirectory();
  }

  /** Read a ZIP file from disk. */
  static async open(path: string): Promise<ZipArchive> {
    return new ZipArchive(await Deno.readFile(path));
  }

  /** Find an entry by exact name, or case-insensitively as a fallback. */
  find(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name) ??
      this.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  }

  /** Return the uncompressed bytes of an entry. */
  async read(entry: ZipEntry): Promise<Uint8Array> {
    const v = this.#view;
    const off = entry.localHeaderOffset;
    if (v.getUint32(off, true) !== 0x04034b50) throw new Error(`zip: bad local header for ${entry.name}`);
    // The local header repeats name/extra lengths, which may differ from the central copy.
    const nameLen = v.getUint16(off + 26, true);
    const extraLen = v.getUint16(off + 28, true);
    const start = off + 30 + nameLen + extraLen;
    const data = this.#bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data.slice();
    if (entry.method !== 8) throw new Error(`zip: unsupported method ${entry.method} for ${entry.name}`);
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    if (out.length !== entry.uncompressedSize) {
      throw new Error(`zip: ${entry.name} inflated to ${out.length} bytes, expected ${entry.uncompressedSize}`);
    }
    return out;
  }

  #readCentralDirectory(): ZipEntry[] {
    const v = this.#view;
    // EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
    let eocd = -1;
    for (let i = this.#bytes.length - 22; i >= Math.max(0, this.#bytes.length - 22 - 65535); i--) {
      if (v.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("zip: end of central directory not found (not a ZIP file?)");
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const dec = new TextDecoder("latin1"); // old archives use DOS code pages; names here are ASCII
    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip: bad central directory entry");
      const method = v.getUint16(p + 10, true);
      const compressedSize = v.getUint32(p + 20, true);
      const uncompressedSize = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen = v.getUint16(p + 30, true);
      const commentLen = v.getUint16(p + 32, true);
      const localHeaderOffset = v.getUint32(p + 42, true);
      const name = dec.decode(this.#bytes.subarray(p + 46, p + 46 + nameLen)).replaceAll("\\", "/");
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isDirectory: name.endsWith("/"),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }
}
