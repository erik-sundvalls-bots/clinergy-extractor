/**
 * Write the knowledge base as a tree of YAML files (see README "Output layout").
 * Every file starts with a comment header saying what it is, where it came
 * from and that the content belongs to its rights holders.
 */
import { dirname, join } from "@std/path";
import { toYaml } from "./yaml.ts";
import {
  assembleForm,
  categoryWord,
  isFormTopic,
  type Knowledge,
  Resolver,
  statistics,
  supersOf,
} from "./knowledge.ts";

export const EXTRACTOR_VERSION = "0.1.0";

export interface Provenance {
  /** file name of the input, e.g. ClinergyDemo.zip */
  source: string;
  sha256: string;
  extractedAt: string;
}

export const COPYRIGHT =
  "Content (c) 1997-8 Semantic Technologies Ltd / Victoria University of Manchester. All rights reserved.";

/** Turn a model name into a safe file name (names are ASCII CamelCase in practice). */
export function fileSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_") || "_";
}

/**
 * Assign file names so that two names never collide on case-insensitive file
 * systems (Windows, macOS): the second "Foo"/"foo" becomes "foo~2".
 */
export class SlugAllocator {
  #used = new Map<string, number>();
  #given = new Map<string, string>();
  get(name: string): string {
    const known = this.#given.get(name);
    if (known) return known;
    const s = fileSlug(name);
    const n = (this.#used.get(s.toLowerCase()) ?? 0) + 1;
    this.#used.set(s.toLowerCase(), n);
    const slug = n === 1 ? s : `${s}~${n}`;
    this.#given.set(name, slug);
    return slug;
  }
}

/** First-letter bucket for big folders, e.g. "ElbowAcheSymptom" -> "E". */
const bucket = (slug: string) => (/^[A-Za-z]/.test(slug) ? slug[0].toUpperCase() : "_");

const obj = <V>(m: Map<string, V>) => Object.fromEntries(m);

export async function writeOutput(k: Knowledge, outDir: string, prov: Provenance): Promise<number> {
  let written = 0;
  const header = (title: string, extra: string[] = []) => [
    title,
    `Source: ${prov.source} (sha256 ${prov.sha256.slice(0, 16)}...), model ${k.modelVersion || "unknown"}`,
    `Extracted by clinergy-extractor ${EXTRACTOR_VERSION} on ${prov.extractedAt}.`,
    COPYRIGHT,
    "Private study copy: do not redistribute or publish. Field guide: README.md at the top of this folder.",
    ...extra,
  ];
  const write = async (rel: string, doc: unknown, title: string, extra: string[] = []) => {
    const p = join(outDir, rel);
    await Deno.mkdir(dirname(p), { recursive: true });
    await Deno.writeTextFile(p, toYaml(doc, header(title, extra)));
    written++;
  };

  // File names are allocated once so cross-references are stable.
  const conceptSlugs = new SlugAllocator();
  const conceptPath = (n: string) => {
    const s = conceptSlugs.get(n);
    return `concepts/${bucket(s)}/${s}.yaml`;
  };
  const formSlugs = new SlugAllocator();
  const formPath = (n: string) => `forms/${categoryWord(k.entities.get(n)!.category)}/${formSlugs.get(n)}.yaml`;
  const examSlugs = new SlugAllocator();
  const examPath = (n: string) => `exams/${k.exams.get(n)?.group ?? "sub"}/${examSlugs.get(n)}.yaml`;
  const descSlugs = new SlugAllocator();

  // ---- forms -------------------------------------------------------------------
  const resolver = new Resolver(k);
  const formIndex: Record<string, unknown> = {};
  for (const [name, e] of k.entities) {
    if (!isFormTopic(e)) continue;
    const f = assembleForm(k, name, resolver);
    const path = formPath(name);
    formIndex[name] = { display: e.display, category: f.category, file: path };
    await write(
      path,
      {
        topic: f.topic,
        display: f.display,
        category: f.category,
        summaryType: f.summaryType,
        location: f.location,
        supers: f.supers,
        concept: `../../${conceptPath(name)}`,
        visibilityAncestor: f.visibilityAncestor,
        firstLayer: f.firstLayer,
        moreLayer: f.moreLayer,
        associatedSymptomsAndSigns: f.associatedSymptomsAndSigns,
        diagnoses: f.diagnoses,
        otherLinks: f.otherLinks,
        examinations: f.examinations,
      },
      `Data-entry form for "${e.display}" (${name})`,
      [
        "firstLayer = items shown when the form opens; moreLayer = items behind the '>>' button.",
        "inheritance compares each row with visibilityAncestor (nearest supertype with its own rows).",
        "summaryType names the value set of the topic's own present/absent style control (see sentence-rules/summary-types.yaml).",
      ],
    );
  }
  await write("forms/index.yaml", formIndex, "Index of form topics (concepts with category 'Complete ...')");

  // ---- concepts ---------------------------------------------------------------
  const conceptIndex: Record<string, unknown> = {};
  for (const [name, e] of k.entities) {
    const path = conceptPath(name);
    conceptIndex[name] = { id: e.id, display: e.display, category: e.category || null, file: path };
    const { supers: _s, ...links } = e.links;
    await write(
      path,
      {
        name,
        id: e.id,
        permanentId: k.permanentIds.get(name) ?? null,
        display: e.display,
        category: e.category || null,
        summaryType: e.summaryType,
        relevance: e.relevance,
        showSubLocations: e.showSubLocations,
        leftHanded: e.leftHanded,
        supers: supersOf(e),
        form: isFormTopic(e) ? `../../${formPath(name)}` : null,
        visibleFeatures: k.features.get(name) ?? [],
        criterialLinkSummaries: k.critLinks.get(name) ?? [],
        laterality: k.laterality.get(name) ?? null,
        sublocations: k.sublocations.get(name) ?? null,
        links,
      },
      `Concept ${name}`,
      [
        "links are the raw results of the engine's per-concept queries (see probe/probe.c for the method names).",
      ],
    );
  }
  await write("concepts/index.yaml", conceptIndex, "Index of all named concepts in the model (id order)");

  // ---- exams ------------------------------------------------------------------
  const examIndex: Record<string, unknown> = {};
  for (const [name, x] of k.exams) {
    const path = examPath(name);
    examIndex[name] = { group: x.group, lateral: x.lateral, file: path };
    await write(
      path,
      {
        ...x,
        subExams: x.subExams.map((s) => ({ exam: s, file: `../../${examPath(s)}` })),
      },
      `Examination ${name}`,
      [
        "group: root / system / location / sub.  lateral: examined per side.",
        "signs0 and signs1 are SignsForExam(exam, 0) and (exam, 1): the engine's two sign lists.",
      ],
    );
  }
  await write("exams/index.yaml", examIndex, "Index of examinations");

  // ---- sentence rules ---------------------------------------------------------
  const descIndex: Record<string, unknown> = {};
  for (const [name, d] of k.descriptors) {
    const path = `sentence-rules/descriptors/${descSlugs.get(name)}.yaml`;
    descIndex[name] = { precedence: d.precedence, rules: d.rules.size, file: path };
    await write(
      path,
      {
        descriptor: name,
        precedence: d.precedence,
        rules: [...d.rules].map(([value, r]) => ({
          value,
          ...r,
          valuePrecedence: k.valuePrecedence.get(value) ?? null,
        })),
      },
      `Summary-sentence rules for descriptor ${name}`,
      [
        "precedence orders descriptors within a summary sentence; each rule gives the word form",
        "of a value (valueForm), of the descriptor (descriptorForm), their order and position relative to the topic.",
      ],
    );
  }
  await write("sentence-rules/index.yaml", descIndex, "Index of sentence-rule descriptors");
  await write(
    "sentence-rules/value-precedences.yaml",
    obj(k.valuePrecedence),
    "Value precedences (ordering of values in sentences)",
  );
  await write(
    "sentence-rules/lexicon.yaml",
    {
      descriptors: obj(k.descriptorWords),
      valueAdverbs: obj(k.valueAdverbs),
    },
    "Word forms for summary sentences (HEURISTIC scan of the binary model files, review before use)",
    [
      "descriptors: name -> noun / adjective / negative form; valueAdverbs: value -> adverb (e.g. for 'moderately severe').",
    ],
  );
  await write(
    "sentence-rules/summary-types.yaml",
    k.lists.get("summaryTypes") ?? [],
    "Summary types and their value sets",
  );

  // ---- body maps, pick lists, search -----------------------------------------
  for (const [file, b] of k.bodyMaps) {
    await write(
      `bodymap/${file.replace(/\.ini$/i, "").toLowerCase()}.yaml`,
      {
        file,
        selectors: b.selectors,
        maps: Object.fromEntries([...b.maps].filter(([, v]) => v.length)),
      },
      `Body maps and selector definitions from ${file}`,
      [
        "hotspot = [x1, x2, y1, y2] as written in the INI file; inset = bitmap shown after clicking.",
      ],
    );
  }
  for (const [file, rows] of k.topicLists) {
    await write(`topic-lists/${file.replace(/\.ini$/i, "").toLowerCase()}.yaml`, rows, `Quick-pick topic list ${file}`);
  }
  await write("search/search-space.yaml", obj(k.search), "Type-ahead search index: typed text -> offered concepts");

  // ---- model summary + README --------------------------------------------------
  const stats = statistics(k);
  await write("model.yaml", {
    modelVersion: k.modelVersion,
    source: prov,
    statistics: stats,
    lists: Object.fromEntries([...k.lists].filter(([n]) => n !== "summaryTypes")),
  }, "Model summary, counts and global lists");
  await Deno.writeTextFile(join(outDir, "README.md"), readme(k, prov, stats));
  return written + 1;
}

function readme(k: Knowledge, prov: Provenance, s: ReturnType<typeof statistics>): string {
  return `# Clinergy / PEN&PAD 1998 knowledge, as YAML

${COPYRIGHT}
This folder was generated from your own copy of \`${prov.source}\`
(sha256 \`${prov.sha256}\`) by clinergy-extractor ${EXTRACTOR_VERSION} on ${prov.extractedAt}.
It is a private study copy: do not redistribute or publish it without the rights holders' permission.

Model version: ${k.modelVersion || "unknown"}. ${s.entitiesNamed} named concepts, ${s.completeTopics} form topics,
${s.visibleFeatureRows} visible form items on ${s.conceptsWithVisibleFeatures} concepts, ${s.exams} examinations.

| Path | Contents |
|---|---|
| \`forms/<category>/<Topic>.yaml\` | one data-entry form per topic: first-layer and ">>" items in order with their curated values, inheritance flags, associated symptoms/signs, diagnoses, examinations |
| \`concepts/<A-Z>/<Name>.yaml\` | every named concept: ids, display text, supertypes, visibility rows, all per-concept query results |
| \`exams/<group>/<Exam>.yaml\` | the examination tree: signs, sub-exams, linked symptoms, laterality |
| \`sentence-rules/\` | descriptor precedences, per-value word forms and positions, value precedences, summary types, lexicon (noun/adjective/negative forms, adverbs) |
| \`bodymap/\` | body-map click areas and selector buttons from the Compdata INI files |
| \`topic-lists/\` | short quick-pick lists (common topics, symptoms, ...) |
| \`search/search-space.yaml\` | the type-ahead search index |
| \`*/index.yaml\`, \`model.yaml\` | indexes, counts and global lists |
`;
}
