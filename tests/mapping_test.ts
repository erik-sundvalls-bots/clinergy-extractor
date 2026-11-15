// Tests for the OpenGALEN index, the lexical matcher and the clinergy-to-opengalen
// preprocessor, on invented names only (tests/og_fixture.ts, tests/fixtures/).
import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { Matcher, normKey, spell, tokens } from "../src/mapping.ts";
import { loadOpenGalen, OgIndex, scanDump, scanOwl } from "../src/opengalen.ts";
import { main as extract } from "../clinergy-extract.ts";
import { main as mapCli } from "../clinergy-to-opengalen.ts";
import { buildIs3, buildZip } from "./helpers.ts";
import { DUMP, OWL, writeOgZip } from "./og_fixture.ts";

// deno-lint-ignore no-explicit-any
type Y = Record<string, any>;

function index(): OgIndex {
  const ix = new OgIndex();
  scanOwl(OWL, ix);
  scanDump(DUMP, ix);
  return ix;
}

Deno.test("tokens, spelling and normalised keys", () => {
  assertEquals(tokens("ACEInhibitorDrug2Type"), ["ace", "inhibitor", "drug", "2", "type"]);
  assertEquals(tokens("hasSeverity"), ["has", "severity"]);
  assertEquals(spell("haemorrhage"), "hemorrhage");
  assertEquals(spell("intermittant"), "intermittent");
  assertEquals(normKey("NAMEDElbow"), normKey("elbow"));
  assertEquals(normKey("Edema"), normKey("Oedema"));
});

Deno.test("index: kinds, hierarchy, definitions, sanctions, labels", () => {
  const ix = index();
  assertEquals(ix.kinds.get("hasSeverity"), "ObjectProperty");
  assertEquals(ix.kinds.get("ElbowAche2"), "Class"); // dump-only name
  assertEquals([...ix.parents.get("SlightSeverity")!], ["Severity"]);
  assert(ix.children.get("Severity")!.has("StrongSeverity"));
  assertEquals([...ix.parents.get("hasSeverity")!], ["Attribute"]); // SubObjectPropertyOf
  assert(ix.equivalents.get("ElbowAcheSymptom")!.has("ElbowAche2"));
  assert(
    ix.axioms.get("SlightSeverity")![0].startsWith("EquivalentClasses(SlightSeverity ObjectIntersectionOf(Severity"),
  );
  assert(!ix.axioms.has("PainwhichhasLocationElbow")); // generated: axioms skipped
  assertEquals(ix.sanctions.get("Pain")!.get("hasSeverity"), ["Severity"]);
  assertEquals(ix.annotations.get("hasSeverity")!.get("label"), ["has severity"]);
  assert(!ix.annotations.get("Pain")?.has("SANCTION-LEVEL"));
});

Deno.test("matcher: exact, normalised, candidate, unmapped", () => {
  const m = new Matcher(index().kinds);
  const exact = m.match("ElbowAcheSymptom");
  assertEquals([exact.status, exact.opengalen, exact.needsReview], ["exact", "ElbowAcheSymptom", false]);
  const norm = m.match("Elbow");
  assertEquals([norm.status, norm.opengalen, norm.candidates[0].name], ["normalised", null, "NAMEDElbow"]);
  assertEquals(m.match("Edema").candidates[0].name, "Oedema");
  const cand = m.match("SeverityGrade");
  assertEquals([cand.status, cand.opengalen], ["candidate", null]); // never a mapping
  assert(cand.candidates.some((c) => c.name === "Severity"));
  assert(cand.candidates.every((c, i, a) => i === 0 || a[i - 1].score >= c.score));
  assertEquals(m.match("Zzyzx").status, "unmapped");
  assertEquals(new Matcher(index().kinds, { minScore: 0.99 }).match("SeverityGrade").status, "unmapped");
});

Deno.test("loadOpenGalen: zip input uses OWL-F and the chosen dump only", async () => {
  const tmp = await Deno.makeTempDir();
  await writeOgZip(`${tmp}/og.zip`);
  const ix = await loadOpenGalen(`${tmp}/og.zip`);
  assertEquals(ix.files.length, 2);
  assert(ix.has("ElbowAche2") && ix.has("hasSeverity"));
  assert(!ix.has("OnlyInRdf") && !ix.has("OnlyInOtherDump"));
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("preprocessor: mappings, worklist, reviewed merge, verified-only annotations", async () => {
  const tmp = await Deno.makeTempDir();
  const fx = new URL("./fixtures/", import.meta.url);
  const parts = buildIs3([
    { path: "Group1/TermEng.dll", data: new Uint8Array([1]) },
    { path: "Group3/Model.a28", data: new Uint8Array([1]) },
  ]);
  await Deno.writeFile(`${tmp}/demo.zip`, await buildZip({ "_SETUP.1": parts[0] }));
  assertEquals(await extract([`${tmp}/demo.zip`, `${tmp}/out`, "--dumps", new URL("dumps", fx).pathname]), 0);
  await writeOgZip(`${tmp}/og.zip`);
  const args = [`${tmp}/out`, `${tmp}/og.zip`, `${tmp}/map`];
  assertEquals(await mapCli(args), 0);

  const read = async (p: string) => parse(await Deno.readTextFile(`${tmp}/map/${p}`)) as Y;
  let maps = await read("mappings.yaml");
  assertEquals(maps.ElbowAcheSymptom.method, "exact");
  assertEquals(maps.ElbowAcheSymptom.iri, "http://www.opengalen.org/owl/opengalen.owl#ElbowAcheSymptom");
  assertEquals(maps.ElbowAcheSymptom.needsHumanReview, false);
  assertEquals([maps.Elbow.opengalen, maps.Elbow.method, maps.Elbow.needsHumanReview], [
    "NAMEDElbow",
    "normalised",
    true,
  ]);
  assertEquals(maps.Severity.method, "exact");
  assert(!("slight" in maps));

  const values = await read("worklist/value.yaml");
  const slight = values.slight;
  assertEquals(slight.usedAsValueOf[0].feature, "Severity");
  assertEquals(slight.usedAsValueOf[0].siblings, ["strong"]);
  assert(slight.unverifiedHints.some((h: Y) => h.name === "SlightSadness")); // look-alike, not a mapping
  assert(slight.unverifiedHints.some((h: Y) => h.name === "SlightSeverity"));

  // a reviewer (person or agent) records decisions; unknown OpenGALEN names are rejected
  await Deno.writeTextFile(
    `${tmp}/reviewed.yaml`,
    [
      'slight: {opengalen: SlightSeverity, confidence: high, rationale: "severity value", needsHumanReview: false}',
      "strong: {opengalen: StrongSeverityInvented, confidence: high}",
      'slow: {opengalen: null, confidence: medium, rationale: "no counterpart"}',
      "NotAClinergyName: {opengalen: Pain}",
    ].join("\n"),
  );
  for (let run = 0; run < 2; run++) { // twice: annotation must replace, not duplicate
    assertEquals(await mapCli([...args, "--reviewed", `${tmp}/reviewed.yaml`, "--annotate"]), 0);
  }
  maps = await read("mappings.yaml");
  assertEquals([maps.slight.opengalen, maps.slight.method, maps.slight.needsHumanReview], [
    "SlightSeverity",
    "reviewed",
    false,
  ]);
  assertEquals([maps.slow.opengalen, maps.slow.method], [null, "reviewed-no-match"]);
  assert(!("strong" in maps));
  const summary = await read("summary.yaml");
  assertEquals(summary.reviewedRejected.map((r: Y) => r.clinergy).sort(), ["NotAClinergyName", "strong"]);
  assert("strong" in (await read("worklist/value.yaml")));

  const formText = await Deno.readTextFile(`${tmp}/out/forms/symptom/ElbowAcheSymptom.yaml`);
  assertEquals(formText.split("OpenGALEN 8 mappings (added").length, 2);
  const og = (parse(formText) as Y).opengalen;
  assertEquals(og.topic, { opengalen: "ElbowAcheSymptom", method: "exact", needsHumanReview: false });
  assertEquals(og.values.slight.opengalen, "SlightSeverity");
  assert(!("strong" in og.values) && !("slow" in og.values)); // nothing unverified, no "no match" noise
  assert(!formText.includes("best") && !formText.includes("score"));
  await Deno.remove(tmp, { recursive: true });
});
