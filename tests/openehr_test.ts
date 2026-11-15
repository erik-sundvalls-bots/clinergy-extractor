// openEHR canonical JSON and FLAT for the synthetic thumb-pain findings.
// at-codes are the published CKM codes recorded in mappings/openehr.yaml.
// OpenGALEN names are only the identical-name classes checked against the
// OpenGALEN 8 release (tests/fixtures/thumb-pain/opengalen-exact.yaml).
import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { main as openehrMain } from "../src/openehr-cli.ts";
import { buildOpenEhr, loadDescriptorMap, openGalenFromParsed, validate, type WebTemplate } from "../src/openehr.ts";
import { type Finding, findingsFromParsed, loadSentenceKnowledge } from "../src/sentence.ts";

const fixtureOut = new URL("./fixtures/thumb-pain/extract/", import.meta.url).pathname;
const findingsPath = new URL("./fixtures/thumb-pain/findings.yaml", import.meta.url).pathname;
const mapPath = new URL("../mappings/openehr.yaml", import.meta.url).pathname;
const ogPath = new URL("./fixtures/thumb-pain/opengalen-exact.yaml", import.meta.url).pathname;
const templatePath = new URL("../templates/thumb-pain.webtemplate.json", import.meta.url).pathname;
const optPath = new URL("../templates/thumb-pain.opt", import.meta.url).pathname;

async function demo() {
  const knowledge = await loadSentenceKnowledge(fixtureOut);
  const map = await loadDescriptorMap(mapPath);
  const opengalen = openGalenFromParsed(parse(await Deno.readTextFile(ogPath)));
  const rows = parse(await Deno.readTextFile(findingsPath)) as { id: string; finding: Finding }[];
  const want = new Set(["pain-right", "swelling-full"]);
  const findings = rows.filter((row) => want.has(row.id)).map((row) => row.finding);
  const template = JSON.parse(await Deno.readTextFile(templatePath)) as WebTemplate;
  const result = buildOpenEhr(findings, knowledge, map, opengalen);
  return { result, map, template, findings };
}

function flatValue(flat: Record<string, string>, suffix: string): string | undefined {
  const key = Object.keys(flat).find((k) => k.endsWith(suffix));
  return key ? flat[key] : undefined;
}

Deno.test("thumb pain and the swelling finding become one composition", async () => {
  const { result, map, template } = await demo();
  assertEquals(validate(result, template, map), []);
  assertEquals(result.canonical.archetype_node_id, "openEHR-EHR-COMPOSITION.encounter.v1");
  const category = result.canonical.category as { defining_code: { code_string: string }; value: string };
  assertEquals(category.value, "event");
  assertEquals(category.defining_code.code_string, "433");
  const setting = (result.canonical.context as { setting: { defining_code: { code_string: string } } }).setting;
  assertEquals(setting.defining_code.code_string, "228");

  const pain =
    "thumb-pain-encounter.v1/content[openEHR-EHR-OBSERVATION.story.v1:0]/data[at0001]/events[at0002:0]/data[at0003]/items[openEHR-EHR-CLUSTER.symptom_sign.v2:0]";
  const swelling = pain.replace("symptom_sign.v2:0", "symptom_sign.v2:1");
  assertEquals(result.flat[`${pain}/items[at0001]/value`], "pain");
  assertEquals(result.flat[`${swelling}/items[at0001]/value`], "swelling");
  assertEquals(
    result.flat[`${pain}/items[openEHR-EHR-CLUSTER.anatomical_location.v1:0]/items[at0001]/value|code`],
    "Thumb",
  );
  assertEquals(
    result.flat[`${pain}/items[openEHR-EHR-CLUSTER.anatomical_location.v1:0]/items[at0001]/value|terminology`],
    "OpenGALEN",
  );
  assertEquals(
    result.flat[`${pain}/items[openEHR-EHR-CLUSTER.anatomical_location.v1:0]/items[at0002]/value|code`],
    "at0004",
  );
  assertEquals(
    result.flat[`${pain}/items[openEHR-EHR-CLUSTER.anatomical_location.v1:0]/items[at0002]/value|value`],
    "Right",
  );
  assertEquals(
    result.flat[`${swelling}/items[openEHR-EHR-CLUSTER.anatomical_location.v1:0]/items[at0002]/value|code`],
    "at0003",
  );
  assertEquals(
    result.flat[`${swelling}/items[openEHR-EHR-CLUSTER.anatomical_location.v1:0]/items[at0065]/value|code`],
    "DistalPhalanx",
  );
  assertEquals(result.flat[`${swelling}/items[at0021]/value|code`], "at0024");
  assertEquals(result.flat[`${swelling}/items[at0021]/value|value`], "Moderate");
  assertEquals(result.flat[`${swelling}/items[at0021]/value|terminology`], "local");
  assertEquals(result.flat[`${swelling}/items[at0028]/value`], "P2W");
  assertEquals(result.flat[`${swelling}/items[at0164]/value`], "gradual");
  assertEquals(
    result.flat[
      "thumb-pain-encounter.v1/content[openEHR-EHR-OBSERVATION.story.v1:0]/data[at0001]/events[at0002:0]/data[at0003]/items[at0004:0]/value"
    ],
    "Pain in right thumb",
  );
  assertEquals(
    result.flat[
      "thumb-pain-encounter.v1/content[openEHR-EHR-OBSERVATION.story.v1:0]/data[at0001]/events[at0002:0]/data[at0003]/items[at0004:1]/value"
    ],
    "Gradual onset, moderately severe swelling of distal phalanx of left thumb for 2 weeks, present",
  );

  const bound = result.bindings.map((b) => b.key).sort();
  assertEquals(bound, ["DistalPhalanx", "Thumb"]);
  const unmappedKeys = result.unmapped.map((u) => u.key);
  for (const key of ["ThumbPainSymptom", "ThumbSwellingSymptom", "moderate", "gradual", "week", "right", "left"]) {
    assert(unmappedKeys.includes(key), key);
  }
  assert(!unmappedKeys.includes("presence"));
  assert(!unmappedKeys.includes("Thumb"));
});

Deno.test("a worklist hint is not a mapping, and absence is not a positive cluster", async () => {
  const knowledge = await loadSentenceKnowledge(fixtureOut);
  const map = await loadDescriptorMap(mapPath);
  const opengalen = {
    ...openGalenFromParsed(parse(await Deno.readTextFile(ogPath))),
    moderate: { opengalen: "ModerateSeverity", method: "hint" },
    PainSymptom: { opengalen: "Pain", method: "reviewed" },
  };
  const present = buildOpenEhr(
    [{
      topic: "PainSymptom",
      location: "Thumb",
      summary: "presence",
      qualifiers: [{ descriptor: "Severity", value: "moderate" }],
    }],
    knowledge,
    map,
    opengalen,
  );
  assert(present.unmapped.some((u) => u.key === "moderate" && u.reason.includes("hint")));
  assert(!present.bindings.some((b) => b.opengalen === "ModerateSeverity"));
  assert(present.bindings.some((b) => b.key === "PainSymptom" && b.opengalen === "Pain" && b.method === "reviewed"));

  const absent = buildOpenEhr(
    [{
      topic: "PainSymptom",
      summary: "absence",
      qualifiers: [],
    }],
    knowledge,
    map,
    opengalen,
  );
  assert(absent.unmapped.some((u) => u.key === "absence"));
  const content = absent.canonical.content as {
    data: { events: { data: { items: { archetype_node_id?: string }[] } }[] };
  }[];
  const items = content[0].data.events[0].data.items;
  assert(!items.some((item) => item.archetype_node_id === "openEHR-EHR-CLUSTER.symptom_sign.v2"));
});

Deno.test("frequency has no archetype path and is reported", async () => {
  const knowledge = await loadSentenceKnowledge(fixtureOut);
  const map = await loadDescriptorMap(mapPath);
  const [finding] = findingsFromParsed({
    topic: "ThumbPainSymptom",
    location: "Thumb",
    qualifiers: [{ descriptor: "Frequency", value: "occasional" }],
  });
  const result = buildOpenEhr([finding], knowledge, map, {});
  assert(result.unmapped.some((u) => u.key === "Frequency"));
  assert(!Object.values(result.flat).includes("occasional"));
  assertEquals(flatValue(result.flat, "items[at0001]/value"), "pain");
});

Deno.test("the OPT names the published archetypes and the at-codes the composition uses", async () => {
  const opt = await Deno.readTextFile(optPath);
  for (
    const needle of [
      "openEHR-EHR-COMPOSITION.encounter.v1",
      "openEHR-EHR-OBSERVATION.story.v1",
      "openEHR-EHR-CLUSTER.symptom_sign.v2",
      "openEHR-EHR-CLUSTER.anatomical_location.v1",
      "at0004",
      "at0021",
      "at0023",
      "at0024",
      "at0025",
      "at0028",
      "at0065",
      "at0164",
      "at0003",
      "at0004",
      "433",
      "228",
    ]
  ) {
    assert(opt.includes(needle), needle);
  }
});

Deno.test("cli writes canonical JSON and FLAT and reports unmapped keys", async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    assertEquals(await openehrMain([fixtureOut, findingsPath, "--opengalen", ogPath]), 0);
  } finally {
    console.log = log;
    console.error = error;
  }
  const doc = JSON.parse(lines.join("\n")) as { flat: Record<string, string> };
  assert(Object.values(doc.flat).includes("P2W"));
  assert(Object.values(doc.flat).includes("Pain in right thumb"));
  assert(errors.some((line) => line.includes("ThumbPainSymptom")));
});

const ehrbase = Deno.env.get("EHRBASE_URL");
Deno.test({
  name: "optional: commit the thumb-pain composition to EHRbase (set EHRBASE_URL)",
  ignore: !ehrbase,
  async fn() {
    const { result, template } = await demo();
    const templateResponse = await fetch(`${ehrbase}/rest/openehr/v1/definition/template/adl1.4`, {
      method: "POST",
      headers: { "Content-Type": "application/xml", Accept: "application/xml" },
      body: await Deno.readTextFile(optPath),
    });
    assert(
      templateResponse.ok || templateResponse.status === 409,
      `template upload ${templateResponse.status}`,
    );
    const ehr = await fetch(`${ehrbase}/rest/openehr/v1/ehr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        _type: "EHR_STATUS",
        subject: {
          external_ref: {
            id: { _type: "GENERIC_ID", value: "thumb-pain-test", scheme: "id" },
            namespace: "test",
            type: "PERSON",
          },
        },
        is_queryable: true,
        is_modifiable: true,
      }),
    });
    assert(ehr.ok, `ehr create ${ehr.status}`);
    const created = await ehr.json();
    const ehrId = created.ehr_id?.value ?? created.ehrId;
    const commit = await fetch(`${ehrbase}/rest/openehr/v1/ehr/${ehrId}/composition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(result.canonical),
    });
    const text = await commit.text();
    assert(commit.ok, `commit ${commit.status} ${text.slice(0, 400)}`);
    assert(template.templateId === "thumb-pain-encounter.v1");
  },
});
