// SNOMED CT compositional-grammar expressions for the synthetic thumb-pain
// findings. Concept ids are the reviewed, re-checked set in mappings/snomed.yaml.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { parse } from "@std/yaml";
import { main as snomedMain } from "../src/snomed-cli.ts";
import {
  boundConcept,
  buildExpression,
  isValidSyntax,
  loadSnomedMap,
  parseExpression,
  type SnomedMap,
  snomedMapFromParsed,
  validateWithFhir,
} from "../src/snomed.ts";
import { type Finding } from "../src/sentence.ts";

const findingsPath = new URL("./fixtures/thumb-pain/findings.yaml", import.meta.url).pathname;
const mapPath = new URL("../mappings/snomed.yaml", import.meta.url).pathname;

async function demo() {
  const map = await loadSnomedMap(mapPath);
  const rows = parse(await Deno.readTextFile(findingsPath)) as { id: string; finding: Finding }[];
  const byId = Object.fromEntries(
    rows.map((row) => [row.id, { finding: row.finding, result: buildExpression(row.finding, map) }]),
  );
  return { map, byId };
}

const PAIN_RIGHT =
  "300955002 |Pain in thumb| :\n  { 363698007 |Finding site| = (76505004 |Thumb structure| : 272741003 |Laterality| = 24028007 |Right|) }";
const PAIN_LEFT =
  "300955002 |Pain in thumb| :\n  { 363698007 |Finding site| = (76505004 |Thumb structure| : 272741003 |Laterality| = 7771000 |Left|) }";
const SWELLING_THUMB = "65124004 |Swelling| :\n  { 363698007 |Finding site| = 76505004 |Thumb structure| }";
const SWELLING_LEFT =
  "65124004 |Swelling| :\n  { 363698007 |Finding site| = (76505004 |Thumb structure| : 272741003 |Laterality| = 7771000 |Left|) }";
const SWELLING_DISTAL =
  "65124004 |Swelling| :\n  { 363698007 |Finding site| = (182007006 |Entire distal phalanx of thumb| : 272741003 |Laterality| = 7771000 |Left|) }";
const SWELLING_ONSET =
  "65124004 |Swelling| :\n  { 363698007 |Finding site| = (182007006 |Entire distal phalanx of thumb| : 272741003 |Laterality| = 7771000 |Left|) },\n  { 263502005 |Clinical course| = 61751001 |Gradual onset| }";
const SWELLING_FULL =
  "65124004 |Swelling| :\n  { 363698007 |Finding site| = (182007006 |Entire distal phalanx of thumb| : 272741003 |Laterality| = 7771000 |Left|) },\n  { 263502005 |Clinical course| = 61751001 |Gradual onset| },\n  { 246112005 |Severity| = 6736007 |Moderate severity| }";

Deno.test("thumb-pain demo findings become compositional-grammar expressions", async () => {
  const { byId } = await demo();
  assertEquals(byId["pain-bare"].result.expression, "300955002 |Pain in thumb|");
  assertEquals(byId["pain-bare"].result.unmapped, []);
  assertEquals(byId["pain-right"].result.expression, PAIN_RIGHT);
  assertEquals(byId["pain-left"].result.expression, PAIN_LEFT);
  assertEquals(byId["swelling-present"].result.expression, SWELLING_THUMB);
  assertEquals(byId["swelling-present"].result.unmapped, []);
  assertEquals(byId["swelling-left"].result.expression, SWELLING_LEFT);
  assertEquals(byId["swelling-distal"].result.expression, SWELLING_DISTAL);
  assertEquals(byId["swelling-2-days"].result.expression, SWELLING_DISTAL);
  assertEquals(byId["swelling-2-weeks"].result.expression, SWELLING_DISTAL);
  assertEquals(byId["swelling-onset"].result.expression, SWELLING_ONSET);
  assertEquals(byId["swelling-full"].result.expression, SWELLING_FULL);
  for (const row of Object.values(byId)) {
    assert(row.result.expression, `missing expression for ${row.finding.topic}`);
    assert(isValidSyntax(row.result.expression!), row.result.expression ?? "");
  }
});

Deno.test("numeric duration is listed as unmapped, not written into the expression", async () => {
  const { byId } = await demo();
  for (const id of ["swelling-2-days", "swelling-2-weeks", "swelling-onset", "swelling-full"]) {
    const unmapped = byId[id].result.unmapped;
    assertEquals(unmapped.length, 1);
    assertEquals(unmapped[0].key, "Duration");
    assert(unmapped[0].reason.includes("no duration attribute"), unmapped[0].reason);
  }
  assert(byId["swelling-2-days"].result.unmapped[0].reason.includes("2 day"));
  assert(byId["swelling-2-weeks"].result.unmapped[0].reason.includes("2 week"));
});

Deno.test("DistalPhalanx is not used unless the location is Thumb", async () => {
  const { map } = await demo();
  const result = buildExpression({
    topic: "ThumbSwellingSymptom",
    subLocation: "DistalPhalanx",
    qualifiers: [],
  }, map);
  assertEquals(result.expression, "65124004 |Swelling|");
  assertEquals(result.unmapped.length, 1);
  assertEquals(result.unmapped[0].key, "DistalPhalanx");
  assert(result.unmapped[0].reason.includes("only used when location is Thumb"), result.unmapped[0].reason);
});

Deno.test("unverified map rows and unknown topics are not written silently", async () => {
  const { map } = await demo();
  const unknown = buildExpression({ topic: "NotAConcept", qualifiers: [] }, map);
  assertEquals(unknown.expression, null);
  assertEquals(unknown.unmapped[0].key, "NotAConcept");
  const unverified = buildExpression({ topic: "ThumbSwellingSymptom", qualifiers: [] }, map);
  // No location: Swelling alone, which is the reviewed focus, not a silent drop.
  assertEquals(unverified.expression, "65124004 |Swelling|");
  assertEquals(unverified.unmapped, []);
  assertEquals(boundConcept(map, "ThumbSwellingSymptom"), null);
});

Deno.test("the compositional-grammar parser accepts demo expressions and rejects broken ones", () => {
  assert(isValidSyntax("300955002 |Pain in thumb|"));
  assert(isValidSyntax(PAIN_RIGHT));
  assert(isValidSyntax(SWELLING_FULL));
  assertFalse(isValidSyntax(""));
  assertFalse(isValidSyntax("300955002 |Pain in thumb"));
  assertFalse(isValidSyntax("300955002 |Pain in thumb| : { 363698007 |Finding site| }"));
  const parsed = parseExpression(PAIN_RIGHT);
  assertEquals(parsed.conceptIds, ["300955002", "363698007", "76505004", "272741003", "24028007"]);
});

Deno.test("left and right laterality aliases from the Clinergy form resolve", async () => {
  const { map } = await demo();
  assertEquals(boundConcept(map, "leftSelection")?.code, "7771000");
  assertEquals(boundConcept(map, "rightSelection")?.code, "24028007");
  assertEquals(boundConcept(map, "distalPhalanx")?.code, "182007006");
});

Deno.test("snomed CLI prints the pain-right expression", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
  await Deno.writeTextFile(
    tmp,
    "topic: ThumbPainSymptom\nlocation: Thumb\nlaterality: right\nqualifiers: []\n",
  );
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
  try {
    const code = await snomedMain([tmp, "--map", mapPath]);
    assertEquals(code, 0);
  } finally {
    console.log = origLog;
    console.error = origErr;
    await Deno.remove(tmp);
  }
  const doc = JSON.parse(logs.join("\n")) as { results: { expression: string }[] };
  assertEquals(doc.results[0].expression, PAIN_RIGHT);
  assertEquals(errs, []);
});

const fhir = Deno.env.get("SNOMED_FHIR_URL");
Deno.test({
  name: "optional: concept ids in the demo expressions validate on a FHIR terminology server (set SNOMED_FHIR_URL)",
  ignore: !fhir,
  async fn() {
    const { byId } = await demo();
    for (const [id, row] of Object.entries(byId)) {
      const check = await validateWithFhir(row.result.expression!, fhir!);
      assert(check.ok, `${id}: ${check.issues.join("; ")}`);
    }
  },
});

Deno.test("an unverified code in a hand-built map is ignored", () => {
  const map: SnomedMap = snomedMapFromParsed({
    attributes: {
      findingSite: { code: "363698007", term: "Finding site", verified: true, grouped: true },
    },
    concepts: {
      FakePain: { code: "999999999", term: "Not a real concept", verified: false },
    },
    descriptors: {},
  });
  const result = buildExpression({ topic: "FakePain", qualifiers: [] }, map);
  assertEquals(result.expression, null);
  assertEquals(result.unmapped[0].key, "FakePain");
});
