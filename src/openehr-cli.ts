#!/usr/bin/env -S deno run -A
/**
 * Build openEHR canonical JSON and FLAT for findings.
 *
 *   deno task openehr <out-dir> <finding.yaml> [--map mappings/openehr.yaml]
 *       [--opengalen map/mappings.yaml] [--template templates/thumb-pain.webtemplate.json]
 *
 * OpenGALEN names are read from a verified mappings.yaml (exact, normalised or
 * reviewed). The default looks for <out-dir>/../map/mappings.yaml and skips it
 * when that file is not there. Unmapped keys are printed to stderr.
 */
import { parseArgs } from "@std/cli/parse-args";
import { parse } from "@std/yaml";
import { dirname, join } from "@std/path";
import { buildOpenEhr, loadDescriptorMap, openGalenFromParsed, validate, type WebTemplate } from "./openehr.ts";
import { findingsFromParsed, loadSentenceKnowledge } from "./sentence.ts";

const USAGE =
  "usage: deno task openehr <out-dir> <finding.yaml> [--map mappings/openehr.yaml] [--opengalen map/mappings.yaml] [--template templates/thumb-pain.webtemplate.json]";

const defaultMap = new URL("../mappings/openehr.yaml", import.meta.url).pathname;
const defaultTemplate = new URL("../templates/thumb-pain.webtemplate.json", import.meta.url).pathname;

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, {
    boolean: ["help"],
    string: ["map", "opengalen", "template"],
    alias: { h: "help" },
  });
  if (a.help || a._.length !== 2) {
    console.error(USAGE);
    return a.help ? 0 : 2;
  }
  const [outDir, findingPath] = a._.map(String);
  const knowledge = await loadSentenceKnowledge(outDir);
  const findings = findingsFromParsed(parse(await Deno.readTextFile(findingPath)));
  const map = await loadDescriptorMap(a.map ?? defaultMap);
  const ogPath = a.opengalen ?? join(dirname(outDir), "map", "mappings.yaml");
  let opengalen = {};
  try {
    opengalen = openGalenFromParsed(parse(await Deno.readTextFile(ogPath)));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const result = buildOpenEhr(findings, knowledge, map, opengalen);
  const template = JSON.parse(await Deno.readTextFile(a.template ?? defaultTemplate)) as WebTemplate;
  const problems = validate(result, template, map);
  console.log(JSON.stringify({ canonical: result.canonical, flat: result.flat }, null, 2));
  if (result.unmapped.length) {
    console.error("unmapped:");
    for (const row of result.unmapped) console.error(`  ${row.key}: ${row.reason}`);
  }
  if (problems.length) {
    console.error("validation:");
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
