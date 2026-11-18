#!/usr/bin/env -S deno run -A
/**
 * Build FHIR Questionnaires (and optional QuestionnaireResponses and
 * Symptom Logical Model instances) from an existing extractor out/ directory.
 *
 *   deno task fhir <out-dir> [--findings finding.yaml] [--opengalen map/mappings.yaml]
 *       [--snomed mappings/snomed.yaml] [--dest DIR]
 *
 * This is opt-in and does not run as part of a default extract. Generated
 * files stay next to the extract (default <out-dir>/fhir/) and must not be
 * committed when they come from a private Clinergy extract.
 */
import { parseArgs } from "@std/cli/parse-args";
import { writeFhirTree } from "./fhir.ts";

const USAGE = "usage: deno task fhir <out-dir> [--findings FILE] [--opengalen FILE] [--snomed FILE] [--dest DIR]";

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, {
    boolean: ["help"],
    string: ["findings", "opengalen", "snomed", "dest"],
    alias: { h: "help" },
  });
  if (a.help || a._.length !== 1) {
    console.error(USAGE);
    return a.help ? 0 : 2;
  }
  const result = await writeFhirTree({
    outDir: String(a._[0]),
    destDir: a.dest,
    findingsPath: a.findings,
    opengalenPath: a.opengalen,
    snomedPath: a.snomed,
  });
  console.log(JSON.stringify(
    {
      destDir: result.destDir,
      questionnaires: result.questionnaires,
      responses: result.responses,
      symptoms: result.symptoms,
      failures: result.failures.length,
      unmapped: result.unmapped.length,
      gaps: result.gaps.length,
    },
    null,
    2,
  ));
  if (result.failures.length) {
    console.error("failures:");
    for (const row of result.failures) console.error(`  ${row.file}: ${row.error}`);
  }
  if (result.unmapped.length) {
    console.error("uncoded:");
    for (const row of result.unmapped) console.error(`  ${row.key}: ${row.reason}`);
  }
  if (result.gaps.length) {
    console.error("symptom gaps:");
    for (const row of result.gaps) {
      console.error(`  ${row.path}${row.clinergy ? ` (${row.clinergy})` : ""}: ${row.reason}`);
    }
  }
  return result.failures.length ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
