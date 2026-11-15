#!/usr/bin/env -S deno run -A
/**
 * Print summary sentences for findings, using an extractor output directory.
 *
 *   deno task sentence <out-dir> <finding.yaml> [--lang sv]
 *
 * finding.yaml is one finding, a list of findings, or a list of
 * `{ id, finding }` wrappers. The sentence rules, concept displays and
 * locative links are read from `<out-dir>/sentence-rules.yaml`,
 * `concepts.yaml` and `concept-links.yaml`.
 *
 * `--lang` is a pack id (`en`, `sv`, loaded from lang/<id>.yaml) or a path
 * to a pack file. Without it, words come from the extracted English lexicon.
 */
import { parseArgs } from "@std/cli/parse-args";
import { parse } from "@std/yaml";
import { languageFromPack, loadLanguagePack } from "./language.ts";
import { findingsFromParsed, type Language, loadSentenceKnowledge, render } from "./sentence.ts";

const USAGE = "usage: deno task sentence <out-dir> <finding.yaml> [--lang sv|en|<pack.yaml>]";

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { boolean: ["help"], string: ["lang"], alias: { h: "help" } });
  if (a.help || a._.length !== 2) {
    console.error(USAGE);
    return a.help ? 0 : 2;
  }
  const [outDir, findingPath] = a._.map(String);
  const knowledge = await loadSentenceKnowledge(outDir);
  const lang: Language | undefined = a.lang ? languageFromPack(await loadLanguagePack(a.lang)) : undefined;
  const findings = findingsFromParsed(parse(await Deno.readTextFile(findingPath)));
  for (const finding of findings) {
    if (!finding.topic) throw new Error("finding.topic is required");
    console.log(render(finding, knowledge, lang));
  }
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
