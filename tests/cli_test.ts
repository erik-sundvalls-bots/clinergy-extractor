// End-to-end test of the CLI without Wine (--dumps), on a synthetic installer zip,
// plus an optional integration test on the real ClinergyDemo.zip (set CLINERGY_ZIP).
import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { main } from "../clinergy-extract.ts";
import { buildIs3, buildZip } from "./helpers.ts";

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) yield* walk(`${dir}/${e.name}`);
    else yield `${dir}/${e.name}`;
  }
}

const enc = new TextEncoder();
const fx = new URL("./fixtures/", import.meta.url);
const readYaml = async (p: string) => parse(await Deno.readTextFile(p)) as Record<string, unknown>;

Deno.test("cli: synthetic zip + --dumps writes the YAML tree", async () => {
  const tmp = await Deno.makeTempDir();
  const ini = (f: string) => Deno.readFile(new URL(`ini/${f}`, fx));
  const parts = buildIs3([
    { path: "Group1/TermEng.dll", data: enc.encode("fake") },
    { path: "Group3/Model.a28", data: enc.encode("fake") },
    { path: "Group4/Selector.ini", data: await ini("Selector.ini") },
    { path: "Group4/Symptoms.ini", data: await ini("Symptoms.ini") },
  ]);
  await Deno.writeFile(`${tmp}/demo.zip`, await buildZip({ "_SETUP.1": parts[0] }));
  const code = await main([`${tmp}/demo.zip`, `${tmp}/out`, "--dumps", new URL("dumps", fx).pathname]);
  assertEquals(code, 0);
  const form = await readYaml(`${tmp}/out/forms/symptom/ElbowAcheSymptom.yaml`);
  assertEquals(form.display, "elbow ache");
  assertEquals((form.firstLayer as unknown[]).length, 4);
  assertEquals(form.concept, "concepts.yaml#ElbowAcheSymptom");
  type Y = Record<string, Record<string, unknown>>;
  const concepts = await readYaml(`${tmp}/out/concepts.yaml`) as Y;
  assertEquals([concepts.ElbowAcheSymptom.id, concepts.ElbowAcheSymptom.permanentId], [3, 13]);
  assertEquals(concepts.ElbowAcheSymptom.form, "forms/symptom/ElbowAcheSymptom.yaml");
  const links = await readYaml(`${tmp}/out/concept-links.yaml`) as Y;
  assertEquals(links.ElbowAcheSymptom.visFeatureAtts, ["Severity", "Onset"]);
  const exams = await readYaml(`${tmp}/out/exams.yaml`) as Y;
  assertEquals(exams.ElbowLook.lateral, true);
  const rules = await readYaml(`${tmp}/out/sentence-rules.yaml`) as Y;
  const onset = rules.descriptors.Onset as { rules: { valueForm: string }[] };
  assertEquals(onset.rules[0].valueForm, "valueAdverb");
  assert(Array.isArray(rules.summaryTypes) && "lexicon" in rules);
  const map = await readYaml(`${tmp}/out/bodymap.yaml`) as Record<string, { maps: object }>;
  assert(Object.keys(map["Selector.ini"].maps).includes("TestAnatomy"));
  // one file per form plus a fixed set of lookup files
  let files = 0;
  for await (const _ of walk(`${tmp}/out`)) files++;
  assertEquals(files, 4 + 10);
  const header = (await Deno.readTextFile(`${tmp}/out/forms/index.yaml`)).split("\n").slice(0, 5).join("\n");
  assert(header.includes("Semantic Technologies") && header.includes("model test_1"));
  await Deno.remove(tmp, { recursive: true });
});

const realZip = Deno.env.get("CLINERGY_ZIP");
Deno.test({
  name: "integration: real ClinergyDemo.zip through Wine (set CLINERGY_ZIP)",
  ignore: !realZip,
  async fn() {
    const tmp = await Deno.makeTempDir();
    const args = [realZip!, `${tmp}/out`];
    if (Deno.env.get("CLINERGY_WINE_PREFIX")) args.push("--wine-prefix", Deno.env.get("CLINERGY_WINE_PREFIX")!);
    assertEquals(await main(args), 0);
    const s = (await readYaml(`${tmp}/out/model.yaml`)).statistics as Record<string, number>;
    // Counts of the 1998 demo model (k_20_00), as found by the first extraction.
    assertEquals({
      completeTopics: s.completeTopics,
      conceptsWithVisibleFeatures: s.conceptsWithVisibleFeatures,
      visibleFeatureRows: s.visibleFeatureRows,
      formLinks: s.formLinks,
      examLinks: s.examLinks,
      exams: s.exams,
      languageDescriptors: s.languageDescriptors,
      languageRules: s.languageRules,
      valuePrecedences: s.valuePrecedences,
    }, {
      completeTopics: 2121,
      conceptsWithVisibleFeatures: 2057,
      visibleFeatureRows: 7442,
      formLinks: 5163,
      examLinks: 1753,
      exams: 230,
      languageDescriptors: 222,
      languageRules: 973,
      valuePrecedences: 871,
    });
    let files = 0;
    for await (const _ of walk(`${tmp}/out`)) files++;
    assertEquals(files, 2121 + 10); // one file per form + lookup files
    if (!Deno.env.get("CLINERGY_KEEP")) await Deno.remove(tmp, { recursive: true });
    else console.log(`kept ${tmp}/out`);
  },
});

Deno.test({
  name: "integration: real ClinergyDemo.zip unpacks completely (set CLINERGY_ZIP)",
  ignore: !realZip,
  async fn() {
    const { unpackClinergyZip } = await import("../src/installer.ts");
    const inst = await unpackClinergyZip(await Deno.readFile(realZip!));
    assertEquals(inst.files.size, 216); // explode() checks every file's size against the archive table
    assertEquals(inst.programDir, "Group1");
    assertEquals(inst.modelFiles.size, 11);
  },
});
