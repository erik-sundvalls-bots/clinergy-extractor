#!/usr/bin/env -S deno run -A
/**
 * Build SNOMED CT compositional-grammar expressions for findings.
 *
 *   deno task snomed <finding.yaml> [--map mappings/snomed.yaml] [--validate]
 *
 * Concept ids come only from the reviewed map. Unmapped parts are printed
 * to stderr. --validate (or SNOMED_FHIR_URL / SNOWSTORM_URL) checks ids
 * against a terminology server; those calls are skipped when no URL is set.
 */
import { parseArgs } from "@std/cli/parse-args";
import { parse } from "@std/yaml";
import { buildExpression, isValidSyntax, loadSnomedMap, validateWithFhir, validateWithSnowstorm } from "./snomed.ts";
import { findingsFromParsed } from "./sentence.ts";

const USAGE = "usage: deno task snomed <finding.yaml> [--map mappings/snomed.yaml] [--validate]";

const defaultMap = new URL("../mappings/snomed.yaml", import.meta.url).pathname;

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, {
    boolean: ["help", "validate"],
    string: ["map", "fhir", "snowstorm"],
    alias: { h: "help" },
  });
  if (a.help || a._.length !== 1) {
    console.error(USAGE);
    return a.help ? 0 : 2;
  }
  const findingPath = String(a._[0]);
  const map = await loadSnomedMap(a.map ?? defaultMap);
  const findings = findingsFromParsed(parse(await Deno.readTextFile(findingPath)));
  const results = findings.map((finding) => {
    const built = buildExpression(finding, map);
    const syntax = built.expression ? isValidSyntax(built.expression) : true;
    return { finding, ...built, syntax };
  });
  console.log(JSON.stringify({ edition: map.edition, results }, null, 2));
  let status = 0;
  const unmapped = results.flatMap((row) => row.unmapped);
  if (unmapped.length) {
    console.error("unmapped:");
    for (const row of unmapped) console.error(`  ${row.key}: ${row.reason}`);
  }
  for (const row of results) {
    if (row.expression && !row.syntax) {
      console.error(`syntax: invalid expression: ${row.expression}`);
      status = 1;
    }
  }
  const fhir = a.fhir ?? Deno.env.get("SNOMED_FHIR_URL");
  const snowstorm = a.snowstorm ?? Deno.env.get("SNOWSTORM_URL");
  if (a.validate && !fhir && !snowstorm) {
    console.error("validate: set SNOMED_FHIR_URL or SNOWSTORM_URL, or pass --fhir / --snowstorm");
    return 2;
  }
  if (fhir || snowstorm) {
    for (const row of results) {
      if (!row.expression) continue;
      if (fhir) {
        const check = await validateWithFhir(row.expression, fhir);
        if (!check.ok) {
          status = 1;
          console.error(`fhir: ${row.expression}\n  ${check.issues.join("\n  ")}`);
        } else if (check.expressionAccepted === false) {
          console.error(
            `fhir: concept ids are valid; the server did not accept the expression as a single code`,
          );
        }
      }
      if (snowstorm) {
        const check = await validateWithSnowstorm(row.expression, snowstorm);
        if (!check.ok) {
          status = 1;
          console.error(`snowstorm: ${row.expression}\n  ${check.issues.join("\n  ")}`);
        }
      }
    }
  }
  return status;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
