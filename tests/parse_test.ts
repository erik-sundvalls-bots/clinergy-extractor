// Parser, form assembly and YAML tests on the synthetic model in tests/fixtures (invented data).
import { assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { braces, parseBodyMapIni, parseFields, parseSearchSpace } from "../src/parse.ts";
import { assembleForm, buildKnowledge, DUMP_FILES, Resolver, statistics } from "../src/knowledge.ts";
import { scalar, toYaml } from "../src/yaml.ts";

const fx = new URL("./fixtures/", import.meta.url);
async function knowledge() {
  const dumps: Record<string, string> = {};
  for (const f of DUMP_FILES) dumps[f] = await Deno.readTextFile(new URL(`dumps/${f}`, fx));
  const inis: Record<string, string> = {};
  for (const f of ["Selector.ini", "Symptoms.ini"]) inis[f] = await Deno.readTextFile(new URL(`ini/${f}`, fx));
  return buildKnowledge(dumps, inis);
}

Deno.test("braces and fields", () => {
  assertEquals(braces("{ a } { b c }  {d}"), ["a", "b c", "d"]);
  assertEquals(parseFields(["cat=Complete x", "supers[2]=A|B", "base=X|Y", "eq=a=b"]), {
    fields: { cat: "Complete x", base: "X|Y", eq: "a=b" },
    lists: { supers: ["A", "B"] },
  });
  assertEquals(Object.fromEntries(parseSearchSpace("\nab\n\tX\n\tY\n\ncd\n")), { ab: ["X", "Y"], cd: [] });
});

Deno.test("knowledge: counts on the synthetic model", async () => {
  const s = statistics(await knowledge());
  assertEquals(
    [s.entitiesNamed, s.completeTopics, s.visibleFeatureRows, s.visibleFeatureRowsFirstLayer, s.critLinkVisRows],
    [9, 4, 5, 3, 1],
  );
  assertEquals([s.formLinks, s.examLinks, s.exams, s.languageDescriptors, s.languageRules, s.valuePrecedences], [
    3,
    1,
    4,
    2,
    3,
    2,
  ]);
  assertEquals(s.bodyMapLocations, { "Selector.ini": { locations: 2, sublocations: 2 } });
});

Deno.test("forms: layers, pickers, inheritance flags, links and exams", async () => {
  const k = await knowledge();
  const f = assembleForm(k, "ElbowAcheSymptom", new Resolver(k));
  assertEquals(f.location, "Elbow");
  assertEquals(f.visibilityAncestor, "AcheSymptom");
  assertEquals(f.firstLayer.map((i) => [i.feature, i.inheritance]), [
    ["laterality", undefined],
    ["sublocation", undefined],
    ["Severity", "same-as-ancestor"],
    ["Duration", "added"],
  ]);
  assertEquals(f.moreLayer.map((i) => [i.feature ?? i.criterialLink, i.inheritance]), [
    ["Onset", "overrides-ancestor"],
    ["ConseqSwelling", "added"],
  ]);
  assertEquals(f.associatedSymptomsAndSigns.map((l) => [l.concept, l.preposition, l.location, l.preCoordinated]), [
    ["SwellingSymptom", "of", "Elbow", "ElbowSwellingSymptom"],
  ]);
  assertEquals(f.diagnoses.map((l) => l.concept), ["ElbowStrain"]);
  assertEquals(f.otherLinks.map((l) => [l.concept, l.category]), [["BloodCount", "investigation"]]);
  assertEquals(f.examinations, [{
    exam: "ElbowLook",
    perSide: ["left", "right"],
    signs: ["TendernessSign"],
    subExams: ["ElbowBendLook"],
  }]);
});

Deno.test("body map INI: selector options and nested hotspots", () => {
  const b = parseBodyMapIni(
    "[BEGIN SELECTOR]\nOptionButton,1,F,arm,ArmSystem,a.bmp,b.bmp,M\n[END SELECTOR]\n" +
      "[BEGIN M]\nLOCATION\nElbow,1,2,3,4\nSUBLOCATION\ntip,ElbowTip,5,6,7,8\n[END M]\n",
  );
  assertEquals(b.selectors[0].options[0].system, "ArmSystem");
  assertEquals(b.maps.get("M")![0].sublocations[0], { label: "tip", concept: "ElbowTip", hotspot: [5, 6, 7, 8] });
});

Deno.test("yaml: quoting of risky scalars and round trip", () => {
  for (const s of ["yes", "no", "on", "null", "1", "1.5", "a: b", "x #y", "", " lead", "-dash", "[x]"]) {
    assertEquals(parse(`v: ${scalar(s)}`), { v: s });
  }
  const doc = {
    a: "plain",
    n: 1,
    t: false,
    z: null,
    l: ["x", "y"],
    o: [{ k: "v", w: [1, 2] }],
    e: [],
    m: {},
    deep: { x: { y: [[1], [{ q: "r" }]] } },
  };
  const y = toYaml(doc, ["header"]);
  assertEquals(y.split("\n")[0], "# header");
  assertEquals(parse(y), doc);
});

Deno.test("lexicon: Pascal strings, descriptor words and adverbs from synthetic binary", async () => {
  const { pascalStrings, descriptorWords, valueAdverbs } = await import("../src/lexicon.ts");
  const ps = (s: string) => [s.length, ...new TextEncoder().encode(s)];
  const p28 = new Uint8Array([
    0,
    ...ps("AbsoluteSharpness"),
    0,
    ...ps("sharpness"),
    0,
    ...ps("sharp"),
    0,
    ...ps("blunt"),
    9,
    ...ps("OtherDescriptor"),
  ]);
  assertEquals(pascalStrings(p28), ["AbsoluteSharpness", "sharpness", "sharp", "blunt", "OtherDescriptor"]);
  assertEquals(descriptorWords([p28]).get("AbsoluteSharpness"), {
    noun: "sharpness",
    adjective: "sharp",
    negative: "blunt",
  });
  const e28 = new Uint8Array([1, 0, 0, ...ps("slightly"), 0, 7, 7, 1, 0, ...ps("slight"), 0]);
  assertEquals(Object.fromEntries(valueAdverbs(e28)), { slight: "slightly" });
});
