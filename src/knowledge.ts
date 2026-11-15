/**
 * Assemble the parsed dumps into one in-memory knowledge base and derive the
 * per-topic data-entry form descriptions.
 */
import {
  type BodyMapFile,
  type CritLinkVisibility,
  type Descriptor,
  type Entity,
  type Exam,
  type FeatureVisibility,
  parseBodyMapIni,
  parseCritLinkVisibility,
  parseEntities,
  parseExams,
  parseFeatureVisibility,
  parseLanguage,
  parsePermanentIds,
  parseSearchSpace,
  parseSelectorVisibility,
  parseTopicList,
  parseValuePrecedence,
  type SelectorVisibility,
  type TopicListRow,
} from "./parse.ts";
import type { DescriptorWords } from "./lexicon.ts";

/** Names of the probe dump files (see probe.c). */
export const DUMP_FILES = [
  "entities.tsv",
  "exams.tsv",
  "lang.txt",
  "permids.txt",
  "search.txt",
  "values.txt",
  "vis.txt.vc",
  "vis.txt.vf",
  "vis.txt.vl",
  "vis.txt.vs",
] as const;
/** Compdata INI files with body maps / selector definitions. */
export const BODYMAP_INIS = ["Selector.ini", "Onelist.ini", "Demosel.ini", "Vga.ini", "Manmap.ini", "Womanmap.ini"];
/** Compdata INI files with short "common topic" pick lists. */
export const TOPIC_LIST_INIS = [
  "Comtopic.ini",
  "Symptoms.ini",
  "Diseases.ini",
  "Famhist.ini",
  "Healthch.ini",
  "Exams.ini",
  "Pasthist.ini",
  "Procs.ini",
];

export interface Knowledge {
  modelVersion: string;
  entities: Map<string, Entity>;
  permanentIds: Map<string, number>;
  features: Map<string, FeatureVisibility[]>;
  critLinks: Map<string, CritLinkVisibility[]>;
  laterality: Map<string, SelectorVisibility>;
  sublocations: Map<string, SelectorVisibility>;
  descriptors: Map<string, Descriptor>;
  valuePrecedence: Map<string, number>;
  exams: Map<string, Exam>;
  lists: Map<string, string[]>;
  search: Map<string, string[]>;
  bodyMaps: Map<string, BodyMapFile>;
  topicLists: Map<string, TopicListRow[]>;
  /** heuristic word forms from the binary model (see lexicon.ts); empty if not available */
  descriptorWords: Map<string, DescriptorWords>;
  valueAdverbs: Map<string, string>;
}

/**
 * Build the knowledge base from file texts.
 * @param dumps probe output keyed by DUMP_FILES name
 * @param inis Compdata ini texts keyed by file name (missing files are skipped)
 */
export function buildKnowledge(
  dumps: Record<string, string>,
  inis: Record<string, string>,
  words: { descriptorWords?: Map<string, DescriptorWords>; valueAdverbs?: Map<string, string> } = {},
): Knowledge {
  const d = (k: string) => dumps[k] ?? "";
  const { exams, lists, modelVersion } = parseExams(d("exams.tsv"));
  const bodyMaps = new Map<string, BodyMapFile>();
  for (const f of BODYMAP_INIS) if (inis[f] !== undefined) bodyMaps.set(f, parseBodyMapIni(inis[f]));
  const topicLists = new Map<string, TopicListRow[]>();
  for (const f of TOPIC_LIST_INIS) if (inis[f] !== undefined) topicLists.set(f, parseTopicList(inis[f]));
  return {
    modelVersion,
    entities: parseEntities(d("entities.tsv")),
    permanentIds: parsePermanentIds(d("permids.txt")),
    features: parseFeatureVisibility(d("vis.txt.vf")),
    critLinks: parseCritLinkVisibility(d("vis.txt.vc")),
    laterality: parseSelectorVisibility(d("vis.txt.vl"), "VisualLat"),
    sublocations: parseSelectorVisibility(d("vis.txt.vs"), "VisualSubLoc"),
    descriptors: parseLanguage(d("lang.txt")),
    valuePrecedence: parseValuePrecedence(d("values.txt")),
    exams,
    lists,
    search: parseSearchSpace(d("search.txt")),
    bodyMaps,
    topicLists,
    descriptorWords: words.descriptorWords ?? new Map(),
    valueAdverbs: words.valueAdverbs ?? new Map(),
  };
}

// ---- forms -------------------------------------------------------------------

/** "Complete symptom" -> "symptom"; "" -> "other". */
export function categoryWord(category: string): string {
  return category.split(" ").pop() || "other";
}
/** Clinergy marks a topic usable on a form with category "Complete <kind>". */
export const isFormTopic = (e: Entity) => e.category.startsWith("Complete");

/** Direct supertypes. Probe writes "Name" or "Name <extra>"; we keep the name. */
export const supersOf = (e: Entity | undefined) => (e?.links.supers ?? []).map((s) => s.split(" ")[0]);

/** All ancestors of a concept (transitive supers). */
export function ancestors(k: Knowledge, name: string): Set<string> {
  const seen = new Set<string>();
  const stack = [name];
  while (stack.length) {
    for (const s of supersOf(k.entities.get(stack.pop()!))) {
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return seen;
}

/** One visible item on a form layer. */
export interface FormItem {
  feature?: string;
  criterialLink?: string;
  values: unknown[];
  multiple?: boolean;
  /** How this row relates to the nearest ancestor that also has visibility rows. */
  inheritance?: "same-as-ancestor" | "overrides-ancestor" | "added";
}
/** A linked topic (associated symptom/sign, diagnosis, ...) as written in the model. */
export interface FormLink {
  /** the item exactly as the engine returns it, e.g. "SwellingSymptom of Elbow" */
  item: string;
  concept: string;
  preposition: string | null;
  location: string | null;
  /** named pre-coordinated concept for concept+location, if the model has exactly one */
  preCoordinated: string | null;
  category: string | null;
  summaryType: string | null;
}
export interface FormExam {
  exam: string;
  perSide: string[] | null;
  signs: string[];
  subExams: string[];
}
export interface Form {
  topic: string;
  display: string;
  category: string;
  summaryType: string;
  location: string | null;
  supers: string[];
  /** nearest ancestor with its own visibility rows, used for the inheritance flags */
  visibilityAncestor: string | null;
  firstLayer: FormItem[];
  moreLayer: FormItem[];
  associatedSymptomsAndSigns: FormLink[];
  diagnoses: FormLink[];
  otherLinks: FormLink[];
  examinations: FormExam[];
}

/** Index used to resolve "Base of Location" to a pre-coordinated concept. */
export class Resolver {
  /** location -> concepts (in id order) whose only locative link is that location */
  #byLocation = new Map<string, string[]>();
  #ancestors = new Map<string, Set<string>>();
  constructor(private k: Knowledge) {
    for (const [n, e] of k.entities) {
      const locs = e.links.locativeLinks ?? [];
      if (locs.length !== 1) continue;
      const loc = locs[0].split(" ").slice(1).join(" ") || locs[0];
      const a = this.#byLocation.get(loc) ?? [];
      a.push(n);
      this.#byLocation.set(loc, a);
    }
  }
  /** 'SwellingSymptom' + 'Elbow' -> 'ElbowSwellingSymptom' if such a named concept exists. */
  resolve(base: string, location: string | null): string | null {
    if (!location) return base;
    for (const n of this.#byLocation.get(location) ?? []) {
      let a = this.#ancestors.get(n);
      if (!a) this.#ancestors.set(n, a = ancestors(this.k, n));
      if (a.has(base)) return n;
    }
    return null;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Rebuild what Clinergy's Data Entry Form shows for one topic. */
export function assembleForm(k: Knowledge, topic: string, resolver: Resolver): Form {
  const e = k.entities.get(topic);
  if (!e) throw new Error(`unknown topic ${topic}`);
  // The form's location is the (last) locative link, e.g. "in Elbow" -> Elbow.
  let location: string | null = null;
  for (const l of e.links.locativeLinks ?? []) {
    const i = l.indexOf(" ");
    location = i < 0 ? "" : l.slice(i + 1);
  }
  const form: Form = {
    topic,
    display: e.display,
    category: categoryWord(e.category),
    summaryType: e.summaryType,
    location,
    supers: supersOf(e),
    visibilityAncestor: null,
    firstLayer: [],
    moreLayer: [],
    associatedSymptomsAndSigns: [],
    diagnoses: [],
    otherLinks: [],
    examinations: [],
  };
  // Laterality / sublocation pickers come from the location, not the topic.
  if (location && k.laterality.has(location)) {
    form.firstLayer.push({ feature: "laterality", values: k.laterality.get(location)!.values, multiple: true });
  }
  if (location && k.sublocations.has(location) && e.showSubLocations) {
    form.firstLayer.push({ feature: "sublocation", values: k.sublocations.get(location)!.values });
  }
  // Inheritance: compare with the nearest ancestor (breadth-first) that has rows.
  const anc = nearestWithVisibility(k, topic);
  form.visibilityAncestor = anc;
  const ancRows = new Map<string, unknown>();
  for (const r of anc ? k.features.get(anc) ?? [] : []) ancRows.set("f:" + r.feature, r);
  for (const r of anc ? k.critLinks.get(anc) ?? [] : []) ancRows.set("c:" + r.criterialLink, r);
  const flag = (key: string, row: unknown): FormItem["inheritance"] =>
    !anc
      ? undefined
      : !ancRows.has(key)
      ? "added"
      : same(ancRows.get(key), row)
      ? "same-as-ancestor"
      : "overrides-ancestor";
  for (const r of k.features.get(topic) ?? []) {
    (r.layer === "first" ? form.firstLayer : form.moreLayer)
      .push({ feature: r.feature, values: r.values, inheritance: flag("f:" + r.feature, r) });
  }
  for (const r of k.critLinks.get(topic) ?? []) {
    (r.layer === "first" ? form.firstLayer : form.moreLayer)
      .push({ criterialLink: r.criterialLink, values: r.values, inheritance: flag("c:" + r.criterialLink, r) });
  }
  // Form links: "Concept", or "Concept <preposition> <Location>".
  for (const item of e.links.formLinkTopics ?? []) {
    const [concept, preposition = null, ...rest] = item.split(" ");
    const loc = rest.length ? rest.join(" ") : null;
    const be = k.entities.get(concept);
    const cat = be ? categoryWord(be.category) : null;
    const link: FormLink = {
      item,
      concept,
      preposition,
      location: loc,
      preCoordinated: resolver.resolve(concept, loc),
      category: be?.category ? cat : null,
      summaryType: be?.summaryType ?? null,
    };
    if (cat === "symptom" || cat === "sign") form.associatedSymptomsAndSigns.push(link);
    else if (cat === "disease") form.diagnoses.push(link);
    else form.otherLinks.push(link);
  }
  for (const x of e.links.exams ?? []) {
    const ex = k.exams.get(x);
    form.examinations.push({
      exam: x,
      perSide: ex?.lateral ? ["left", "right"] : null,
      signs: ex?.signs0 ?? [],
      subExams: ex?.subExams ?? [],
    });
  }
  return form;
}

function nearestWithVisibility(k: Knowledge, topic: string): string | null {
  const seen = new Set([topic]);
  let frontier = supersOf(k.entities.get(topic));
  while (frontier.length) {
    const next: string[] = [];
    for (const s of frontier) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (k.features.has(s) || k.critLinks.has(s)) return s;
      next.push(...supersOf(k.entities.get(s)));
    }
    frontier = next;
  }
  return null;
}

// ---- statistics (used for the parity check against the earlier extraction) --

export function statistics(k: Knowledge) {
  const ents = [...k.entities.values()];
  const sumLinks = (key: string) => ents.reduce((n, e) => n + (e.links[key]?.length ?? 0), 0);
  const withLinks = (key: string) => ents.filter((e) => e.links[key]?.length).length;
  const rows = [...k.features.values()].flat();
  const bodyMapLocations: Record<string, { locations: number; sublocations: number }> = {};
  for (const [f, b] of k.bodyMaps) {
    const locs = [...b.maps.values()].flat();
    bodyMapLocations[f] = { locations: locs.length, sublocations: locs.reduce((n, l) => n + l.sublocations.length, 0) };
  }
  return {
    entitiesNamed: k.entities.size,
    completeTopics: ents.filter(isFormTopic).length,
    conceptsWithVisibleFeatures: k.features.size,
    visibleFeatureRows: rows.length,
    visibleFeatureRowsFirstLayer: rows.filter((r) => r.layer === "first").length,
    critLinkVisRows: [...k.critLinks.values()].flat().length,
    lateralityVis: k.laterality.size,
    sublocationVis: k.sublocations.size,
    candidateFeatureAtts: sumLinks("visFeatureAtts"),
    topicsWithFormLinks: withLinks("formLinkTopics"),
    formLinks: sumLinks("formLinkTopics"),
    topicsWithExamLinks: withLinks("exams"),
    examLinks: sumLinks("exams"),
    topicSelectorLinks: sumLinks("tsLinks"),
    exams: k.exams.size,
    languageDescriptors: k.descriptors.size,
    languageRules: [...k.descriptors.values()].reduce((n, d) => n + d.rules.size, 0),
    valuePrecedences: k.valuePrecedence.size,
    permanentIds: k.permanentIds.size,
    searchPrefixes: k.search.size,
    descriptorWordEntries: k.descriptorWords.size,
    valueAdverbs: k.valueAdverbs.size,
    bodyMapLocations,
  };
}
