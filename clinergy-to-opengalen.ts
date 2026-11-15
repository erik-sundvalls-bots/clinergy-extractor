#!/usr/bin/env -S deno run -A
/**
 * clinergy-to-opengalen: deterministic preprocessor for mapping Clinergy
 * names to OpenGALEN 8.
 *
 * It records only mappings that need no judgement and turns everything else
 * into a review worklist. The worklist gives each name its context from the
 * Clinergy model, so a reviewer can decide what it means. The reviewer can be
 * a person, or an AI agent following ai/map-to-opengalen/SKILL.md with the
 * read-only OpenGALEN MCP server in mcp/opengalen-mcp.ts.
 *
 * Usage:
 *   deno run -A clinergy-to-opengalen.ts out/ opengalen8-owl-sources.zip map/ [--reviewed map/reviewed.yaml] [--annotate]
 *
 *   out/      output folder of clinergy-extract.ts
 *   source    OpenGALEN 8 OWL release zip, its unpacked folder, or one .owl/.dump file
 *             (download: https://opengalen.eggbird.eu/download/opengalen8-owl-sources.zip)
 *   map/      written here:
 *               mappings.yaml          verified mappings only: exact, normalised (single match), reviewed
 *               worklist/<kind>.yaml   every other name, with context and unverified lexical hints
 *               summary.yaml           counts, plus any rejected reviewed entries
 *
 * Options:
 *   --reviewed FILE   reviewed mappings to merge (repeatable). Each entry is
 *                       ClinergyName: { opengalen: Name | null, confidence: high|medium|low,
 *                                       rationale: "...", needsHumanReview: true|false }
 *                     The OpenGALEN name must exist in the loaded release; entries
 *                     naming anything else are rejected and listed in summary.yaml.
 *                     opengalen: null records "reviewed, no suitable OpenGALEN concept".
 *   --annotate        append an "opengalen:" block with the verified mappings
 *                     (no guesses) to every form file; re-running replaces it
 *   --hints N         lexical hints per worklist entry (default 5; 0 = none)
 */
import { parseArgs } from "@std/cli/parse-args";
import { parse } from "@std/yaml";
import { join } from "@std/path";
import { loadOpenGalen, OG_NAMESPACE, type OgKind } from "./src/opengalen.ts";
import { Matcher } from "./src/mapping.ts";
import { toYaml } from "./src/yaml.ts";
import { COPYRIGHT } from "./src/write.ts";

/** What role a Clinergy name plays; a name can have several. */
export type NameKind = "formTopic" | "exam" | "descriptor" | "criterialLink" | "value" | "concept";
/** A name is listed in the worklist file of its first kind in this order. */
const KIND_ORDER: NameKind[] = ["formTopic", "exam", "descriptor", "criterialLink", "value", "concept"];
const CAP = 5;

type Yaml = Record<string, unknown>;
const readYaml = async (p: string) => parse(await Deno.readTextFile(p)) as Yaml;

/** Where and how a name is used, gathered while reading the model. */
interface Usage {
  kinds: Set<NameKind>;
  /** descriptor/criterial link: forms using it and the value sets offered */
  forms: string[];
  valueSets: Map<string, string[]>;
  /** value: feature -> siblings / forms */
  asValueOf: Map<string, { siblings: string[]; forms: string[] }>;
}

export interface Model {
  names: Map<string, Usage>;
  concepts: Yaml;
  exams: Yaml;
  descriptors: Yaml;
  lexicon: Yaml;
  forms: { topic: string; file: string; form: Yaml }[];
}

/** Read the extractor output and record every name with where it is used. */
export async function readModel(outDir: string): Promise<Model> {
  const names = new Map<string, Usage>();
  const use = (n: unknown, k: NameKind): Usage | null => {
    if (typeof n !== "string" || !n) return null;
    let u = names.get(n);
    if (!u) names.set(n, u = { kinds: new Set(), forms: [], valueSets: new Map(), asValueOf: new Map() });
    u.kinds.add(k);
    return u;
  };
  const feature = (f: string, k: NameKind, topic: string, values: string[]) => {
    const u = use(f, k);
    if (!u) return;
    if (!u.forms.includes(topic)) u.forms.push(topic);
    if (values.length) u.valueSets.set(values.join("|"), values);
    for (const v of values) {
      const vu = use(v, "value")!;
      const e = vu.asValueOf.get(f) ?? { siblings: [], forms: [] };
      for (const s of values) if (s !== v && !e.siblings.includes(s)) e.siblings.push(s);
      if (!e.forms.includes(topic)) e.forms.push(topic);
      vu.asValueOf.set(f, e);
    }
  };

  const concepts = await readYaml(join(outDir, "concepts.yaml"));
  for (const [n, c] of Object.entries(concepts)) {
    use(n, String((c as Yaml).category ?? "").startsWith("Complete") ? "formTopic" : "concept");
  }
  const exams = await readYaml(join(outDir, "exams.yaml"));
  for (const n of Object.keys(exams)) use(n, "exam");
  const rules = await readYaml(join(outDir, "sentence-rules.yaml"));
  const descriptors = (rules.descriptors ?? {}) as Yaml;
  for (const n of Object.keys(descriptors)) use(n, "descriptor");
  // summary types: "Name: { attribute value } { attribute value } ..."
  for (const s of (rules.summaryTypes as string[]) ?? []) {
    const name = s.slice(0, s.indexOf(":"));
    const byAttr = new Map<string, string[]>();
    for (const m of s.matchAll(/\{\s*(\S+)\s+(\S+)\s*\}/g)) byAttr.set(m[1], [...(byAttr.get(m[1]) ?? []), m[2]]);
    for (const [att, vals] of byAttr) feature(att, "descriptor", `summaryType:${name}`, vals);
  }

  const forms: Model["forms"] = [];
  for (const [topic, f] of Object.entries(await readYaml(join(outDir, "forms/index.yaml")))) {
    const file = join(outDir, String((f as Yaml).file));
    const form = await readYaml(file);
    forms.push({ topic, file, form });
    use(form.topic, "formTopic");
    for (const item of [...(form.firstLayer as Yaml[] ?? []), ...(form.moreLayer as Yaml[] ?? [])]) {
      const values: string[] = [];
      for (const v of (item.values as unknown[]) ?? []) {
        if (typeof v === "string") values.push(v);
        else if (v && typeof v === "object") {
          const o = v as Yaml;
          if (o.attribute) feature(String(o.attribute), "descriptor", topic, o.value ? [String(o.value)] : []);
        }
      }
      if (item.criterialLink) feature(String(item.criterialLink), "criterialLink", topic, values);
      else if (item.feature && !["laterality", "sublocation"].includes(String(item.feature))) {
        feature(String(item.feature), "descriptor", topic, values);
      }
    }
  }
  return { names, concepts, exams, descriptors, lexicon: (rules.lexicon ?? {}) as Yaml, forms };
}

/** A verified mapping as written to mappings.yaml. */
export interface Mapping {
  opengalen: string | null;
  kind?: OgKind;
  iri?: string;
  method: "exact" | "normalised" | "reviewed" | "reviewed-no-match";
  needsHumanReview: boolean;
  confidence?: string;
  rationale?: string;
}

const sample = (xs: string[]) => xs.length <= CAP ? xs : [...xs.slice(0, CAP), `... ${xs.length - CAP} more`];

/** Context for one worklist entry, taken only from the Clinergy model. */
export function context(n: string, u: Usage, m: Model): Yaml {
  const e: Yaml = { kinds: KIND_ORDER.filter((k) => u.kinds.has(k)) };
  const c = m.concepts[n] as Yaml | undefined;
  if (c) {
    Object.assign(e, { display: c.display, category: c.category, summaryType: c.summaryType, supers: c.supers });
    const form = m.forms.find((f) => f.topic === n);
    if (form?.form.location) e.location = form.form.location;
  }
  const x = m.exams[n] as Yaml | undefined;
  if (x) {
    Object.assign(e, { examGroup: x.group, examSuper: x.super, baseSign: x.baseSign, baseLocation: x.baseLocation });
  }
  const lex = ((m.lexicon.descriptors ?? {}) as Yaml)[n] as Yaml | undefined;
  if (lex) e.sentenceWords = lex;
  const d = m.descriptors[n] as Yaml | undefined;
  if (d) e.sentenceValues = sample([...new Set(((d.rules as Yaml[]) ?? []).map((r) => String(r.value)))]);
  if (u.forms.length) e.usedInForms = { count: u.forms.length, examples: u.forms.slice(0, CAP) };
  if (u.valueSets.size) e.valueSets = [...u.valueSets.values()].slice(0, CAP);
  if (u.asValueOf.size) {
    e.usedAsValueOf = [...u.asValueOf].sort((a, b) => b[1].forms.length - a[1].forms.length).slice(0, CAP).map((
      [feature, v],
    ) => ({ feature, siblings: sample(v.siblings), forms: v.forms.length, example: v.forms[0] }));
  }
  const adverb = ((m.lexicon.valueAdverbs ?? {}) as Yaml)[n];
  if (adverb) e.adverb = adverb;
  return e;
}

/** Load and verify reviewed mappings; unknown names are rejected, never kept. */
export async function loadReviewed(files: string[], known: (n: string) => boolean, exists: (og: string) => boolean) {
  const accepted = new Map<string, Mapping>();
  const rejected: Yaml[] = [];
  for (const f of files) {
    for (const [n, raw] of Object.entries(await readYaml(f) ?? {})) {
      const r = (raw ?? {}) as Yaml;
      const og = r.opengalen == null ? null : String(r.opengalen);
      if (!known(n)) rejected.push({ file: f, clinergy: n, reason: "not a Clinergy name in this extraction" });
      else if (og !== null && !exists(og)) {
        rejected.push({ file: f, clinergy: n, opengalen: og, reason: "not an OpenGALEN 8 name" });
      } else {
        accepted.set(n, {
          opengalen: og,
          method: og === null ? "reviewed-no-match" : "reviewed",
          needsHumanReview: r.needsHumanReview !== false,
          ...(r.confidence ? { confidence: String(r.confidence) } : {}),
          ...(r.rationale ? { rationale: String(r.rationale) } : {}),
        });
      }
    }
  }
  return { accepted, rejected };
}

const MARK = "# --- OpenGALEN 8 mappings (added by clinergy-to-opengalen: verified or reviewed only) ---";

/** Append (or replace) the opengalen block at the end of one form file. */
export async function annotateForm(file: string, maps: Map<string, Mapping>) {
  const text = await Deno.readTextFile(file);
  const body = text.includes(MARK) ? text.slice(0, text.indexOf(MARK)) : text;
  const form = parse(body) as Yaml;
  const brief = (n: string) => {
    const m = maps.get(n);
    if (!m?.opengalen) return undefined;
    return {
      opengalen: m.opengalen,
      method: m.method,
      ...(m.confidence ? { confidence: m.confidence } : {}),
      needsHumanReview: m.needsHumanReview,
    };
  };
  const items: Yaml = {}, values: Yaml = {};
  for (const it of [...(form.firstLayer as Yaml[] ?? []), ...(form.moreLayer as Yaml[] ?? [])]) {
    const key = String(it.criterialLink ?? it.feature);
    if (brief(key)) items[key] = brief(key);
    for (const v of (it.values as unknown[]) ?? []) {
      const n = typeof v === "string" ? v : String((v as Yaml)?.value ?? "");
      if (brief(n)) values[n] = brief(n);
    }
  }
  const block = toYaml({ opengalen: { topic: brief(String(form.topic)) ?? null, items, values } });
  await Deno.writeTextFile(file, `${body.trimEnd()}\n${MARK}\n${block}`);
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, {
    string: ["hints"],
    collect: ["reviewed"],
    boolean: ["annotate", "help"],
    alias: { h: "help" },
  });
  if (a.help || a._.length !== 3) {
    console.error(
      "usage: deno run -A clinergy-to-opengalen.ts <extract-out-dir> <opengalen-source> <map-dir> " +
        "[--reviewed FILE ...] [--annotate] [--hints 5]",
    );
    return a.help ? 0 : 2;
  }
  const [outDir, source, mapDir] = a._.map(String);
  const nHints = a.hints === undefined ? CAP : Number(a.hints);
  console.error(`Reading OpenGALEN 8 from ${source} ...`);
  const og = await loadOpenGalen(source);
  console.error(`  ${og.kinds.size} names from ${og.files.length} files`);
  const model = await readModel(outDir);
  const reviewed = await loadReviewed(
    (a.reviewed as string[] | undefined) ?? [],
    (n) => model.names.has(n),
    (n) => og.has(n),
  );
  console.error(`Matching ${model.names.size} Clinergy names ...`);
  const matcher = new Matcher(og.kinds, { maxCandidates: Math.max(nHints, 1) });

  const mappings = new Map<string, Mapping>();
  const worklist: Record<NameKind, Yaml> = Object.fromEntries(KIND_ORDER.map((k) => [k, {}])) as Record<
    NameKind,
    Yaml
  >;
  const counts: Record<string, number> = {};
  const verified = (og_: string, method: "exact" | "normalised"): Mapping => ({
    opengalen: og_,
    kind: og.kinds.get(og_),
    iri: OG_NAMESPACE + og_,
    method,
    needsHumanReview: method !== "exact",
  });
  for (const n of [...model.names.keys()].sort()) {
    const u = model.names.get(n)!;
    const r = matcher.match(n);
    let m: Mapping | undefined;
    if (r.status === "exact") m = verified(n, "exact");
    else if (reviewed.accepted.has(n)) {
      m = reviewed.accepted.get(n)!;
      if (m.opengalen) Object.assign(m, { kind: og.kinds.get(m.opengalen), iri: OG_NAMESPACE + m.opengalen });
    } else if (r.status === "normalised" && r.candidates.length === 1) m = verified(r.candidates[0].name, "normalised");
    if (m) {
      mappings.set(n, m);
      counts[m.method] = (counts[m.method] ?? 0) + 1;
      continue;
    }
    const kind = KIND_ORDER.find((k) => u.kinds.has(k))!;
    const hints = r.candidates.slice(0, nHints).map((c) => ({
      name: c.name,
      score: c.score,
      why: c.reason,
    }));
    worklist[kind][n] = {
      ...context(n, u, model),
      unverifiedHints: hints,
    };
    counts.worklist = (counts.worklist ?? 0) + 1;
  }

  const header = (t: string, extra: string[] = []) => [
    t,
    "Generated by clinergy-to-opengalen from a private Clinergy extraction and the OpenGALEN 8 OWL release.",
    `Clinergy names: ${COPYRIGHT}`,
    "OpenGALEN: GALEN Open Source License (https://opengalen.eggbird.eu/gosl.html).",
    ...extra,
  ];
  await Deno.mkdir(join(mapDir, "worklist"), { recursive: true });
  await Deno.writeTextFile(
    join(mapDir, "mappings.yaml"),
    toYaml(
      Object.fromEntries(mappings),
      header("Verified Clinergy -> OpenGALEN 8 mappings", [
        "method: exact = identical name; normalised = the only name equal after case/punctuation/spelling",
        "normalisation; reviewed = from a --reviewed file, OpenGALEN name verified to exist.",
      ]),
    ),
  );
  for (const k of KIND_ORDER) {
    await Deno.writeTextFile(
      join(mapDir, "worklist", `${k}.yaml`),
      toYaml(
        worklist[k],
        header(`Review worklist: Clinergy ${k} names without a verified OpenGALEN 8 mapping`, [
          "Context comes from the Clinergy model. unverifiedHints are lexical look-alikes only: they are",
          "NOT mappings and are often wrong in meaning. Review with ai/map-to-opengalen/SKILL.md.",
        ]),
      ),
    );
  }
  const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, Object.keys(worklist[k]).length]));
  await Deno.writeTextFile(
    join(mapDir, "summary.yaml"),
    toYaml({
      opengalenSource: source,
      opengalenNames: og.kinds.size,
      clinergyNames: model.names.size,
      mapped: counts,
      worklistByKind: byKind,
      reviewedFiles: (a.reviewed as string[] | undefined) ?? [],
      reviewedRejected: reviewed.rejected,
    }, header("Coverage of Clinergy names in OpenGALEN 8")),
  );
  if (a.annotate) {
    for (const f of model.forms) await annotateForm(f.file, mappings);
    console.error(`Annotated ${model.forms.length} form files.`);
  }
  console.error(
    `${model.names.size} names: ${counts.exact ?? 0} exact, ${counts.normalised ?? 0} normalised, ` +
      `${(counts.reviewed ?? 0) + (counts["reviewed-no-match"] ?? 0)} reviewed, ${counts.worklist ?? 0} in worklist` +
      (reviewed.rejected.length ? `; ${reviewed.rejected.length} reviewed entries REJECTED (see summary.yaml)` : ""),
  );
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (e) {
    console.error(`clinergy-to-opengalen: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}
