/**
 * Load an in-memory index of the public OpenGALEN 8 release.
 *
 * Accepted inputs:
 *  - opengalen8-owl-sources.zip as downloaded (https://opengalen.eggbird.eu/download/opengalen8-owl-sources.zip)
 *  - a directory where that zip was unpacked
 *  - a single OWL Functional-syntax (.owl) file or a hierarchy dump (.dump)
 *
 * What we keep (enough to verify names and reason about meaning, but lean):
 *  - every declared entity and its kind (OWL-F `Declaration(...)`)
 *  - parents/children/equivalents from the classified hierarchy dump
 *    ("(implies A B)" = A is-a B, "(equivalent A B)") and SubObjectPropertyOf
 *  - for "named" (not machine-generated) entities only: their logical
 *    definition axioms (EquivalentClasses / SubClassOf / property axioms) with
 *    IRIs shortened to names, their GRAIL sanctions (S-SANCTION-<attr>AP) and
 *    labels / language annotations. Generated classes have names that spell
 *    out their definition ("...which...") and number over 100,000, so their
 *    axioms are skipped to keep memory small.
 * RDF/XML copies in the release duplicate the OWL-F files and are skipped.
 */
import { join } from "@std/path";
import { ZipArchive } from "./zip.ts";

export type OgKind = "Class" | "ObjectProperty" | "DataProperty" | "NamedIndividual";
export const OG_NAMESPACE = "http://www.opengalen.org/owl/opengalen.owl#";
/** Default dump: the full model WITHOUT property chains (the with-chains dumps contain known inversions). */
export const DEFAULT_DUMP = "OpenGALEN8_WithoutPropertyChains_CRM+Diseases+SurgicalProcedures+DrugOntology.dump";

/** True for machine-generated class names such as "PainwhichhasLocationThumb". */
export const isGenerated = (name: string) => /which/.test(name);

export class OgIndex {
  kinds = new Map<string, OgKind>();
  parents = new Map<string, Set<string>>();
  children = new Map<string, Set<string>>();
  equivalents = new Map<string, Set<string>>();
  /** definition axioms (shortened) for named entities */
  axioms = new Map<string, string[]>();
  /** sanctions: attribute -> allowed fillers, for named entities */
  sanctions = new Map<string, Map<string, string[]>>();
  /** annotation property -> values (labels, language annotations, ...) for named entities */
  annotations = new Map<string, Map<string, string[]>>();
  files: string[] = [];

  has(name: string) {
    return this.kinds.has(name);
  }
  addEdge(child: string, parent: string) {
    if (child === parent) return;
    add(this.parents, child, parent);
    add(this.children, parent, child);
  }
}

const IRI = /<http:\/\/www\.opengalen\.org\/owl\/opengalen\.owl#([^>]+)>/g;
const short = (s: string) => s.replace(IRI, "$1");
const MAX_AXIOM = 4000; // characters kept per axiom

/** Add one OWL Functional-syntax file to the index. */
export function scanOwl(text: string, ix: OgIndex): void {
  for (const line of text.split("\n")) {
    if (line.startsWith("Declaration(")) {
      const m = line.match(/^Declaration\((Class|ObjectProperty|DataProperty|NamedIndividual)\(<[^>#]*#([^>]+)>\)\)/);
      if (m) {
        const prev = ix.kinds.get(m[2]);
        if (!prev || prev === "Class") ix.kinds.set(m[2], m[1] as OgKind);
      }
    } else if (line.startsWith("AnnotationAssertion(")) {
      const m = line.match(/^AnnotationAssertion\((rdfs:label|<[^>#]*#([^>]+)>) <[^>#]*#([^>]+)> "((?:[^"\\]|\\.)*)"/);
      if (!m || isGenerated(m[3])) continue;
      const prop = m[2] ?? "label";
      if (prop === "SANCTION-LEVELAP" || prop === "hasDissectionRubricAP" || prop === "hasDrugFeatureAP") continue;
      const s = prop.match(/^[SG]-SANCTION-(.+)AP$/);
      if (s) addList(ix.sanctions, m[3], s[1], m[4]);
      else addList(ix.annotations, m[3], prop.replace(/AP$/, ""), m[4]);
    } else if (
      /^(EquivalentClasses|SubClassOf|SubObjectPropertyOf|InverseObjectProperties|FunctionalObjectProperty|ObjectPropertyDomain|ObjectPropertyRange)\(/
        .test(line)
    ) {
      const m = line.match(/^\w+\(<[^>#]*#([^>]+)>/);
      if (!m) continue;
      const subject = m[1];
      if (line.startsWith("SubObjectPropertyOf(")) {
        const p = short(line).match(/^SubObjectPropertyOf\((\S+) (\S+)\)/);
        if (p) ix.addEdge(p[1], p[2]);
      }
      if (isGenerated(subject)) continue;
      const ax = short(line.trim());
      const list = ix.axioms.get(subject) ?? [];
      list.push(ax.length > MAX_AXIOM ? ax.slice(0, MAX_AXIOM) + " …(truncated)" : ax);
      ix.axioms.set(subject, list);
    }
  }
}

/** Add a hierarchy dump ("(implies A B)", "(equivalent A B)") to the index. */
export function scanDump(text: string, ix: OgIndex): void {
  for (const m of text.matchAll(/^\((implies|equivalent) (\S+) (\S+)\)/gm)) {
    const [, rel, a, b] = m;
    for (const n of [a, b]) if (!ix.kinds.has(n)) ix.kinds.set(n, "Class");
    if (rel === "implies") ix.addEdge(a, b);
    else {
      add(ix.equivalents, a, b);
      add(ix.equivalents, b, a);
    }
  }
}

/** Load the index from a zip, directory, or single file (see module comment). */
export async function loadOpenGalen(source: string, dumpName = DEFAULT_DUMP): Promise<OgIndex> {
  const ix = new OgIndex();
  const dec = new TextDecoder("latin1");
  const want = (p: string): "owl" | "dump" | null =>
    /\/RDF\//i.test(p) ? null : /\.owl$/i.test(p) ? "owl" : p.endsWith(dumpName) ? "dump" : null;
  const take = (k: "owl" | "dump", text: string, name: string) => {
    if (k === "owl") scanOwl(text, ix);
    else scanDump(text, ix);
    ix.files.push(name);
  };
  const st = await Deno.stat(source);
  if (st.isDirectory) {
    for await (const p of walk(source)) {
      const k = want(p);
      if (k) take(k, dec.decode(await Deno.readFile(p)), p);
    }
  } else if (/\.zip$/i.test(source)) {
    const z = await ZipArchive.open(source);
    for (const e of z.entries) {
      const k = e.isDirectory ? null : want(e.name);
      if (k) take(k, dec.decode(await z.read(e)), e.name);
    }
  } else {
    take(/\.dump$/i.test(source) ? "dump" : "owl", dec.decode(await Deno.readFile(source)), source);
  }
  if (!ix.kinds.size) throw new Error(`no OpenGALEN names found in ${source}`);
  return ix;
}

function add<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
  let s = m.get(k);
  if (!s) m.set(k, s = new Set());
  s.add(v);
}
function addList(m: Map<string, Map<string, string[]>>, subject: string, key: string, v: string) {
  let inner = m.get(subject);
  if (!inner) m.set(subject, inner = new Map());
  const l = inner.get(key) ?? [];
  if (!l.includes(v)) l.push(v);
  inner.set(key, l);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile) yield p;
  }
}
