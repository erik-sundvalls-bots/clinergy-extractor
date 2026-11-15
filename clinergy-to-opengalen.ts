#!/usr/bin/env -S deno run -A
/**
 * clinergy-to-opengalen: suggest OpenGALEN 8 names for the Clinergy names in
 * the YAML tree written by clinergy-extract.ts.
 *
 * Usage:
 *   deno run -A clinergy-to-opengalen.ts out/ opengalen8-owl-sources.zip map/ [--annotate]
 *
 *   out/       output folder of clinergy-extract.ts
 *   source     OpenGALEN 8 OWL release zip, its unpacked folder, or one .owl/.dump file
 *              (download: https://opengalen.eggbird.eu/download/opengalen8-owl-sources.zip)
 *   map/       where to write the mapping:
 *                map/summary.yaml               coverage counts per status and per kind of name
 *                map/index.yaml                 one line per Clinergy name
 *                map/names/<A-Z>/<Name>.yaml    full result per Clinergy name
 *
 * Options:
 *   --annotate          also append an "opengalen:" block to every forms/** /*.yaml file
 *                       (re-running replaces the block)
 *   --min-score X       candidate threshold, weighted token Dice 0..1 (default 0.5)
 *   --max-candidates N  candidates kept per name (default 5)
 *
 * Only identical names are reported as a mapping ("exact"). Everything else is
 * "normalised", "candidate" or "unmapped" and is flagged needsReview: true.
 */
import { parseArgs } from "@std/cli/parse-args";
import { parse } from "@std/yaml";
import { dirname, join } from "@std/path";
import { loadOpenGalenNames, OG_NAMESPACE } from "./src/opengalen.ts";
import { type MappingResult, Matcher, type Status } from "./src/mapping.ts";
import { toYaml } from "./src/yaml.ts";
import { COPYRIGHT, SlugAllocator } from "./src/write.ts";

/** What role a Clinergy name plays; a name can have several. */
export type NameKind = "concept" | "formTopic" | "descriptor" | "value" | "criterialLink" | "exam";

type Yaml = Record<string, unknown>;
const readYaml = async (p: string) => parse(await Deno.readTextFile(p)) as Yaml;

/** Collect every Clinergy name and its roles from an extractor output folder. */
export async function collectNames(outDir: string): Promise<{ names: Map<string, Set<NameKind>>; forms: string[] }> {
  const names = new Map<string, Set<NameKind>>();
  const add = (n: unknown, k: NameKind) => {
    if (typeof n !== "string" || !n) return;
    let s = names.get(n);
    if (!s) names.set(n, s = new Set());
    s.add(k);
  };
  const concepts = await readYaml(join(outDir, "concepts/index.yaml"));
  for (const [n, c] of Object.entries(concepts)) {
    add(n, "concept");
    if (String((c as Yaml).category ?? "").startsWith("Complete")) add(n, "formTopic");
  }
  for (const n of Object.keys(await readYaml(join(outDir, "exams/index.yaml")))) add(n, "exam");
  for (const n of Object.keys(await readYaml(join(outDir, "sentence-rules/index.yaml")))) add(n, "descriptor");
  const forms: string[] = [];
  for (const f of Object.values(await readYaml(join(outDir, "forms/index.yaml")))) {
    const file = join(outDir, String((f as Yaml).file));
    forms.push(file);
    const form = await readYaml(file);
    for (const item of [...(form.firstLayer as Yaml[] ?? []), ...(form.moreLayer as Yaml[] ?? [])]) {
      if (item.feature && !["laterality", "sublocation"].includes(String(item.feature))) {
        add(item.feature, "descriptor");
      }
      if (item.criterialLink) add(item.criterialLink, "criterialLink");
      for (const v of (item.values as unknown[]) ?? []) {
        if (typeof v === "string") add(v, "value");
        else if (v && typeof v === "object") {
          add((v as Yaml).attribute, "descriptor");
          add((v as Yaml).value, "value");
        }
      }
    }
  }
  return { names, forms };
}

/** Coverage counts: overall and per name kind. */
export function summarise(results: Map<string, MappingResult>, kinds: Map<string, Set<NameKind>>) {
  const blank = (): Record<Status | "total", number> => ({
    total: 0,
    exact: 0,
    normalised: 0,
    candidate: 0,
    unmapped: 0,
  });
  const all = blank();
  const byKind: Record<string, ReturnType<typeof blank>> = {};
  for (const [n, r] of results) {
    all.total++;
    all[r.status]++;
    for (const k of kinds.get(n) ?? []) {
      const b = byKind[k] ??= blank();
      b.total++;
      b[r.status]++;
    }
  }
  const pct = (c: ReturnType<typeof blank>) => ({
    ...c,
    exactPercent: c.total ? Math.round((1000 * c.exact) / c.total) / 10 : 0,
  });
  return { all: pct(all), byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, pct(v)])) };
}

const MARK = "# --- OpenGALEN 8 names (added by clinergy-to-opengalen; non-exact entries need review) ---";
const brief = (r: MappingResult | undefined) =>
  !r
    ? null
    : r.status === "exact"
    ? { status: r.status, name: r.opengalen }
    : { status: r.status, best: r.candidates[0]?.name ?? null, score: r.candidates[0]?.score ?? null };

/** Append (or replace) the opengalen block at the end of one form file. */
export async function annotateForm(file: string, results: Map<string, MappingResult>) {
  const text = await Deno.readTextFile(file);
  const body = text.includes(MARK) ? text.slice(0, text.indexOf(MARK)) : text;
  const form = parse(body) as Yaml;
  const items: Yaml = {}, values: Yaml = {};
  for (const it of [...(form.firstLayer as Yaml[] ?? []), ...(form.moreLayer as Yaml[] ?? [])]) {
    const key = String(it.feature ?? it.criterialLink);
    if (results.has(key)) items[key] = brief(results.get(key));
    for (const v of (it.values as unknown[]) ?? []) {
      const n = typeof v === "string" ? v : String((v as Yaml)?.value ?? "");
      if (results.has(n)) values[n] = brief(results.get(n));
    }
  }
  const block = toYaml({ opengalen: { topic: brief(results.get(String(form.topic))), items, values } });
  await Deno.writeTextFile(file, `${body.trimEnd()}\n${MARK}\n${block}`);
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, {
    string: ["min-score", "max-candidates"],
    boolean: ["annotate", "help"],
    alias: { h: "help" },
  });
  if (a.help || a._.length !== 3) {
    console.error(
      "usage: deno run -A clinergy-to-opengalen.ts <extract-out-dir> <opengalen-source> <map-dir> " +
        "[--annotate] [--min-score 0.5] [--max-candidates 5]",
    );
    return a.help ? 0 : 2;
  }
  const [outDir, source, mapDir] = a._.map(String);
  console.error(`Reading OpenGALEN names from ${source} ...`);
  const og = await loadOpenGalenNames(source);
  console.error(`  ${og.names.size} names from ${og.files.length} files`);
  const { names, forms } = await collectNames(outDir);
  console.error(`Matching ${names.size} Clinergy names ...`);
  const matcher = new Matcher(og.names, {
    minScore: a["min-score"] ? Number(a["min-score"]) : undefined,
    maxCandidates: a["max-candidates"] ? Number(a["max-candidates"]) : undefined,
  });
  const results = new Map<string, MappingResult>();
  for (const n of names.keys()) results.set(n, matcher.match(n));

  const header = (t: string) => [
    t,
    "Generated by clinergy-to-opengalen from a private Clinergy extraction and the OpenGALEN 8 OWL release.",
    `Clinergy names: ${COPYRIGHT}`,
    "OpenGALEN: GALEN Open Source License (https://opengalen.eggbird.eu/gosl.html).",
    "Only status 'exact' is a mapping. 'normalised' and 'candidate' are suggestions for human review.",
  ];
  const slugs = new SlugAllocator();
  const index: Yaml = {};
  for (const [n, r] of results) {
    const s = slugs.get(n);
    const rel = `names/${/^[A-Za-z]/.test(s) ? s[0].toUpperCase() : "_"}/${s}.yaml`;
    index[n] = { ...brief(r), file: rel };
    const p = join(mapDir, rel);
    await Deno.mkdir(dirname(p), { recursive: true });
    await Deno.writeTextFile(
      p,
      toYaml({
        clinergy: n,
        kinds: [...names.get(n)!],
        status: r.status,
        needsReview: r.needsReview,
        opengalen: r.opengalen,
        opengalenIri: r.opengalen ? OG_NAMESPACE + r.opengalen : null,
        opengalenKind: r.opengalenKind,
        candidates: r.candidates,
      }, header(`OpenGALEN 8 mapping for Clinergy name ${n}`)),
    );
  }
  const summary = summarise(results, names);
  await Deno.writeTextFile(
    join(mapDir, "index.yaml"),
    toYaml(index, header("Index of Clinergy -> OpenGALEN 8 name mappings")),
  );
  await Deno.writeTextFile(
    join(mapDir, "summary.yaml"),
    toYaml({
      opengalenSource: source,
      opengalenNames: og.names.size,
      opengalenFiles: og.files.length,
      thresholds: { minScore: a["min-score"] ? Number(a["min-score"]) : 0.5 },
      coverage: summary,
    }, header("Coverage of Clinergy names in OpenGALEN 8")),
  );
  if (a.annotate) {
    for (const f of forms) await annotateForm(f, results);
    console.error(`Annotated ${forms.length} form files.`);
  }
  const s = summary.all;
  console.error(
    `${s.total} names: ${s.exact} exact (${s.exactPercent}%), ${s.normalised} normalised, ` +
      `${s.candidate} candidate, ${s.unmapped} unmapped. Wrote ${mapDir}/summary.yaml`,
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
