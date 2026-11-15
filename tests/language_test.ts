// Language packs. Swedish wording is ours and has not had a native-speaker review.
// The thumb-pain lines are the same public summary sentences as sentence_test.ts,
// translated by lang/sv.yaml. No Clinergy lexicon text is copied into the packs.
import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { main as extractMain } from "../clinergy-extract.ts";
import { languageFromPack, loadLanguagePack, packFromParsed } from "../src/language.ts";
import { main as sentenceMain } from "../src/sentence-cli.ts";
import {
  type Finding,
  findingsFromParsed,
  loadSentenceKnowledge,
  render,
  renderReport,
  sentenceKnowledgeFromParsed,
} from "../src/sentence.ts";

const fixtureOut = new URL("./fixtures/thumb-pain/extract/", import.meta.url).pathname;
const findingsPath = new URL("./fixtures/thumb-pain/findings.yaml", import.meta.url).pathname;

const finding = (over: Partial<Finding> & { topic: string }): Finding => ({ qualifiers: [], ...over });

Deno.test("English pack matches the extractor-lexicon renderer on the thumb-pain findings", async () => {
  const k = await loadSentenceKnowledge(fixtureOut);
  const en = languageFromPack(await loadLanguagePack("en"));
  const cases = findingsFromParsed(parse(await Deno.readTextFile(findingsPath)));
  for (const f of cases) {
    const packed = renderReport(f, k, en);
    assertEquals(packed.sentence, render(f, k));
    assertEquals(packed.missing, []);
  }
});

Deno.test("Swedish pack renders the thumb-pain walkthrough", async () => {
  const k = await loadSentenceKnowledge(fixtureOut);
  const sv = languageFromPack(await loadLanguagePack("sv"));
  const rows = parse(await Deno.readTextFile(findingsPath)) as { id: string; finding: Finding }[];
  const expected: Record<string, string> = {
    "pain-bare": "Tumsmärta",
    "pain-right": "Smärta i höger tumme",
    "pain-left": "Smärta i vänster tumme",
    "swelling-present": "Tumsvullnad föreligger",
    "swelling-left": "Svullnad av vänster tumme föreligger",
    "swelling-distal": "Svullnad av ytterfalang av vänster tumme föreligger",
    "swelling-2-days": "Svullnad av ytterfalang av vänster tumme i 2 dagar, föreligger",
    "swelling-2-weeks": "Svullnad av ytterfalang av vänster tumme i 2 veckor, föreligger",
    "swelling-onset": "Gradvis debut svullnad av ytterfalang av vänster tumme i 2 veckor, föreligger",
    "swelling-full": "Gradvis debut, måttligt svår svullnad av ytterfalang av vänster tumme i 2 veckor, föreligger",
  };
  for (const row of rows) {
    const report = renderReport(row.finding, k, sv);
    assertEquals(report.sentence, expected[row.id], row.id);
    assertEquals(report.missing, [], row.id);
  }
});

Deno.test("valueAdj is the Swedish adverb, then the descriptor adjective", async () => {
  const sv = languageFromPack(await loadLanguagePack("sv"));
  const k = sentenceKnowledgeFromParsed(
    {
      descriptors: {
        Severity: {
          precedence: 1,
          rules: [{
            value: "moderate",
            valueForm: "valueAdj",
            descriptorForm: "descAdj",
            order: "valFirst",
            position: "beforeTopic",
          }],
        },
      },
      lexicon: { descriptors: {}, valueAdverbs: {} },
    },
    {
      PainSymptom: { display: "pain" },
      Thumb: { display: "thumb" },
      moderate: { display: "moderate" },
    },
    { PainSymptom: { locativeLinks: ["in Thumb"] } },
  );
  assertEquals(
    render(
      finding({
        topic: "PainSymptom",
        location: "Thumb",
        laterality: "right",
        qualifiers: [{ descriptor: "Severity", value: "moderate" }],
      }),
      k,
      sv,
    ),
    "Måttligt svår smärta i höger tumme",
  );
});

Deno.test("a missing Swedish entry is reported and the concept key is used", async () => {
  const k = await loadSentenceKnowledge(fixtureOut);
  const pack = await loadLanguagePack("sv");
  delete pack.entries.DistalPhalanx;
  const sv = languageFromPack(pack);
  const rows = parse(await Deno.readTextFile(findingsPath)) as { id: string; finding: Finding }[];
  const distal = rows.find((r) => r.id === "swelling-distal")!.finding;
  const report = renderReport(distal, k, sv);
  assert(report.sentence.includes("DistalPhalanx"));
  assert(report.missing.includes("sv:DistalPhalanx.noun"));
  assert(!report.sentence.toLowerCase().includes("distal phalanx"));
});

Deno.test("agreement: en, ett, plural and definite on synthetic entries", () => {
  const k = sentenceKnowledgeFromParsed(
    {
      descriptors: {
        Severity: {
          precedence: 1,
          rules: [{
            value: "moderate",
            valueForm: "valueAdverb",
            descriptorForm: "descAdj",
            order: "valueFirst",
            position: "beforeTopic",
          }],
        },
      },
      lexicon: { descriptors: {}, valueAdverbs: {} },
    },
    {
      SwellingSymptom: { display: "swelling" },
      Symptom: { display: "symptom" },
      moderate: { display: "moderate" },
    },
  );
  const base = {
    id: "sv",
    adverbRule: "none",
    subJoiner: "av",
    laterality: {
      left: { adjective: "vänster", indeclinable: true },
      right: { adjective: "höger", indeclinable: true },
    },
    entries: {
      SwellingSymptom: {
        noun: "svullnad",
        gender: "en",
        definite: "svullnaden",
        plural: "svullnader",
      },
      Symptom: {
        noun: "symtom",
        gender: "ett",
        definite: "symtomet",
        plural: "symtom",
        number: "plural",
      },
      Severity: {
        adjective: "svår",
        adjectiveForms: { en: "svår", ett: "svårt", plural: "svåra", definite: "svåra" },
      },
      moderate: { adverb: "måttligt" },
    },
  };
  const qualifiers = [{ descriptor: "Severity", value: "moderate" }];
  const en = languageFromPack(packFromParsed({
    ...base,
    entries: { ...base.entries, Symptom: { ...base.entries.Symptom, number: "singular" } },
  }));
  // The ett-word below is the plural one; this en-word is indefinite singular.
  assertEquals(
    render(finding({ topic: "SwellingSymptom", qualifiers }), k, en),
    "Måttligt svår svullnad",
  );
  const ett = languageFromPack(packFromParsed({
    ...base,
    entries: {
      ...base.entries,
      Symptom: { noun: "symtom", gender: "ett", definite: "symtomet", plural: "symtom" },
    },
  }));
  assertEquals(
    render(finding({ topic: "Symptom", qualifiers }), k, ett),
    "Måttligt svårt symtom",
  );
  const plural = languageFromPack(packFromParsed(base));
  assertEquals(
    render(finding({ topic: "Symptom", qualifiers }), k, plural),
    "Måttligt svåra symtom",
  );
  const definite = languageFromPack(packFromParsed({
    ...base,
    definiteness: { topic: true },
    entries: {
      ...base.entries,
      Symptom: { noun: "symtom", gender: "ett", definite: "symtomet", plural: "symtom" },
    },
  }));
  assertEquals(
    render(finding({ topic: "Symptom", qualifiers }), k, definite),
    "Måttligt svåra symtomet",
  );
  assertEquals(
    render(finding({ topic: "SwellingSymptom", qualifiers }), k, definite),
    "Måttligt svåra svullnaden",
  );
});

Deno.test("preposition follows location type; the English link word is only the fallback key", () => {
  const k = sentenceKnowledgeFromParsed(
    { descriptors: {}, lexicon: { descriptors: {}, valueAdverbs: {} } },
    { PainSymptom: { display: "pain" }, Skin: { display: "skin" }, Stomach: { display: "stomach" } },
    { PainSymptom: { locativeLinks: ["in Skin", "in Stomach"] } },
  );
  const sv = languageFromPack(packFromParsed({
    id: "sv",
    prepositions: { in: "i", of: "av" },
    locationTypes: { Skin: "surface", Stomach: "cavity" },
    prepositionByLocationType: { surface: "på", cavity: "i" },
    entries: {
      PainSymptom: { noun: "smärta", gender: "en" },
      Skin: { noun: "hud", gender: "en" },
      Stomach: { noun: "magsäck", gender: "en" },
    },
    laterality: {
      left: { adjective: "vänster", indeclinable: true },
      right: { adjective: "höger", indeclinable: true },
    },
  }));
  assertEquals(
    render(finding({ topic: "PainSymptom", location: "Skin", laterality: "right" }), k, sv),
    "Smärta på höger hud",
  );
  assertEquals(
    render(finding({ topic: "PainSymptom", location: "Stomach", laterality: "left" }), k, sv),
    "Smärta i vänster magsäck",
  );
});

Deno.test("adverb rule -t is used when the pack lists an adjective and no adverb", () => {
  const k = sentenceKnowledgeFromParsed(
    {
      descriptors: {
        Edge: {
          precedence: 1,
          rules: [{
            value: "sharp",
            valueForm: "valueAdverb",
            descriptorForm: "NoDescriptor",
            order: "valueFirst",
            position: "beforeTopic",
          }],
        },
      },
      lexicon: { descriptors: {}, valueAdverbs: {} },
    },
    { PainSymptom: { display: "pain" }, sharp: { display: "sharp" } },
  );
  const sv = languageFromPack(packFromParsed({
    id: "sv",
    adverbRule: "suffix-t",
    entries: {
      PainSymptom: { noun: "smärta" },
      sharp: { adjective: "vass", adjectiveForms: { en: "vass", ett: "vasst", plural: "vassa", definite: "vassa" } },
    },
  }));
  assertEquals(
    render(finding({ topic: "PainSymptom", qualifiers: [{ descriptor: "Edge", value: "sharp" }] }), k, sv),
    "Vasst smärta",
  );
  assertEquals(
    renderReport(
      finding({
        topic: "PainSymptom",
        qualifiers: [{ descriptor: "Edge", value: "sharp" }],
      }),
      k,
      sv,
    ).missing,
    [],
  );
});

Deno.test("location slot order is a pack setting", async () => {
  const k = await loadSentenceKnowledge(fixtureOut);
  const pack = await loadLanguagePack("sv");
  pack.locationOrder = "lat-loc-sub";
  const sv = languageFromPack(pack);
  const rows = parse(await Deno.readTextFile(findingsPath)) as { id: string; finding: Finding }[];
  const sentence = render(rows.find((r) => r.id === "swelling-distal")!.finding, k, sv);
  assertEquals(sentence, "Svullnad av vänster tumme ytterfalang av föreligger");
});

Deno.test("cli --lang sv prints the Swedish thumb-pain sentences", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    assertEquals(await sentenceMain([fixtureOut, findingsPath, "--lang", "sv"]), 0);
  } finally {
    console.log = orig;
  }
  assertEquals(lines[0], "Tumsmärta");
  assertEquals(lines[1], "Smärta i höger tumme");
  assertEquals(
    lines.at(-1),
    "Gradvis debut, måttligt svår svullnad av ytterfalang av vänster tumme i 2 veckor, föreligger",
  );
});

const svExpectations = Deno.env.get("CLINERGY_SENTENCE_EXPECTATIONS_SV");
const extractedOut = Deno.env.get("CLINERGY_OUT");
const zip = Deno.env.get("CLINERGY_ZIP");

Deno.test({
  name: "integration: Swedish sentences from a real extract (CLINERGY_SENTENCE_EXPECTATIONS_SV)",
  ignore: !svExpectations || (!extractedOut && !zip),
  async fn() {
    let outDir = extractedOut;
    let tmp: string | undefined;
    if (!outDir) {
      tmp = await Deno.makeTempDir();
      outDir = `${tmp}/out`;
      assertEquals(await extractMain([zip!, outDir]), 0);
    }
    try {
      const k = await loadSentenceKnowledge(outDir!);
      const sv = languageFromPack(await loadLanguagePack("sv"));
      const doc = parse(await Deno.readTextFile(svExpectations!));
      const rows = Array.isArray(doc) ? doc : (doc as { cases?: unknown[] }).cases ?? [];
      assert(rows.length > 0, "Swedish expectations file is empty");
      for (const row of rows) {
        const rec = row as { expected?: string; finding?: unknown };
        if (typeof rec.expected !== "string" || !rec.finding) {
          throw new Error("each expectations entry needs `expected` and `finding`");
        }
        const [f] = findingsFromParsed(rec.finding);
        assertEquals(render(f, k, sv), rec.expected);
      }
    } finally {
      if (tmp) await Deno.remove(tmp, { recursive: true });
    }
  },
});
