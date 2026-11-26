/** Build a penpad-image-pack/v1 zip from an existing extract tree (no Wine run). */

import { dirname, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { zipStore } from "./zip-store.ts";

export const PACK_SCHEMA = "penpad-image-pack/v1";
export const DEFAULT_PACK_ZIP = "penpad-image-pack-clinergy-1998.zip";

const NOTICE =
  "© 1997–8 Semantic Technologies Ltd / Victoria University of Manchester. " +
  "Private study copy produced locally from the user's own Clinergy demo. " +
  "Must not be committed, published, or redistributed.";

export interface WriteImagePackOptions {
  /** Preferred INI section in bodymap.yaml (default Onelist.ini, the remake selector). */
  iniFile?: string;
  zipPath?: string;
}

function isAbsentRef(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return !s || s === "null" || s === "none";
}

function stemFromPath(p: unknown): string | null {
  if (isAbsentRef(p) || typeof p !== "string") return null;
  const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
  const stem = base.replace(/\.(png|svg|bmp|dib|jpe?g|gif|webp)$/i, "");
  return isAbsentRef(stem) ? null : stem;
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** @std/yaml stringify cannot emit `undefined`. */
function dropUndefined(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(dropUndefined);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const next = dropUndefined(val);
    if (next !== undefined) out[k] = next;
  }
  return out;
}

async function readFileIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function findImage(extractDir: string, id: string): Promise<{ rel: string; bytes: Uint8Array } | null> {
  const candidates = [
    `images/bodymap/${id}.png`,
    `images/buttons/${id}.png`,
    `images/bitmaps/${id}.png`,
  ];
  for (const rel of candidates) {
    const bytes = await readFileIfExists(join(extractDir, rel));
    if (bytes) return { rel: `images/${rel.slice("images/".length)}`, bytes };
  }
  return null;
}

interface LooseOnelist {
  selectors: Array<Record<string, unknown>>;
  mainGraphics: Record<string, Record<string, unknown>>;
  maps: Record<string, Array<Record<string, unknown>>>;
}

function pickOnelist(bodyMaps: Record<string, unknown>, preferred = "Onelist.ini"): LooseOnelist {
  const order = [preferred, ...Object.keys(bodyMaps).filter((k) => k !== preferred)];
  for (const key of order) {
    const rec = asRecord(bodyMaps[key]);
    if (!rec) continue;
    const maps = asRecord(rec.maps);
    const selectors = rec.selectors;
    const mainGraphics = asRecord(rec.mainGraphics);
    if (maps && Array.isArray(selectors) && mainGraphics) {
      return {
        selectors: selectors as Array<Record<string, unknown>>,
        mainGraphics: mainGraphics as Record<string, Record<string, unknown>>,
        maps: maps as Record<string, Array<Record<string, unknown>>>,
      };
    }
  }
  throw new Error("bodymap.yaml has no INI section with selectors, maps and mainGraphics (expected Onelist.ini)");
}

export function defaultZipPath(extractDir: string): string {
  return join(extractDir, DEFAULT_PACK_ZIP);
}

/**
 * Read an extract directory (bodymap.yaml + images/) and write a local-only
 * image-pack zip next to it (or at zipPath). Returns the path written.
 */
export async function writeImagePack(extractDir: string, opts: WriteImagePackOptions = {}): Promise<{
  zipPath: string;
  imageCount: number;
  mapCount: number;
}> {
  const yamlText = await Deno.readTextFile(join(extractDir, "bodymap.yaml"));
  const bodyMaps = asRecord(parseYaml(yamlText));
  if (!bodyMaps) throw new Error("bodymap.yaml did not parse as a mapping");
  const data = pickOnelist(bodyMaps, opts.iniFile ?? "Onelist.ini");

  const maps: Record<string, unknown> = {};
  const needed = new Set<string>();
  for (const [name, locs] of Object.entries(data.maps)) {
    const mg = data.mainGraphics[name] ?? {};
    const image = (typeof mg.imageId === "string" ? mg.imageId : null) ?? stemFromPath(mg.image) ?? stemFromPath(mg.picture);
    if (!image) continue;
    needed.add(image);
    const regions = (locs ?? []).map((loc) => {
      const insetId = (typeof loc.insetImageId === "string" ? loc.insetImageId : null)
        ?? stemFromPath(loc.insetImage) ?? stemFromPath(loc.inset);
      if (insetId) needed.add(insetId);
      const insetRect = Array.isArray(loc.insetRect) ? loc.insetRect : null;
      return {
        concept: loc.concept,
        label: loc.label ?? null,
        hotspot: loc.hotspot,
        ...(insetId && insetRect ? { inset: { image: insetId, rect: insetRect } } : {}),
        sublocations: Array.isArray(loc.sublocations)
          ? (loc.sublocations as Array<Record<string, unknown>>).map((s) => ({
            concept: s.concept,
            label: s.label ?? null,
            hotspot: s.hotspot,
          }))
          : [],
      };
    });
    maps[name] = {
      image,
      concept: mg.concept,
      hotspot: mg.hotspot,
      rect: mg.rect,
      regions,
    };
  }

  const selectors = data.selectors.map((sel, i) => {
    const settings = asRecord(sel.settings) ?? {};
    const labelOf = (k: string) => {
      const v = settings[k];
      return Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
    };
    const tsFlagType = (typeof sel.tsFlagType === "string" ? sel.tsFlagType : null) ?? labelOf("TSFlagType") ?? "symptom";
    const options = Array.isArray(sel.options) ? sel.options as Array<Record<string, unknown>> : [];
    return {
      id: tsFlagType || `selector-${i + 1}`,
      label: (typeof sel.label === "string" ? sel.label : null) ?? labelOf("Label") ?? `Selector ${i + 1}`,
      tsFlagType,
      style: (typeof sel.style === "string" ? sel.style : null) ?? labelOf("SelectorStyle"),
      options: options.map((o) => {
        const buttons = Array.isArray(o.buttonIds) ? o.buttonIds as unknown[] : [];
        const bitmapImages = Array.isArray(o.bitmapImages) ? o.bitmapImages as unknown[] : [];
        const bitmaps = Array.isArray(o.bitmaps) ? o.bitmaps as unknown[] : [];
        const up = (typeof buttons[0] === "string" ? buttons[0] : null) ?? stemFromPath(bitmapImages[0]) ?? stemFromPath(bitmaps[0]);
        const down = (typeof buttons[1] === "string" ? buttons[1] : null) ?? stemFromPath(bitmapImages[1]) ?? stemFromPath(bitmaps[1]);
        if (up) needed.add(up);
        if (down) needed.add(down);
        return {
          n: String(o.n ?? ""),
          sex: o.sex === "F" || o.sex === "f" ? "F" : "M",
          label: o.label,
          system: o.system,
          anatomyMap: o.anatomyMap ?? "",
          ...(up ? { buttonUp: up } : {}),
          ...(down ? { buttonDown: down } : {}),
        };
      }),
    };
  });

  const images: Record<string, unknown> = {};
  const files: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  for (const id of [...needed].sort()) {
    if (isAbsentRef(id)) continue;
    const found = await findImage(extractDir, id);
    if (!found) {
      missing.push(id);
      continue;
    }
    const size = pngSize(found.bytes) ?? { width: 0, height: 0 };
    if (!size.width || !size.height) missing.push(`${id} (not a PNG or missing size)`);
    const role = found.rel.includes("/buttons/")
      ? "button"
      : Object.values(maps).some((m) => (m as { image?: string }).image === id)
      ? "bodymap"
      : "inset";
    images[id] = { path: found.rel, width: size.width, height: size.height, role };
    files[found.rel] = found.bytes;
  }
  if (missing.length) {
    throw new Error(`Image pack: missing files for ${missing.length} id(s): ${missing.slice(0, 20).join(", ")}${
      missing.length > 20 ? "…" : ""
    }`);
  }

  const pack = {
    schema: PACK_SCHEMA,
    id: "clinergy-1998-local",
    name: "Clinergy 1998 local study copy",
    version: "1.0.0",
    license: { name: "All rights reserved", notice: NOTICE },
    description:
      "Body-map and selector-button images plus Onelist.ini hotspot geometry, extracted locally from the user's own 1998 Clinergy demo. Not for publication.",
    attribution: NOTICE,
    coordinates: { hotspot: "top,bottom,left,right", insetRect: "left,top,width,height" },
    canvas: { width: 240, height: 330 },
    defaultMaps: {
      male: "MaleSurfaceAnatomy" in maps ? "MaleSurfaceAnatomy" : Object.keys(maps)[0],
      female: "FemaleSurfaceAnatomy" in maps ? "FemaleSurfaceAnatomy" : Object.keys(maps)[0],
    },
    images,
    maps,
    selectors,
  };

  const header = [
    "# penpad-image-pack/v1 — local study copy. Do not commit, publish, or redistribute.",
    `# Produced by clinergy-extractor from ${extractDir}.`,
    `# ${NOTICE}`,
    "",
  ].join("\n");
  const packYaml = header + stringifyYaml(dropUndefined(pack));
  files["pack.yaml"] = new TextEncoder().encode(packYaml);

  const zipPath = opts.zipPath ?? defaultZipPath(extractDir);
  const parent = dirname(zipPath);
  if (parent && parent !== "." && parent !== zipPath) {
    await Deno.mkdir(parent, { recursive: true });
  }
  await Deno.writeFile(zipPath, zipStore(files));
  return { zipPath, imageCount: Object.keys(images).length, mapCount: Object.keys(maps).length };
}
