#!/usr/bin/env -S deno run -A
/**
 * Print summary sentences for findings, using an extractor output directory.
 *
 *   deno task sentence <out-dir> <finding.yaml>
 *
 * finding.yaml is one finding, a list of findings, or a list of
 * `{ id, finding }` wrappers. The sentence rules, concept displays and
 * locative links are read from `<out-dir>/sentence-rules.yaml`,
 * `concepts.yaml` and `concept-links.yaml`.
 */
import { parseArgs } from "@std/cli/parse-args";
import { parse } from "@std/yaml";
import { findingsFromParsed, loadSentenceKnowledge, render } from "./sentence.ts";

const USAGE = "usage: deno task sentence <out-dir> <finding.yaml>";

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { boolean: ["help"], alias: { h: "help" } });
  if (a.help || a._.length !== 2) {
    console.error(USAGE);
    return a.help ? 0 : 2;
  }
  const [outDir, findingPath] = a._.map(String);
  const knowledge = await loadSentenceKnowledge(outDir);
  const findings = findingsFromParsed(parse(await Deno.readTextFile(findingPath)));
  for (const finding of findings) {
    if (!finding.topic) throw new Error("finding.topic is required");
    console.log(render(finding, knowledge));
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
