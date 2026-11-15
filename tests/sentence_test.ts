// Summary sentences. The thumb-pain cases use synthetic rules authored in
// tests/fixtures/thumb-pain (not extracted from Clinergy). The expected lines
// are the summary box text read off the public walkthrough:
// https://pen-pad-revival.github.io/docs/clinergy-thumb-pain-demo/
import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/yaml";
import { main as extractMain } from "../clinergy-extract.ts";
import { main as sentenceMain } from "../src/sentence-cli.ts";
import {
  type Finding,
  findingsFromParsed,
  loadSentenceKnowledge,
  type Qualifier,
  render,
  renderReport,
  type SentenceKnowledge,
  sentenceKnowledgeFromParsed,
} from "../src/sentence.ts";

// Not named "out/": .gitignore ignores every out/ directory so a real extract can never be committed.
const fixtureOut = new URL("./fixtures/thumb-pain/extract/", import.meta.url).pathname;
const findingsPath = new URL("./fixtures/thumb-pain/findings.yaml", import.meta.url).pathname;

function knowledge(partial: {
  descriptors?: unknown;
  valuePrecedences?: unknown;
  summaryTypes?: unknown;
  lexicon?: unknown;
  concepts?: unknown;
  links?: unknown;
}): SentenceKnowledge {
  return sentenceKnowledgeFromParsed(
    {
      descriptors: partial.descriptors ?? {},
      valuePrecedences: partial.valuePrecedences ?? {},
      summaryTypes: partial.summaryTypes ?? [],
      lexicon: partial.lexicon ?? { descriptors: {}, valueAdverbs: {} },
    },
    partial.concepts ?? {},
    partial.links ?? {},
  );
}

const finding = (over: Partial<Finding> & { topic: string }): Finding => ({
  qualifiers: [],
  ...over,
});

Deno.test("precedence: higher sits closer to the topic, both sides", () => {
  const k = knowledge({
    descriptors: {
      Far: {
        precedence: 1,
        rules: [{
          value: "far",
          valueForm: "valueAdjective",
          descriptorForm: "NoDescriptor",
          order: "valueFirst",
          position: "beforeTopic",
        }],
      },
      Near: {
        precedence: 9,
        rules: [{
          value: "near",
          valueForm: "valueAdjective",
          descriptorForm: "NoDescriptor",
          order: "valueFirst",
          position: "beforeTopic",
        }],
      },
      AfterNear: {
        precedence: 9,
        rules: [{
          value: "soon",
          valueForm: "valueAdjective",
          descriptorForm: "NoDescriptor",
          order: "valueFirst",
          position: "afterTopic",
        }],
      },
      AfterFar: {
        precedence: 1,
        rules: [{
          value: "later",
          valueForm: "valueAdjective",
          descriptorForm: "NoDescriptor",
          order: "valueFirst",
          position: "afterTopic",
        }],
      },
    },
    concepts: {
      Pain: { display: "pain" },
      far: { display: "far" },
      near: { display: "near" },
      soon: { display: "soon" },
      later: { display: "later" },
    },
  });
  assertEquals(
    render(
      finding({
        topic: "Pain",
        qualifiers: [
          { descriptor: "AfterFar", value: "later" },
          { descriptor: "Near", value: "near" },
          { descriptor: "Far", value: "far" },
          { descriptor: "AfterNear", value: "soon" },
        ],
      }),
      k,
    ),
    "Far, near pain soon, later",
  );
});

Deno.test("value precedence orders two values of one descriptor", () => {
  const k = knowledge({
    descriptors: {
      Hue: {
        precedence: 1,
        rules: [
          {
            value: "blue",
            valueForm: "valueAdjective",
            descriptorForm: "NoDescriptor",
            order: "valueFirst",
            position: "beforeTopic",
            valuePrecedence: 1,
          },
          {
            value: "red",
            valueForm: "valueAdjective",
            descriptorForm: "NoDescriptor",
            order: "valueFirst",
            position: "beforeTopic",
            valuePrecedence: 5,
          },
        ],
      },
    },
    concepts: { Pain: { display: "pain" }, blue: { display: "blue" }, red: { display: "red" } },
  });
  const qualifiers: Qualifier[] = [
    { descriptor: "Hue", value: "red" },
    { descriptor: "Hue", value: "blue" },
  ];
  // red has the higher value precedence, so it sits closer to the topic.
  assertEquals(render(finding({ topic: "Pain", qualifiers }), k), "Blue, red pain");
});

Deno.test("word forms: adverb + adjective, adjective + noun, descriptor-first, negative", () => {
  const k = knowledge({
    descriptors: {
      Severity: {
        precedence: 2,
        rules: [{
          value: "moderate",
          valueForm: "valueAdverb",
          descriptorForm: "descAdj",
          order: "valueFirst",
          position: "beforeTopic",
        }],
      },
      Onset: {
        precedence: 1,
        rules: [{
          value: "fast",
          valueForm: "valueAdjective",
          descriptorForm: "descNoun",
          order: "valueFirst",
          position: "beforeTopic",
        }],
      },
      Polarity: {
        precedence: 3,
        rules: [{
          value: "no",
          valueForm: "valueAdjective",
          descriptorForm: "descNegative",
          order: "descFirst",
          position: "beforeTopic",
        }],
      },
    },
    lexicon: {
      descriptors: {
        Severity: { noun: "severity", adjective: "severe", negative: null },
        Onset: { noun: "onset", adjective: null, negative: null },
        Polarity: { noun: null, adjective: null, negative: "not" },
      },
      valueAdverbs: { moderate: "moderately" },
    },
    concepts: {
      Pain: { display: "pain" },
      moderate: { display: "moderate" },
      fast: { display: "fast" },
      no: { display: "no" },
    },
  });
  assertEquals(
    render(
      finding({
        topic: "Pain",
        qualifiers: [
          { descriptor: "Onset", value: "fast" },
          { descriptor: "Severity", value: "moderate" },
          { descriptor: "Polarity", value: "no" },
        ],
      }),
      k,
    ),
    "Fast onset, moderately severe, not no pain",
  );
});

Deno.test("missing lexicon adverb falls back to the display plus -ly and is reported", () => {
  const k = knowledge({
    descriptors: {
      Severity: {
        precedence: 1,
        rules: [{
          value: "moderate",
          valueForm: "valueAdverb",
          descriptorForm: "NoDescriptor",
          order: "valueFirst",
          position: "beforeTopic",
        }],
      },
    },
    concepts: { Pain: { display: "pain" }, moderate: { display: "moderate" } },
  });
  const report = renderReport(
    finding({
      topic: "Pain",
      qualifiers: [{ descriptor: "Severity", value: "moderate" }],
    }),
    k,
  );
  assertEquals(report.sentence, "Moderately pain");
  assert(report.missing.includes("lexicon:valueAdverbs.moderate"));
});

Deno.test("a missing rule is reported and the value is still shown", () => {
  const k = knowledge({ concepts: { Pain: { display: "pain" }, odd: { display: "odd" } } });
  const report = renderReport(
    finding({
      topic: "Pain",
      qualifiers: [{ descriptor: "Mystery", value: "odd" }],
    }),
    k,
  );
  assertEquals(report.sentence, "Pain odd");
  assert(report.missing.includes("rules:Mystery.odd"));
});

Deno.test("numeric qualifier: descriptor-first is '<word> <number> <unit>'", () => {
  const k = knowledge({
    descriptors: {
      Duration: {
        precedence: 1,
        rules: [{
          value: "day",
          valueForm: "valueNoun",
          descriptorForm: "descNoun",
          order: "descFirst",
          position: "afterTopic",
        }],
      },
    },
    lexicon: { descriptors: { Duration: { noun: "for", adjective: null, negative: null } }, valueAdverbs: {} },
    concepts: { Pain: { display: "pain" }, day: { display: "day" } },
  });
  assertEquals(
    render(
      finding({
        topic: "Pain",
        qualifiers: [{ descriptor: "Duration", value: "day", number: 1, unit: "day" }],
      }),
      k,
    ),
    "Pain for 1 day",
  );
  assertEquals(
    render(
      finding({
        topic: "Pain",
        qualifiers: [{ descriptor: "Duration", value: "day", number: 2, unit: "day" }],
      }),
      k,
    ),
    "Pain for 2 days",
  );
});

Deno.test("summary value is rendered as the descriptor named by the summary type", () => {
  const k = knowledge({
    descriptors: {
      hasClinicalAbsence: {
        precedence: 1,
        rules: [{
          value: "presence",
          valueForm: "valueAdjective",
          descriptorForm: "NoDescriptor",
          order: "valueFirst",
          position: "afterTopic",
        }],
      },
    },
    summaryTypes: ["AbsentPresent: { hasClinicalAbsence absence } { hasClinicalAbsence presence }"],
    concepts: {
      Swelling: { display: "swelling", summaryType: "AbsentPresent" },
      presence: { display: "present" },
    },
  });
  assertEquals(render(finding({ topic: "Swelling", summary: "presence" }), k), "Swelling present");
});

Deno.test("locative preposition comes from concept-links; missing link falls back to 'in'", () => {
  const k = knowledge({
    concepts: {
      PainSymptom: { display: "pain" },
      Thumb: { display: "thumb" },
    },
    links: { PainSymptom: { locativeLinks: ["in Thumb"] } },
  });
  assertEquals(
    render(finding({ topic: "PainSymptom", location: "Thumb", laterality: "right" }), k),
    "Pain in right thumb",
  );
  const bare = knowledge({
    concepts: { PainSymptom: { display: "pain" }, Thumb: { display: "thumb" } },
  });
  const report = renderReport(finding({ topic: "PainSymptom", location: "Thumb" }), bare);
  assertEquals(report.sentence, "Pain in thumb");
  assert(report.missing.includes("locative:PainSymptom"));
});

Deno.test("thumb-pain fixture reproduces the public summary lines", async () => {
  const k = await loadSentenceKnowledge(fixtureOut);
  const cases = findingsFromParsed(parse(await Deno.readTextFile(findingsPath)));
  const byTopic = (id: string) => {
    const all = parse(Deno.readTextFileSync(findingsPath)) as { id: string }[];
    const index = all.findIndex((row) => row.id === id);
    return cases[index];
  };
  const expected: Record<string, string> = {
    "pain-bare": "Thumb pain",
    "pain-right": "Pain in right thumb",
    "pain-left": "Pain in left thumb",
    "swelling-present": "Thumb swelling present",
    "swelling-left": "Swelling of left thumb present",
    "swelling-distal": "Swelling of distal phalanx of left thumb present",
    "swelling-2-days": "Swelling of distal phalanx of left thumb for 2 days, present",
    "swelling-2-weeks": "Swelling of distal phalanx of left thumb for 2 weeks, present",
    "swelling-onset": "Gradual onset swelling of distal phalanx of left thumb for 2 weeks, present",
    "swelling-full": "Gradual onset, moderately severe swelling of distal phalanx of left thumb for 2 weeks, present",
  };
  for (const [id, sentence] of Object.entries(expected)) {
    const report = renderReport(byTopic(id), k);
    assertEquals(report.sentence, sentence, id);
    assertEquals(report.missing, [], id);
  }
});

Deno.test("cli: deno task sentence <out> <finding.yaml>", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    assertEquals(await sentenceMain([fixtureOut, findingsPath]), 0);
  } finally {
    console.log = orig;
  }
  assertEquals(lines[0], "Thumb pain");
  assertEquals(lines[1], "Pain in right thumb");
  assertEquals(
    lines.at(-1),
    "Gradual onset, moderately severe swelling of distal phalanx of left thumb for 2 weeks, present",
  );
  assertEquals(lines.length, 10);
});

Deno.test("cli usage", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    assertEquals(await sentenceMain(["--help"]), 0);
    assertEquals(await sentenceMain([]), 2);
  } finally {
    console.error = orig;
  }
  assert(errors[0].includes("out-dir"));
});

Deno.test("finding yaml rejects a bad laterality", () => {
  assertThrows(() => findingsFromParsed({ topic: "Pain", laterality: "both", qualifiers: [] }));
});

const expectationsPath = Deno.env.get("CLINERGY_SENTENCE_EXPECTATIONS");
const extractedOut = Deno.env.get("CLINERGY_OUT");
const zip = Deno.env.get("CLINERGY_ZIP");

Deno.test({
  name:
    "integration: sentences from real extractor output (CLINERGY_OUT or CLINERGY_ZIP, plus CLINERGY_SENTENCE_EXPECTATIONS)",
  ignore: !expectationsPath || (!extractedOut && !zip),
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
      const doc = parse(await Deno.readTextFile(expectationsPath!));
      const rows = Array.isArray(doc) ? doc : (doc as { cases?: unknown[] }).cases ?? [];
      assert(rows.length > 0, "expectations file is empty");
      for (const row of rows) {
        const rec = row as { expected?: string; lang?: string; finding?: unknown };
        if (rec.lang && rec.lang !== "en") {
          throw new Error(`this build renders English only; case asked for lang ${rec.lang}`);
        }
        if (typeof rec.expected !== "string" || !rec.finding) {
          throw new Error("each expectations entry needs `expected` and `finding`");
        }
        const [finding] = findingsFromParsed(rec.finding);
        assertEquals(render(finding, k), rec.expected);
      }
    } finally {
      if (tmp) await Deno.remove(tmp, { recursive: true });
    }
  },
});
