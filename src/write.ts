/**
 * Write the knowledge base as a tree of YAML files (see README "Output layout").
 * Every file starts with a comment header saying what it is, where it came
 * from and that the content belongs to its rights holders.
 */
import { dirname, join } from "@std/path";
import { toYaml } from "./yaml.ts";
import type { ImageSet } from "./images.ts";
import type { MapLocation } from "./parse.ts";
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

const obj = <V>(m: Map<string, V>) => Object.fromEntries(m);

export async function writeOutput(k: Knowledge, outDir: string, prov: Provenance, images?: ImageSet): Promise<number> {
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

  // Form file names are allocated once so cross-references are stable.
  const formSlugs = new SlugAllocator();
  const formPath = (n: string) => `forms/${categoryWord(k.entities.get(n)!.category)}/${formSlugs.get(n)}.yaml`;

  // ---- forms: one file per form topic ------------------------------------------
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
        concept: `concepts.yaml#${name}`,
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
        "concept: key into concepts.yaml at the top of this folder; exam names are keys into exams.yaml.",
        "summaryType names the value set of the topic's own present/absent style control (sentence-rules.yaml).",
      ],
    );
  }
  await write("forms/index.yaml", formIndex, "Index of form topics (concepts with category 'Complete ...')");

  // ---- concepts: one lookup file for the core facts, one for raw query results ---
  const concepts: Record<string, unknown> = {};
  const conceptLinks: Record<string, unknown> = {};
  for (const [name, e] of k.entities) {
    const { supers: _s, ...links } = e.links;
    concepts[name] = {
      id: e.id,
      permanentId: k.permanentIds.get(name) ?? null,
      display: e.display,
      category: e.category || null,
      summaryType: e.summaryType,
      relevance: e.relevance,
      showSubLocations: e.showSubLocations,
      leftHanded: e.leftHanded,
      supers: supersOf(e),
      form: isFormTopic(e) ? formPath(name) : null,
      visibleFeatures: k.features.get(name) ?? [],
      criterialLinkSummaries: k.critLinks.get(name) ?? [],
      laterality: k.laterality.get(name) ?? null,
      sublocations: k.sublocations.get(name) ?? null,
    };
    if (Object.keys(links).length) conceptLinks[name] = links;
  }
  await write("concepts.yaml", concepts, "All named concepts in the model (id order), keyed by name", [
    "form: path of the concept's form file (form topics only). Raw per-concept query results are in concept-links.yaml.",
  ]);
  await write("concept-links.yaml", conceptLinks, "Raw per-concept query results, keyed by concept name", [
    "Lists returned by the engine's per-concept methods (see probe/probe.c), e.g. visFeatureAtts = candidate",
    "feature attributes, sensibles = sensible sanctions, tsLinks = topic-selector links. Concepts without any are omitted.",
  ]);

  // ---- exams ------------------------------------------------------------------
  await write("exams.yaml", obj(k.exams), "Examination tree, keyed by exam name", [
    "group: root / system / location / sub.  lateral: examined per side.  subExams are keys in this file.",
    "signs0 and signs1 are SignsForExam(exam, 0) and (exam, 1): the engine's two sign lists.",
  ]);

  // ---- sentence rules ---------------------------------------------------------
  const descriptors: Record<string, unknown> = {};
  for (const [name, d] of k.descriptors) {
    descriptors[name] = {
      precedence: d.precedence,
      rules: [...d.rules].map(([value, r]) => ({ value, ...r, valuePrecedence: k.valuePrecedence.get(value) ?? null })),
    };
  }
  await write(
    "sentence-rules.yaml",
    {
      descriptors,
      valuePrecedences: obj(k.valuePrecedence),
      summaryTypes: k.lists.get("summaryTypes") ?? [],
      lexicon: { descriptors: obj(k.descriptorWords), valueAdverbs: obj(k.valueAdverbs) },
    },
    "Summary-sentence rules",
    [
      "descriptors: precedence orders descriptors within a sentence; each rule gives the word form of a value",
      "(valueForm), of the descriptor (descriptorForm), their order and position relative to the topic.",
      "valuePrecedences: ordering of values. summaryTypes: present/absent style value sets.",
      "lexicon: HEURISTIC scan of the binary model files (noun / adjective / negative forms, value adverbs); review before use.",
    ],
  );

  // ---- body maps, pick lists, search -----------------------------------------
  // Images are linked by bitmap name (case-insensitive, as on Windows).
  const img = (bmp: string | null) => {
    const e = bmp ? images?.loose.get(bmp.toLowerCase()) : undefined;
    return e ? `images/${e.file}` : null;
  };
  const withImage = (l: MapLocation) => ({ ...l, insetImage: img(l.inset), sublocations: l.sublocations });
  const bodyMaps: Record<string, unknown> = {};
  for (const [file, b] of k.bodyMaps) {
    bodyMaps[file] = {
      selectors: b.selectors.map((s) => ({
        ...s,
        options: s.options.map((o) => ({ ...o, bitmapImages: o.bitmaps.map(img) })),
      })),
      mainGraphics: Object.fromEntries([...b.mainGraphics].map(([m, g]) => [m, {
        concept: g.concept,
        hotspot: g.hotspot,
        picture: g.inset,
        image: img(g.inset),
        rect: g.insetRect,
      }])),
      maps: Object.fromEntries([...b.maps].filter(([, v]) => v.length).map(([m, v]) => [m, v.map(withImage)])),
    };
  }
  await write("bodymap.yaml", bodyMaps, "Body maps and selector definitions, keyed by INI file", [
    "hotspot = [top, bottom, left, right] in pixels of the picture being clicked (as written in the INI file):",
    "  a map's locations are on its mainGraphics picture (or the BEGIN location's inset); a location's",
    "  sublocations are on that location's inset picture. Checked by drawing them on the extracted images.",
    "inset = picture shown after clicking a location; insetRect / rect = [left, top, width, height] where it is",
    "drawn in the selector's graphic window. insetImage / image / bitmapImages = the PNG under images/.",
  ]);
  if (images) {
    for (const [rel, bytes] of images.files) {
      const p = join(outDir, "images", rel);
      await Deno.mkdir(dirname(p), { recursive: true });
      await Deno.writeFile(p, bytes);
      written++;
    }
    const counts: Record<string, number> = {};
    for (const e of images.entries) counts[e.format] = (counts[e.format] ?? 0) + 1;
    await write(
      "images.yaml",
      Object.fromEntries(images.entries.map(({ file, sizes, ...e }) => [file ? `images/${file}` : `error:${e.source}`, {
        ...e,
        ...(sizes ? { sizes: sizes.map((x) => ({ ...x, file: `images/${x.file}` })) } : {}),
      }])),
      "Every image found in the demo, converted to PNG (icons and cursors also kept as .ico/.cur), keyed by output file",
      [
        `Found: ${Object.entries(counts).map(([f, n]) => `${n} ${f}`).join(", ")}.`,
        "source = file inside the installer (GroupN/... = payload of _SETUP.1-5; zip/... = outer zip and _SETUP.LIB).",
        "format: bmp = bitmap file, dib = RT_BITMAP resource, ico/cur = icon/cursor group (one PNG per size in sizes),",
        "wmf = Windows metafile resource kept as is. usedFor: from the body-map INI files, MFC toolbar resources and",
        "the first icon of each EXE; empty when not known. Images from bundled runtime DLLs/OCXs are included as found.",
      ],
    );
  }
  await write("topic-lists.yaml", obj(k.topicLists), "Quick-pick topic lists, keyed by INI file");
  await write("search-space.yaml", obj(k.search), "Type-ahead search index: typed text -> offered concepts");

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
| \`forms/index.yaml\` | form topics with display text and file path |
| \`concepts.yaml\` | every named concept, keyed by name: ids, display text, category, supertypes, visibility rows, form path |
| \`concept-links.yaml\` | raw per-concept query results (candidate attributes, sanctions, links) |
| \`exams.yaml\` | the examination tree: signs, sub-exams, linked symptoms, laterality |
| \`sentence-rules.yaml\` | descriptor precedences and per-value rules, value precedences, summary types, lexicon |
| \`bodymap.yaml\` | body-map click areas and selector buttons from the Compdata INI files, linked to their pictures |
| \`images/\`, \`images.yaml\` | every picture and icon in the demo as PNG (icons also as .ico): bodymap/, buttons/, bitmaps/, resources/, icons/, metafiles/ |
| \`topic-lists.yaml\` | short quick-pick lists (common topics, symptoms, ...) |
| \`search-space.yaml\` | the type-ahead search index |
| \`model.yaml\` | counts and global lists |
`;
}
