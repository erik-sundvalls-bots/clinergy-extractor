// Tests for the OpenGALEN name matcher and the clinergy-to-opengalen CLI, on invented names only.
import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { Matcher, normKey, spell, tokens } from "../src/mapping.ts";
import { loadOpenGalenNames, type OgNames, scanText } from "../src/opengalen.ts";
import { main as extract } from "../clinergy-extract.ts";
import { main as mapCli } from "../clinergy-to-opengalen.ts";
import { buildIs3, buildZip } from "./helpers.ts";

const OWL = `Prefix(:=<http://www.opengalen.org/owl/opengalen.owl#>)
Declaration(Class(<http://www.opengalen.org/owl/opengalen.owl#ElbowAcheSymptom>))
Declaration(Class(<http://www.opengalen.org/owl/opengalen.owl#Ache>))
Declaration(Class(<http://www.opengalen.org/owl/opengalen.owl#NAMEDElbow>))
Declaration(Class(<http://www.opengalen.org/owl/opengalen.owl#Swelling>))
Declaration(Class(<http://www.opengalen.org/owl/opengalen.owl#SeverityState>))
Declaration(ObjectProperty(<http://www.opengalen.org/owl/opengalen.owl#hasSeverity>))
Declaration(Class(<http://www.opengalen.org/owl/opengalen.owl#Oedema>))
`;
const DUMP = ";; test dump\n(implies Strain TopCategory)\n(equivalent ElbowStrainInjury ElbowStrain2)\n";

function names(): OgNames {
  const n: OgNames = new Map();
  scanText(OWL, "owl", n);
  scanText(DUMP, "dump", n);
  return n;
}

Deno.test("tokens, spelling and normalised keys", () => {
  assertEquals(tokens("ACEInhibitorDrug2Type"), ["ace", "inhibitor", "drug", "2", "type"]);
  assertEquals(tokens("hasSeverity"), ["has", "severity"]);
  assertEquals(spell("haemorrhage"), "hemorrhage");
  assertEquals(spell("intermittant"), "intermittent");
  assertEquals(normKey("NAMEDElbow"), normKey("elbow"));
  assertEquals(normKey("Edema"), normKey("Oedema"));
});

Deno.test("scanText reads OWL-F declarations and dump names", () => {
  const n = names();
  assertEquals(n.get("hasSeverity"), "ObjectProperty");
  assertEquals(n.get("ElbowAcheSymptom"), "Class");
  assert(n.has("Strain") && n.has("ElbowStrain2") && n.has("TopCategory"));
});

Deno.test("matcher: exact, normalised, candidate, unmapped", () => {
  const m = new Matcher(names());
  const exact = m.match("ElbowAcheSymptom");
  assertEquals([exact.status, exact.opengalen, exact.needsReview], ["exact", "ElbowAcheSymptom", false]);
  const norm = m.match("Elbow");
  assertEquals([norm.status, norm.opengalen, norm.candidates[0].name, norm.needsReview], [
    "normalised",
    null,
    "NAMEDElbow",
    true,
  ]);
  assertEquals(m.match("Edema").candidates[0].name, "Oedema");
  const cand = m.match("AbsoluteSeverity");
  assertEquals(cand.status, "candidate");
  assertEquals(cand.opengalen, null); // never a mapping without review
  assert(cand.candidates.some((c) => c.name === "hasSeverity"));
  assert(cand.candidates.every((c, i, a) => i === 0 || a[i - 1].score >= c.score));
  assertEquals(m.match("Zzyzx").status, "unmapped");
  assertEquals(new Matcher(names(), { minScore: 0.99 }).match("AbsoluteSeverity").status, "unmapped");
});

Deno.test("loadOpenGalenNames: zip input skips RDF copies", async () => {
  const enc = new TextEncoder();
  const tmp = await Deno.makeTempDir();
  await Deno.writeFile(
    `${tmp}/og.zip`,
    await buildZip({
      "OpenGALEN8/OWL_Sources/OWL-F/a.owl": enc.encode(OWL),
      "OpenGALEN8/OWL_Sources/RDF/a.owl": enc.encode("Declaration(Class(<x#OnlyInRdf>))"),
      "OpenGALEN8/Hierarchy_Dumps/OpenGALEN8_WithoutPropertyChains_CRM+Diseases+SurgicalProcedures+DrugOntology.dump":
        enc.encode(DUMP),
    }, ["OpenGALEN8/OWL_Sources/OWL-F/a.owl"]),
  );
  const { names: n, files } = await loadOpenGalenNames(`${tmp}/og.zip`);
  assertEquals(files.length, 2);
  assert(n.has("Strain") && n.has("hasSeverity") && !n.has("OnlyInRdf"));
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("cli: map a synthetic extraction and annotate forms", async () => {
  const tmp = await Deno.makeTempDir();
  const fx = new URL("./fixtures/", import.meta.url);
  const parts = buildIs3([
    { path: "Group1/TermEng.dll", data: new Uint8Array([1]) },
    { path: "Group3/Model.a28", data: new Uint8Array([1]) },
  ]);
  await Deno.writeFile(`${tmp}/demo.zip`, await buildZip({ "_SETUP.1": parts[0] }));
  assertEquals(await extract([`${tmp}/demo.zip`, `${tmp}/out`, "--dumps", new URL("dumps", fx).pathname]), 0);
  await Deno.writeTextFile(`${tmp}/og.owl`, OWL);
  for (let run = 0; run < 2; run++) { // twice: annotation must replace, not duplicate
    assertEquals(await mapCli([`${tmp}/out`, `${tmp}/og.owl`, `${tmp}/map`, "--annotate"]), 0);
  }
  const summary = parse(await Deno.readTextFile(`${tmp}/map/summary.yaml`)) as {
    coverage: { all: Record<string, number> };
  };
  const all = summary.coverage.all;
  assertEquals(all.total, all.exact + all.normalised + all.candidate + all.unmapped);
  assert(all.exact >= 1);
  const one = parse(await Deno.readTextFile(`${tmp}/map/names/E/ElbowAcheSymptom.yaml`)) as Record<string, unknown>;
  assertEquals([one.status, one.opengalenIri], [
    "exact",
    "http://www.opengalen.org/owl/opengalen.owl#ElbowAcheSymptom",
  ]);
  const formText = await Deno.readTextFile(`${tmp}/out/forms/symptom/ElbowAcheSymptom.yaml`);
  assertEquals(formText.split("OpenGALEN 8 names (added").length, 2);
  const form = parse(formText) as { opengalen: { topic: { status: string } } };
  assertEquals(form.opengalen.topic.status, "exact");
  await Deno.remove(tmp, { recursive: true });
});
