// FHIR Questionnaire and Symptom Logical Model output for the synthetic
// thumb-pain extract. No Clinergy-extracted forms are in this fixture.
import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { main as extractMain } from "../clinergy-extract.ts";
import { main as fhirMain } from "../src/fhir-cli.ts";
import {
  buildQuestionnaire,
  buildQuestionnaireResponse,
  buildSymptom,
  codingFor,
  type CodingMaps,
  formFromParsed,
  loadForms,
  loadOpenGalenCoding,
  OPEN_GALEN,
  SDC_QUESTIONNAIRE_PROFILE,
  SYMPTOM_PROFILE,
  type SymptomGap,
  writeFhirTree,
} from "../src/fhir.ts";
import { type Finding, findingsFromParsed, loadSentenceKnowledge, render } from "../src/sentence.ts";
import { buildIs3, buildZip } from "./helpers.ts";
import { bmpFile, dib } from "./image_fixtures.ts";

const fixtureOut = new URL("./fixtures/thumb-pain/extract/", import.meta.url).pathname;
const findingsPath = new URL("./fixtures/thumb-pain/findings.yaml", import.meta.url).pathname;
const ogPath = new URL("./fixtures/thumb-pain/opengalen-exact.yaml", import.meta.url).pathname;
const fx = new URL("./fixtures/", import.meta.url);

async function maps(): Promise<CodingMaps> {
  const knowledge = await loadSentenceKnowledge(fixtureOut);
  return {
    opengalen: loadOpenGalenCoding(parse(await Deno.readTextFile(ogPath))),
    snomed: {},
    displays: Object.fromEntries(
      Object.entries(knowledge.concepts).map(([key, row]) => [key, row.display]),
    ),
  };
}

async function demo() {
  const coding = await maps();
  const forms = await loadForms(fixtureOut);
  const byTopic = Object.fromEntries(forms.map((form) => [form.topic, form]));
  const knowledge = await loadSentenceKnowledge(fixtureOut);
  const findings = findingsFromParsed(parse(await Deno.readTextFile(findingsPath))) as Finding[];
  const rows = parse(await Deno.readTextFile(findingsPath)) as { id: string; finding: Finding }[];
  return { coding, forms, byTopic, knowledge, findings, rows };
}

Deno.test("one SDC Questionnaire is built per thumb-pain form", async () => {
  const { coding, byTopic } = await demo();
  const unmapped: { key: string; reason: string }[] = [];
  const pain = buildQuestionnaire(byTopic.ThumbPainSymptom, coding, unmapped);
  assertEquals(pain.resourceType, "Questionnaire");
  assertEquals(pain.status, "draft");
  assertEquals((pain.meta as { profile: string[] }).profile, [SDC_QUESTIONNAIRE_PROFILE]);
  assertEquals(pain.url, "urn:clinergy-extractor:questionnaire:ThumbPainSymptom");
  const items = pain.item as Record<string, unknown>[];
  const linkIds = items.map((item) => item.linkId);
  assert(linkIds.includes("ThumbPainSymptom.summary"));
  assert(linkIds.includes("ThumbPainSymptom.laterality"));
  assert(linkIds.includes("ThumbPainSymptom.Duration"));
  assert(linkIds.includes("ThumbPainSymptom.Character"));
  assert(linkIds.includes("ThumbPainSymptom.Severity"));
  assert(linkIds.includes("ThumbPainSymptom.associated"));
  const duration = items.find((item) => item.linkId === "ThumbPainSymptom.Duration")!;
  assertEquals(duration.type, "quantity");
  const laterality = items.find((item) => item.linkId === "ThumbPainSymptom.laterality")!;
  const options = laterality.answerOption as { valueString?: string; valueCoding?: { code: string } }[];
  assert(options.some((row) => row.valueString === "left"));
  assert(options.every((row) => !row.valueCoding), "left/right have no verified codes in this fixture");
  const associated =
    (items.find((item) => item.linkId === "ThumbPainSymptom.associated")!.item as Record<string, unknown>[])[0];
  assertEquals(associated.linkId, "ThumbPainSymptom.associated.ThumbSwellingSymptom");
  assert(unmapped.some((row) => row.key === "left"));
  assert(unmapped.every((row) => row.reason.includes("no verified")));
});

Deno.test("moreLayer items are gated with enableWhen on present", () => {
  const form = formFromParsed({
    topic: "DemoSymptom",
    display: "demo",
    category: "symptom",
    summaryType: "AbsentPresent",
    firstLayer: [{ feature: "Severity", values: ["mild", "moderate"] }],
    moreLayer: [{ feature: "Onset", values: ["gradual"] }],
  });
  const unmapped: { key: string; reason: string }[] = [];
  const q = buildQuestionnaire(form, { opengalen: {}, snomed: {}, displays: {} }, unmapped);
  const items = q.item as Record<string, unknown>[];
  const onset = items.find((item) => item.linkId === "DemoSymptom.Onset")!;
  assertEquals(onset.enableWhen, [{
    question: "DemoSymptom.summary",
    operator: "=",
    answerString: "present",
  }]);
  const severity = items.find((item) => item.linkId === "DemoSymptom.Severity")!;
  assertEquals(severity.enableWhen, undefined);
});

Deno.test("verified OpenGALEN names are written as codes; unverified stay text", async () => {
  const { coding, byTopic } = await demo();
  assertEquals(codingFor("Thumb", coding), {
    system: OPEN_GALEN,
    code: "Thumb",
    display: "thumb",
  });
  assertEquals(codingFor("DistalPhalanx", coding)?.code, "DistalPhalanx");
  assertEquals(codingFor("moderate", coding), null);
  const unmapped: { key: string; reason: string }[] = [];
  const swelling = buildQuestionnaire(byTopic.ThumbSwellingSymptom, coding, unmapped);
  const items = swelling.item as Record<string, unknown>[];
  const sub = items.find((item) => item.linkId === "ThumbSwellingSymptom.sublocation")!;
  const options = sub.answerOption as { valueCoding?: { system: string; code: string }; valueString?: string }[];
  const distal = options.find((row) => row.valueCoding?.code === "DistalPhalanx");
  assertEquals(distal?.valueCoding?.system, OPEN_GALEN);
  const thenar = options.find((row) =>
    (row.valueString ?? row.valueCoding?.code ?? "").toLowerCase().includes("thenar")
  );
  assert(thenar, JSON.stringify(options));
  assertEquals(thenar.valueCoding, undefined);
});

Deno.test("a finding fills a QuestionnaireResponse and a Symptom Logical Model", async () => {
  const { coding, byTopic, knowledge, rows } = await demo();
  const full = rows.find((row) => row.id === "swelling-full")!.finding;
  const narrative = render(full, knowledge);
  const response = buildQuestionnaireResponse(byTopic.ThumbSwellingSymptom, full, coding, narrative);
  assertEquals(response.resourceType, "QuestionnaireResponse");
  assertEquals(response.questionnaire, "urn:clinergy-extractor:questionnaire:ThumbSwellingSymptom");
  const items = response.item as Record<string, unknown>[];
  const byId = Object.fromEntries(items.map((item) => [item.linkId as string, item]));
  assertEquals(
    (byId["ThumbSwellingSymptom.laterality"].answer as { valueString: string }[])[0].valueString,
    "left",
  );
  assertEquals(
    (byId["ThumbSwellingSymptom.sublocation"].answer as { valueCoding: { code: string } }[])[0].valueCoding.code,
    "DistalPhalanx",
  );
  const duration = (byId["ThumbSwellingSymptom.Duration"].answer as { valueQuantity: Record<string, unknown> }[])[0]
    .valueQuantity;
  assertEquals(duration, { value: 2, unit: "weeks", system: "http://unitsofmeasure.org", code: "wk" });
  assertEquals(
    (byId["ThumbSwellingSymptom.Severity"].answer as { valueString: string }[])[0].valueString,
    "moderate",
  );
  assert((response.text as { div: string }).div.includes("swelling"));

  const gaps: SymptomGap[] = [];
  const symptom = buildSymptom(full, coding, narrative, gaps);
  assertEquals(symptom.resourceType, "SymptomLogicalModel");
  assertEquals((symptom.meta as { profile: string[] }).profile, [SYMPTOM_PROFILE]);
  assertEquals(symptom.symptomCode, "ThumbSwellingSymptom");
  assertEquals(symptom.presentFlag, true);
  assertEquals((symptom.symptomDescription as { text: string }[])[0].text, narrative);
  const location = (symptom.keyFeatures as { location: { code: string; qualifier: string[] }[] }).location[0];
  assertEquals(location.code, "Thumb");
  assert(location.qualifier.includes("left"));
  assert(location.qualifier.some((q) => /distal/i.test(q)));
  assertEquals((symptom.keyFeatures as { severity: { value: string } }).severity.value, "moderate");
  const timing = symptom.timing as { speedOfOnset: string; duration: { value: number; code: string } };
  assertEquals(timing.speedOfOnset, "gradual");
  assertEquals(timing.duration.value, 2);
  assertEquals(timing.duration.code, "wk");
  assert(gaps.some((g) => g.path === "symptomCode" && g.clinergy === "ThumbSwellingSymptom"));
  assert(gaps.some((g) => g.path === "reporter[x]"));
  assert(gaps.some((g) => g.path === "timing.onset[x]"));
  assert(gaps.some((g) => g.path === "keyFeatures.severity.value" && g.clinergy === "moderate"));
});

Deno.test("pain-right is a present symptom with a right-thumb site", async () => {
  const { coding, knowledge, rows } = await demo();
  const pain = rows.find((row) => row.id === "pain-right")!.finding;
  const gaps: SymptomGap[] = [];
  const symptom = buildSymptom(pain, coding, render(pain, knowledge), gaps);
  assertEquals(symptom.presentFlag, true);
  const location = (symptom.keyFeatures as { location: { code: string; qualifier: string[] }[] }).location[0];
  assertEquals(location.code, "Thumb");
  assertEquals(location.qualifier, ["right"]);
});

Deno.test("deno task fhir writes questionnaires for the thumb-pain fixture", async () => {
  const dest = await Deno.makeTempDir();
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = () => {};
  try {
    const code = await fhirMain([fixtureOut, "--findings", findingsPath, "--opengalen", ogPath, "--dest", dest]);
    assertEquals(code, 0);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const pain = JSON.parse(await Deno.readTextFile(`${dest}/symptom/ThumbPainSymptom.questionnaire.json`));
  assertEquals(pain.resourceType, "Questionnaire");
  const swellingResp = JSON.parse(
    await Deno.readTextFile(`${dest}/symptom/ThumbSwellingSymptom.10.response.json`),
  );
  // findings.yaml has 10 rows; swelling-full is the last ThumbSwellingSymptom
  assertEquals(swellingResp.resourceType, "QuestionnaireResponse");
  const bundle = JSON.parse(await Deno.readTextFile(`${dest}/symptoms.json`));
  assertEquals(bundle.symptoms.length, 10);
  const summary = JSON.parse(await Deno.readTextFile(`${dest}/summary.json`));
  assertEquals(summary.questionnaires, 2);
  assertEquals(summary.responses, 10);
  await Deno.remove(dest, { recursive: true });
});

Deno.test("default extract does not write fhir/; --fhir is opt-in", async () => {
  const tmp = await Deno.makeTempDir();
  const enc = new TextEncoder();
  const ini = (f: string) => Deno.readFile(new URL(`ini/${f}`, fx));
  const parts = buildIs3([
    { path: "Group1/TermEng.dll", data: enc.encode("fake") },
    { path: "Group3/Model.a28", data: enc.encode("fake") },
    { path: "Group4/Selector.ini", data: await ini("Selector.ini") },
    { path: "Group4/Symptoms.ini", data: await ini("Symptoms.ini") },
    { path: "Group5/Elbow.bmp", data: bmpFile(dib({ width: 1, height: 1, bpp: 24, pixels: [[[9, 8, 7]]] })) },
  ]);
  await Deno.writeFile(`${tmp}/demo.zip`, await buildZip({ "_SETUP.1": parts[0] }));
  const dumps = new URL("dumps", fx).pathname;
  assertEquals(await extractMain([`${tmp}/demo.zip`, `${tmp}/out`, "--dumps", dumps]), 0);
  try {
    await Deno.stat(`${tmp}/out/fhir`);
    throw new Error("fhir/ should not exist after a default extract");
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
  }
  const result = await writeFhirTree({ outDir: `${tmp}/out`, destDir: `${tmp}/out/fhir` });
  assert(result.questionnaires >= 1);
  assertEquals(result.failures, []);
  await Deno.remove(tmp, { recursive: true });
});
