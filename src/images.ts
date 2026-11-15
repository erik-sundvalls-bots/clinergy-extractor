/**
 * Find every image in the demo and convert it to an open format:
 *  - loose bitmaps (any file starting with "BM", e.g. Compdata *.bmp, *.jk, *.hf)  -> PNG
 *  - loose .ico / .cur files                                                       -> PNG per size + the file
 *  - resources of PE and NE executables (EXE, DLL, OCX):
 *      RT_BITMAP -> PNG; RT_GROUP_ICON / RT_GROUP_CURSOR -> .ico / .cur + one PNG per size
 *      Aldus placeable metafiles in custom resource types -> kept as .wmf (no PNG: needs a renderer)
 *  - Visual Basic form property blobs (icons/pictures stored in .frx files and compiled VB EXEs)
 * Nothing here interprets what an image is for; usage is attached later from the INI files.
 */
import { decodeBmpFile, decodeDib } from "./bmp.ts";
import { encodePng } from "./png.ts";
import type { BodyMapFile } from "./parse.ts";
import { buildIcoFile, exeKind, type IconImage, parseIcoFile, readResources, resolveGroup, RT } from "./resources.ts";

export interface ImageEntry {
  /** where the image was found: installer path, plus resource or offset details */
  source: string;
  resource?: { type: string; id: number | string; lang: number };
  offset?: number;
  format: "bmp" | "dib" | "ico" | "cur" | "wmf";
  width?: number;
  height?: number;
  bitsPerPixel?: number;
  /** for icons/cursors: one PNG per contained image */
  sizes?: { file: string; width: number; height: number; bitsPerPixel: number; hotspot?: [number, number] }[];
  /** output file (PNG, or .ico/.cur/.wmf) relative to images/ */
  file: string;
  usedFor: string[];
  error?: string;
}

export interface ImageSet {
  entries: ImageEntry[];
  /** output path (relative to images/) -> bytes */
  files: Map<string, Uint8Array>;
  /** lower-case loose bitmap base name -> entry, for linking from the INI files */
  loose: Map<string, ImageEntry>;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stem = (p: string) => base(p).replace(/\.[^.]*$/, "");
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
const TYPE_NAMES: Record<number, string> = {
  1: "CURSOR",
  2: "BITMAP",
  3: "ICON",
  12: "GROUP_CURSOR",
  14: "GROUP_ICON",
};
const typeName = (t: number | string) => typeof t === "number" ? TYPE_NAMES[t] ?? String(t) : t;

const isBmp = (b: Uint8Array) => b.length > 26 && b[0] === 0x42 && b[1] === 0x4d;
const isIco = (b: Uint8Array) => b.length > 22 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0;
const isPlaceableWmf = (b: Uint8Array) =>
  b.length > 22 && b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a;

/**
 * @param files source path -> bytes (installer payload, outer zip entries, nested archives)
 * @param looseDir output sub-folder for a loose bitmap, chosen by the caller from its usage
 */
export async function collectImages(
  files: Map<string, Uint8Array>,
  looseDir: (path: string) => string = () => "bitmaps",
): Promise<ImageSet> {
  const set: ImageSet = { entries: [], files: new Map(), loose: new Map() };
  const used = new Set<string>();
  const unique = (p: string) => {
    let q = p, i = 2;
    while (used.has(q.toLowerCase())) q = p.replace(/(\.[^.]+)$/, `-${i++}$1`);
    used.add(q.toLowerCase());
    return q;
  };
  const add = (e: ImageEntry, bytes: Uint8Array) => {
    set.entries.push(e);
    set.files.set(e.file, bytes);
  };

  const icon = async (dir: string, name: string, images: IconImage[], cursor: boolean, e: Omit<ImageEntry, "file">) => {
    const file = unique(`${dir}/${name}.${cursor ? "cur" : "ico"}`);
    const entry: ImageEntry = { ...e, file, sizes: [] };
    for (const im of images) {
      try {
        const png = im.data[0] === 0x89 && im.data[1] === 0x50 ? im.data : null; // Vista-style PNG icon
        const d = png ? null : decodeDib(im.data, { icon: true });
        const w = d?.width ?? im.width, h = d?.height ?? im.height, bpp = d?.bitsPerPixel ?? im.bitCount;
        const f = unique(`${dir}/${name}-${w}x${h}-${bpp}bpp.png`);
        set.files.set(f, png ?? await encodePng(d!.width, d!.height, d!.rgba));
        entry.sizes!.push({
          file: f,
          width: w,
          height: h,
          bitsPerPixel: bpp,
          ...(im.hotspot ? { hotspot: im.hotspot } : {}),
        });
      } catch (err) {
        entry.error = `${err instanceof Error ? err.message : err}`;
      }
    }
    add(entry, buildIcoFile(images, cursor));
  };

  for (const [path, b] of [...files].sort(([a], [c]) => a < c ? -1 : 1)) {
    if (isBmp(b) && !exeKind(b)) {
      try {
        const d = decodeBmpFile(b);
        const e: ImageEntry = {
          source: path,
          format: "bmp",
          width: d.width,
          height: d.height,
          bitsPerPixel: d.bitsPerPixel,
          // M_abdo.bmp -> M_abdo.png; M_abdo.jk -> M_abdo.jk.png (same picture names with other extensions exist)
          file: unique(`${looseDir(path)}/${safe(/\.bmp$/i.test(path) ? stem(path) : base(path))}.png`),
          usedFor: [],
        };
        add(e, await encodePng(d.width, d.height, d.rgba));
        set.loose.set(base(path).toLowerCase(), e);
      } catch (err) {
        set.entries.push({ source: path, format: "bmp", file: "", usedFor: [], error: `${err}` });
      }
      continue;
    }
    if (isIco(b) && /\.(ico|cur)$/i.test(path)) {
      const ico = parseIcoFile(b);
      await icon(`icons/files`, safe(stem(path)), ico.images, ico.cursor, {
        source: path,
        format: ico.cursor ? "cur" : "ico",
        usedFor: [],
      });
      continue;
    }
    if (/\.frx$/i.test(path) || exeKind(b)) await vbBlobs(path, b, icon, unique, add);
    if (!exeKind(b)) continue;

    const mod = path.startsWith("zip/") ? `installer/${safe(base(path))}` : safe(base(path));
    const rs = readResources(b);
    const toolbars = new Map<number | string, string>();
    for (const r of rs.filter((r) => r.type === RT.TOOLBAR)) {
      const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      toolbars.set(
        r.name,
        `toolbar strip: ${v.getUint16(6, true)} buttons of ${v.getUint16(2, true)}x${v.getUint16(4, true)} px`,
      );
    }
    const isExe = /\.exe$/i.test(path);
    const groupIcons = rs.filter((r) => r.type === RT.GROUP_ICON);
    for (const r of rs) {
      const res = { type: typeName(r.type), id: r.name, lang: r.lang };
      if (r.type === RT.BITMAP) {
        try {
          const d = decodeDib(r.data);
          const usedFor = toolbars.has(r.name) ? [toolbars.get(r.name)!] : [];
          add({
            source: path,
            resource: res,
            format: "dib",
            width: d.width,
            height: d.height,
            bitsPerPixel: d.bitsPerPixel,
            file: unique(`resources/${mod}/bitmap-${safe(String(r.name))}.png`),
            usedFor,
          }, await encodePng(d.width, d.height, d.rgba));
        } catch (err) {
          set.entries.push({ source: path, resource: res, format: "dib", file: "", usedFor: [], error: `${err}` });
        }
      } else if (r.type === RT.GROUP_ICON || r.type === RT.GROUP_CURSOR) {
        const cursor = r.type === RT.GROUP_CURSOR;
        const usedFor = !cursor && isExe && r === groupIcons[0] ? [`application icon of ${base(path)}`] : [];
        await icon(
          `icons/${mod}`,
          `${cursor ? "cursor" : "icon"}-${safe(String(r.name))}`,
          resolveGroup(r, rs),
          cursor,
          {
            source: path,
            resource: res,
            format: cursor ? "cur" : "ico",
            usedFor,
          },
        );
      } else if (isPlaceableWmf(r.data)) {
        add({
          source: path,
          resource: res,
          format: "wmf",
          file: unique(`metafiles/${mod}/${safe(String(r.type))}-${safe(String(r.name))}.wmf`),
          usedFor: ["Windows metafile (vector); kept as .wmf, not converted"],
        }, r.data);
      }
    }
  }
  return set;
}

/**
 * Visual Basic stores form properties such as Icon and Picture as blobs:
 *   u32 size, "lt\0\0", u32 size - 8, then the data (an .ico or a .bmp).
 * They live in .frx files and inside compiled VB EXEs.
 */
async function vbBlobs(
  path: string,
  b: Uint8Array,
  icon: (d: string, n: string, i: IconImage[], c: boolean, e: Omit<ImageEntry, "file">) => Promise<void>,
  unique: (p: string) => string,
  add: (e: ImageEntry, bytes: Uint8Array) => void,
) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 4; i + 16 < b.length; i++) {
    if (b[i] !== 0x6c || b[i + 1] !== 0x74 || b[i + 2] !== 0 || b[i + 3] !== 0) continue;
    const size = v.getUint32(i - 4, true), inner = v.getUint32(i + 4, true);
    if (inner + 8 !== size || i + 8 + inner > b.length) continue;
    const data = b.subarray(i + 8, i + 8 + inner);
    const name = `${safe(stem(path))}-vb-${i - 4}`;
    if (isIco(data)) {
      const ico = parseIcoFile(data);
      await icon("icons/vb-forms", name, ico.images, ico.cursor, {
        source: path,
        offset: i - 4,
        format: ico.cursor ? "cur" : "ico",
        usedFor: ["Visual Basic form Icon property"],
      });
    } else if (isBmp(data)) {
      try {
        const d = decodeBmpFile(data);
        add({
          source: path,
          offset: i - 4,
          format: "bmp",
          width: d.width,
          height: d.height,
          bitsPerPixel: d.bitsPerPixel,
          file: unique(`bitmaps/vb-forms/${name}.png`),
          usedFor: ["Visual Basic form Picture property"],
        }, await encodePng(d.width, d.height, d.rgba));
      } catch { /* not a picture after all */ }
    }
  }
}

/**
 * What each loose bitmap is used for, from the body-map INI files, and the
 * output folder that follows from it (bodymap/ or buttons/; others bitmaps/).
 */
export function bodyMapUsage(bodyMaps: Map<string, BodyMapFile>): Map<string, { dir: string; usedFor: string[] }> {
  // bitmap -> description -> { maps, files }
  const uses = new Map<string, { dir: string; uses: Map<string, { maps: Set<string>; files: Set<string> }> }>();
  const note = (bmp: string | null, dir: string, what: string, map: string | null, file: string) => {
    if (!bmp || bmp.toLowerCase() === "null") return;
    const k = bmp.toLowerCase();
    const u = uses.get(k) ?? { dir, uses: new Map() };
    if (dir === "bodymap") u.dir = dir; // a body-map picture also used as a button stays in bodymap/
    const w = u.uses.get(what) ?? { maps: new Set(), files: new Set() };
    if (map) w.maps.add(map === "_toplevel" ? "(top level)" : map);
    w.files.add(file);
    u.uses.set(what, w);
    uses.set(k, u);
  };
  for (const [file, b] of bodyMaps) {
    for (const [map, g] of b.mainGraphics) {
      note(g.inset, "bodymap", "main picture of the map; location hotspots are in its pixels", map, file);
    }
    for (const [map, locs] of b.maps) {
      for (const l of locs) {
        if (l.root) {
          note(l.inset, "bodymap", `main picture (${l.concept}); location hotspots are in its pixels`, map, file);
        } else note(l.inset, "bodymap", `close-up of ${l.concept}; sublocation hotspots are in its pixels`, map, file);
      }
    }
    for (const sel of b.selectors) {
      const label = sel.settings.Label?.join(",") ?? "selector";
      for (const o of sel.options) {
        o.bitmaps.forEach((bmp, i) =>
          note(bmp, "buttons", `${label} button "${o.label}" (${o.system}), bitmap ${i + 1} of 2`, null, file)
        );
      }
    }
  }
  return new Map([...uses].map(([k, u]) => [k, {
    dir: u.dir,
    usedFor: [...u.uses].map(([what, w]) =>
      `${what}${w.maps.size ? `; maps: ${[...w.maps].join(", ")}` : ""} [${[...w.files].join(", ")}]`
    ),
  }]));
}

/**
 * Other places that name a bitmap: any INI line (e.g. Options.ini BANNERSCREEN) and
 * file names embedded in the program files. Returns lower-case name -> notes.
 */
export function otherBitmapMentions(
  inis: Map<string, string>,
  programs: Map<string, Uint8Array>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (n: string, note: string) => {
    const k = n.toLowerCase();
    const l = out.get(k) ?? [];
    if (!l.includes(note)) l.push(note);
    out.set(k, l);
  };
  for (const [file, text] of inis) {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("OptionButton")) continue;
      for (const m of t.matchAll(/([A-Za-z0-9_]+\.bmp)\b/gi)) {
        const key = t.split(",")[0];
        if (/^[A-Z][A-Z_]+$/.test(key)) add(m[1], `${file}: ${key}`);
      }
    }
  }
  for (const [path, b] of programs) {
    const text = new TextDecoder("latin1").decode(b);
    for (const m of text.matchAll(/[A-Za-z0-9_]{2,12}\.bmp(?=\0)/gi)) add(m[0], `file name appears in ${base(path)}`);
  }
  return out;
}
