/**
 * Read the names of all OpenGALEN 8 entities from the public OWL release.
 *
 * Accepted inputs:
 *  - opengalen8-owl-sources.zip as downloaded (https://opengalen.eggbird.eu/download/opengalen8-owl-sources.zip)
 *  - a directory where that zip was unpacked
 *  - a single OWL Functional-syntax (.owl) file or a hierarchy dump (.dump)
 *
 * From OWL Functional syntax we take every
 *   Declaration(Class|ObjectProperty|DataProperty|NamedIndividual(<...#Name>))
 * and from hierarchy dumps every name in "(implies A B)" / "(equivalent A B)".
 * RDF/XML copies in the release duplicate the OWL-F files and are skipped.
 */
import { join } from "@std/path";
import { ZipArchive } from "./zip.ts";

export type OgKind = "Class" | "ObjectProperty" | "DataProperty" | "NamedIndividual";
export const OG_NAMESPACE = "http://www.opengalen.org/owl/opengalen.owl#";

/** name -> kind (Class unless declared otherwise). */
export type OgNames = Map<string, OgKind>;

const DECL = /Declaration\((Class|ObjectProperty|DataProperty|NamedIndividual)\(<[^>#]*#([^>]+)>\)\)/g;
const DUMP = /^\((?:implies|equivalent) (\S+) (\S+)\)/gm;

/** Add the names found in one file's text. */
export function scanText(text: string, kindOf: "owl" | "dump", into: OgNames): void {
  if (kindOf === "owl") {
    for (const m of text.matchAll(DECL)) {
      const prev = into.get(m[2]);
      if (!prev || prev === "Class") into.set(m[2], m[1] as OgKind);
    }
  } else {
    for (const m of text.matchAll(DUMP)) for (const n of [m[1], m[2]]) if (!into.has(n)) into.set(n, "Class");
  }
}

const kindByName = (p: string): "owl" | "dump" | null =>
  /\/RDF\//i.test(p) ? null : /\.owl$/i.test(p) ? "owl" : /\.dump$/i.test(p) ? "dump" : null;

/**
 * Load OpenGALEN names. For a zip or directory we read all OWL-F files and the
 * dump named by `dumpName` (default: the full model without property chains,
 * which lists every classified class).
 */
export async function loadOpenGalenNames(
  source: string,
  dumpName = "OpenGALEN8_WithoutPropertyChains_CRM+Diseases+SurgicalProcedures+DrugOntology.dump",
): Promise<{ names: OgNames; files: string[] }> {
  const names: OgNames = new Map();
  const files: string[] = [];
  const dec = new TextDecoder("latin1");
  const want = (p: string) => {
    const k = kindByName(p);
    return k === "owl" || (k === "dump" && p.endsWith(dumpName)) ? k : null;
  };
  const st = await Deno.stat(source);
  if (st.isDirectory) {
    for await (const p of walk(source)) {
      const k = want(p);
      if (k) {
        scanText(dec.decode(await Deno.readFile(p)), k, names);
        files.push(p);
      }
    }
  } else if (/\.zip$/i.test(source)) {
    const z = await ZipArchive.open(source);
    for (const e of z.entries) {
      const k = want(e.name);
      if (k && !e.isDirectory) {
        scanText(dec.decode(await z.read(e)), k, names);
        files.push(e.name);
      }
    }
  } else {
    const k = kindByName(source) ?? "owl";
    scanText(dec.decode(await Deno.readFile(source)), k, names);
    files.push(source);
  }
  if (!names.size) throw new Error(`no OpenGALEN names found in ${source}`);
  return { names, files };
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile) yield p;
  }
}
