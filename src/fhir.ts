/**
 * FHIR R4 SDC Questionnaires and Symptom Logical Model instances from
 * extractor form YAML and structured findings.
 *
 * Codes are written only from a verified OpenGALEN map (method exact,
 * normalised or reviewed) or a reviewed SNOMED map when one is supplied.
 * Nothing is guessed. Uncoded items stay as display text; unmapped parts
 * are listed.
 *
 * This is a bulk generator over whatever forms are in an extract. The
 * workbench's runtime export is the same idea, specialised to the public
 * thumb-pain form.
 */
import { parse } from "@std/yaml";
import { dirname, join } from "@std/path";
import { openGalenFromParsed } from "./openehr.ts";
import {
  type Finding,
  findingsFromParsed,
  loadSentenceKnowledge,
  type Qualifier,
  render,
  type SentenceKnowledge,
} from "./sentence.ts";

export const SNOMED = "http://snomed.info/sct";
export const OPEN_GALEN = "http://www.opengalen.org/owl/opengalen.owl#";
export const UCUM = "http://unitsofmeasure.org";
export const SDC_QUESTIONNAIRE_PROFILE = "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire";
export const SDC_RESPONSE_PROFILE = "http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaireresponse";
export const SYMPTOM_PROFILE = "http://hl7.org/fhir/uv/symptoms/StructureDefinition/SymptomLogicalModel";
export const ITEM_CONTROL = "http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl";
export const ITEM_CONTROL_VS = "http://hl7.org/fhir/questionnaire-item-control";
export const UNIT_OPTION = "http://hl7.org/fhir/StructureDefinition/questionnaire-unitOption";

export const DURATION_UNITS: Record<string, { unit: string; code: string }> = {
  second: { unit: "seconds", code: "s" },
  minute: { unit: "minutes", code: "min" },
  hour: { unit: "hours", code: "h" },
  day: { unit: "days", code: "d" },
  week: { unit: "weeks", code: "wk" },
  month: { unit: "months", code: "mo" },
  year: { unit: "years", code: "a" },
};

const VERIFIED_OG = new Set(["exact", "normalised", "reviewed"]);
const DURATION_FEATURES = new Set(["Duration", "QuantityDuration"]);

export interface FhirCoding {
  system: string;
  code: string;
  display: string;
}

export interface CodingMaps {
  opengalen: Record<string, { name: string; method: string }>;
  snomed: Record<string, { code: string; term: string }>;
  displays: Record<string, string>;
}

export interface FormItem {
  feature?: string;
  criterialLink?: string;
  values?: unknown[];
  multiple?: boolean;
}

export interface FormLink {
  item: string;
  concept?: string;
  preposition?: string | null;
  location?: string | null;
  preCoordinated?: string | null;
  category?: string | null;
  summaryType?: string | null;
}

export interface FormExam {
  exam: string;
  perSide?: string[] | null;
  signs?: string[];
  subExams?: string[];
}

export interface FormDoc {
  topic: string;
  display: string;
  category: string;
  summaryType?: string;
  location?: string | null;
  firstLayer: FormItem[];
  moreLayer: FormItem[];
  associatedSymptomsAndSigns: FormLink[];
  diagnoses: FormLink[];
  otherLinks: FormLink[];
  examinations: FormExam[];
  file: string;
}

export interface Unmapped {
  key: string;
  reason: string;
}

export interface SymptomGap {
  path: string;
  clinergy?: string;
  reason: string;
}

export interface FhirWriteResult {
  questionnaires: number;
  responses: number;
  symptoms: number;
  failures: { file: string; error: string }[];
  unmapped: Unmapped[];
  gaps: SymptomGap[];
  destDir: string;
}

type Yaml = Record<string, unknown>;
const asRecord = (value: unknown): Yaml =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Yaml : {};
const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length ? value : undefined;

export function displayOf(key: string, maps?: CodingMaps): string {
  const coded = maps && codingFor(key, maps);
  if (coded?.display) return coded.display;
  if (maps?.displays[key]) return maps.displays[key];
  if (key === "presence") return "present";
  if (key === "absence") return "absent";
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

export function codingFor(key: string, maps: CodingMaps): FhirCoding | null {
  const snomed = maps.snomed[key];
  if (snomed) return { system: SNOMED, code: snomed.code, display: snomed.term };
  const og = maps.opengalen[key];
  if (og) return { system: OPEN_GALEN, code: og.name, display: maps.displays[key] || og.name };
  return null;
}

export function ucumOf(unit: string): { unit: string; system: string; code: string } | null {
  const row = DURATION_UNITS[unit];
  return row ? { unit: row.unit, system: UCUM, code: row.code } : null;
}

export function isoDuration(n: number, unit: string): string {
  const designator: Record<string, string> = {
    second: "PT{n}S",
    minute: "PT{n}M",
    hour: "PT{n}H",
    day: "P{n}D",
    week: "P{n}W",
    month: "P{n}M",
    year: "P{n}Y",
  };
  return (designator[unit] ?? "P{n}D").replace("{n}", String(n));
}

export function loadOpenGalenCoding(doc: unknown): CodingMaps["opengalen"] {
  const out: CodingMaps["opengalen"] = {};
  for (const [key, row] of Object.entries(openGalenFromParsed(doc))) {
    if (row.opengalen && VERIFIED_OG.has(row.method)) out[key] = { name: row.opengalen, method: row.method };
  }
  return out;
}

/** Reviewed SNOMED map shape from mappings/snomed.yaml (issue #4). Optional. */
export function loadSnomedCoding(doc: unknown): CodingMaps["snomed"] {
  const out: CodingMaps["snomed"] = {};
  const concepts = asRecord(asRecord(doc).concepts);
  const add = (key: string, code: string, term: string) => {
    out[key] = { code, term };
  };
  for (const [key, value] of Object.entries(concepts)) {
    const row = asRecord(value);
    if (row.verified !== true) continue;
    const code = optionalString(row.code);
    const term = optionalString(row.term);
    if (!code || !term) continue;
    add(key, code, term);
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const alias of aliases) if (typeof alias === "string" && alias) add(alias, code, term);
  }
  return out;
}

export function loadDisplays(conceptsDoc: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(conceptsDoc))) {
    const display = optionalString(asRecord(value).display);
    if (display) out[key] = display;
  }
  return out;
}

export function emptyMaps(): CodingMaps {
  return { opengalen: {}, snomed: {}, displays: {} };
}

export function formFromParsed(doc: unknown, file = ""): FormDoc {
  const raw = asRecord(doc);
  const items = (value: unknown): FormItem[] =>
    Array.isArray(value) ? value.map((row) => asRecord(row) as FormItem) : [];
  const links = (value: unknown): FormLink[] =>
    Array.isArray(value) ? value.map((row) => asRecord(row) as unknown as FormLink) : [];
  const exams = (value: unknown): FormExam[] =>
    Array.isArray(value) ? value.map((row) => asRecord(row) as unknown as FormExam) : [];
  return {
    topic: String(raw.topic ?? ""),
    display: String(raw.display ?? raw.topic ?? ""),
    category: String(raw.category ?? "unknown"),
    summaryType: optionalString(raw.summaryType),
    location: optionalString(raw.location) ?? null,
    firstLayer: items(raw.firstLayer),
    moreLayer: items(raw.moreLayer),
    associatedSymptomsAndSigns: links(raw.associatedSymptomsAndSigns),
    diagnoses: links(raw.diagnoses),
    otherLinks: links(raw.otherLinks),
    examinations: exams(raw.examinations),
    file,
  };
}

export async function loadForms(outDir: string): Promise<FormDoc[]> {
  const indexPath = join(outDir, "forms", "index.yaml");
  const index = asRecord(parse(await Deno.readTextFile(indexPath)));
  const forms: FormDoc[] = [];
  for (const [topic, value] of Object.entries(index)) {
    const row = asRecord(value);
    const file = optionalString(row.file);
    if (!file) continue;
    const path = join(outDir, file);
    const doc = formFromParsed(parse(await Deno.readTextFile(path)), file);
    if (!doc.topic) doc.topic = topic;
    if (!doc.display) doc.display = String(row.display ?? topic);
    if (!doc.category) doc.category = String(row.category ?? "unknown");
    forms.push(doc);
  }
  return forms;
}

function itemControl(code: string, display: string): Record<string, unknown> {
  return {
    url: ITEM_CONTROL,
    valueCodeableConcept: { coding: [{ system: ITEM_CONTROL_VS, code, display }] },
  };
}

function answerOption(key: string, maps: CodingMaps, unmapped: Unmapped[]): Record<string, unknown> {
  const coding = codingFor(key, maps);
  if (coding) return { valueCoding: coding };
  unmapped.push({ key, reason: "no verified OpenGALEN or SNOMED code; left as display text" });
  return { valueString: displayOf(key, maps) };
}

function enableWhenPresence(question: string, maps: CodingMaps): Record<string, unknown> {
  const coding = codingFor("presence", maps);
  if (coding) return { question, operator: "=", answerCoding: coding };
  return { question, operator: "=", answerString: displayOf("presence", maps) };
}

function choiceItem(
  linkId: string,
  text: string,
  keys: string[],
  maps: CodingMaps,
  unmapped: Unmapped[],
  opts: { repeats?: boolean; enableWhen?: Record<string, unknown>[] } = {},
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    linkId,
    text,
    type: "choice",
    repeats: !!opts.repeats,
    extension: [itemControl(opts.repeats ? "check-box" : "radio-button", opts.repeats ? "Check box" : "Radio Button")],
    answerOption: keys.map((key) => answerOption(key, maps, unmapped)),
  };
  if (opts.enableWhen?.length) {
    item.enableWhen = opts.enableWhen;
    item.enableBehavior = "any";
  }
  return item;
}

function quantityItem(
  linkId: string,
  text: string,
  unitKeys: string[],
  enableWhen?: Record<string, unknown>[],
): Record<string, unknown> {
  const keys = unitKeys.filter((key) => DURATION_UNITS[key]);
  const units = (keys.length ? keys : Object.keys(DURATION_UNITS)).map((key) => DURATION_UNITS[key]);
  const item: Record<string, unknown> = {
    linkId,
    text,
    type: "quantity",
    extension: units.map((u) => ({
      url: UNIT_OPTION,
      valueCoding: { system: UCUM, code: u.code, display: u.unit },
    })),
  };
  if (enableWhen?.length) {
    item.enableWhen = enableWhen;
    item.enableBehavior = "any";
  }
  return item;
}

function stringValues(row: FormItem): string[] {
  return (row.values ?? []).filter((v): v is string => typeof v === "string" && v.length > 0);
}

function featureItems(
  prefix: string,
  rows: FormItem[],
  maps: CodingMaps,
  unmapped: Unmapped[],
  enableWhen?: Record<string, unknown>[],
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const row of rows) {
    const name = row.feature ?? row.criterialLink;
    if (!name) continue;
    if (DURATION_FEATURES.has(name) || name.toLowerCase() === "duration") {
      items.push(quantityItem(`${prefix}.${name}`, displayOf(name, maps), stringValues(row), enableWhen));
      continue;
    }
    const values = stringValues(row);
    if (!values.length) continue;
    items.push(choiceItem(`${prefix}.${name}`, displayOf(name, maps), values, maps, unmapped, {
      repeats: !!row.multiple,
      enableWhen,
    }));
  }
  return items;
}

export function questionnaireUrl(topic: string): string {
  return `urn:clinergy-extractor:questionnaire:${topic}`;
}

export function buildQuestionnaire(form: FormDoc, maps: CodingMaps, unmapped: Unmapped[]): Record<string, unknown> {
  const prefix = form.topic;
  const summaryLinkId = `${prefix}.summary`;
  const moreWhen = form.summaryType ? [enableWhenPresence(summaryLinkId, maps)] : undefined;
  const items: Record<string, unknown>[] = [];
  if (form.summaryType) {
    items.push(choiceItem(summaryLinkId, displayOf(form.topic, maps), ["presence", "absence"], maps, unmapped));
  }
  items.push(...featureItems(prefix, form.firstLayer, maps, unmapped));
  items.push(...featureItems(prefix, form.moreLayer, maps, unmapped, moreWhen));

  if (form.associatedSymptomsAndSigns.length) {
    items.push({
      linkId: `${prefix}.associated`,
      text: "Associated symptoms and signs",
      type: "group",
      item: form.associatedSymptomsAndSigns.map((link) => {
        const key = link.preCoordinated || link.concept || link.item;
        return choiceItem(
          `${prefix}.associated.${key}`,
          displayOf(key, maps),
          ["presence", "absence"],
          maps,
          unmapped,
        );
      }),
    });
  }
  if (form.diagnoses.length) {
    items.push({
      linkId: `${prefix}.diagnosis`,
      text: "Diagnoses",
      type: "group",
      item: form.diagnoses.map((link) => {
        const key = link.preCoordinated || link.concept || link.item;
        return choiceItem(
          `${prefix}.diagnosis.${key}`,
          displayOf(key, maps),
          ["presence", "possible", "excluded"],
          maps,
          unmapped,
        );
      }),
    });
  }
  if (form.examinations.length) {
    items.push({
      linkId: `${prefix}.exam`,
      text: "Examinations",
      type: "group",
      item: form.examinations.map((exam) => ({
        linkId: `${prefix}.exam.${exam.exam}`,
        text: displayOf(exam.exam, maps),
        type: "group",
        item: (exam.signs ?? []).map((sign) =>
          choiceItem(
            `${prefix}.exam.${exam.exam}.${sign}`,
            displayOf(sign, maps),
            ["presence", "absence"],
            maps,
            unmapped,
          )
        ),
      })),
    });
  }

  return {
    resourceType: "Questionnaire",
    id: form.topic,
    meta: { profile: [SDC_QUESTIONNAIRE_PROFILE] },
    url: questionnaireUrl(form.topic),
    version: "0.1.0",
    name: form.topic,
    title: displayOf(form.topic, maps),
    status: "draft",
    experimental: true,
    subjectType: ["Patient"],
    description:
      `Generated from the Clinergy form YAML for ${form.topic} (${form.file}). See clinergy-extractor issues #7 and #8. ` +
      "Clinergy content is © 1997-8 Semantic Technologies Ltd / Victoria University of Manchester, All Rights Reserved.",
    item: items,
  };
}

function answerForKey(key: string, maps: CodingMaps): Record<string, unknown> {
  const coding = codingFor(key, maps);
  if (coding) return { valueCoding: coding };
  return { valueString: displayOf(key, maps) };
}

function choiceAnswer(
  linkId: string,
  keys: string | string[] | undefined,
  maps: CodingMaps,
): Record<string, unknown> | null {
  const list = (Array.isArray(keys) ? keys : keys ? [keys] : []).filter(Boolean);
  if (!list.length) return null;
  return { linkId, answer: list.map((key) => answerForKey(key, maps)) };
}

export function buildQuestionnaireResponse(
  form: FormDoc,
  finding: Finding,
  maps: CodingMaps,
  narrative?: string,
): Record<string, unknown> {
  const prefix = form.topic;
  const items: Record<string, unknown>[] = [];
  const summary = choiceAnswer(`${prefix}.summary`, finding.summary, maps);
  if (summary) items.push(summary);
  const laterality = choiceAnswer(`${prefix}.laterality`, finding.laterality, maps);
  if (laterality) items.push(laterality);
  const sub = choiceAnswer(`${prefix}.sublocation`, finding.subLocation, maps);
  if (sub) items.push(sub);
  for (const q of finding.qualifiers ?? []) {
    if (DURATION_FEATURES.has(q.descriptor) || q.descriptor === "Duration") {
      if (q.number == null) continue;
      const ucum = ucumOf(q.unit ?? q.value);
      items.push({
        linkId: `${prefix}.${q.descriptor}`,
        answer: [{
          valueQuantity: ucum
            ? { value: q.number, unit: ucum.unit, system: ucum.system, code: ucum.code }
            : { value: q.number, unit: q.unit ?? q.value },
        }],
      });
      continue;
    }
    const row = choiceAnswer(`${prefix}.${q.descriptor}`, q.value, maps);
    if (row) items.push(row);
  }
  const text = narrative?.trim()
    ? {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escapeXml(narrative.trim())}</p></div>`,
    }
    : undefined;
  return {
    resourceType: "QuestionnaireResponse",
    id: `${form.topic}-response`,
    meta: { profile: [SDC_RESPONSE_PROFILE] },
    questionnaire: questionnaireUrl(form.topic),
    status: "in-progress",
    ...(text ? { text } : {}),
    item: items,
  };
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

const QUALITY = new Set([
  "Character",
  "AbsolutePainDescriptor",
  "Consistency",
  "AbsoluteConsistency",
  "Texture",
  "AbsoluteTexture",
]);
const SEVERITY = new Set(["Severity", "AbsoluteSeverity"]);
const FREQUENCY = new Set(["Frequency", "AbsoluteFrequency"]);
const ONSET = new Set(["Onset", "AbsoluteOnset"]);
const TREND = new Set(["Progress", "AbsoluteProgress"]);
const COURSE = new Set(["Pattern", "AbsoluteProcessPattern", "ProcessPattern"]);
const DURATION_DESC = new Set(["Duration", "QuantityDuration"]);

function qualifier(finding: Finding, names: Set<string>): Qualifier | undefined {
  return (finding.qualifiers ?? []).find((q) => names.has(q.descriptor));
}

export function buildSymptom(
  finding: Finding,
  maps: CodingMaps,
  narrative: string,
  gaps: SymptomGap[],
): Record<string, unknown> {
  const topicCoding = codingFor(finding.topic, maps);
  if (!topicCoding) {
    gaps.push({
      path: "symptomCode",
      clinergy: finding.topic,
      reason: `No verified OpenGALEN or SNOMED code for ${finding.topic}; the code is the Clinergy key.`,
    });
  }
  const keyFeatures: Record<string, unknown> = {};
  if (finding.location || finding.laterality || finding.subLocation) {
    const siteKey = finding.location ?? finding.subLocation!;
    const siteCoding = codingFor(siteKey, maps);
    if (finding.location && !siteCoding) {
      gaps.push({
        path: "keyFeatures.location.code",
        clinergy: finding.location,
        reason: `No verified code for location ${finding.location}; the code is the Clinergy key.`,
      });
    }
    const qualifiers: string[] = [];
    if (finding.laterality) qualifiers.push(finding.laterality);
    if (finding.subLocation) qualifiers.push(displayOf(finding.subLocation, maps));
    keyFeatures.location = [{
      code: siteCoding?.code ?? siteKey,
      ...(qualifiers.length ? { qualifier: qualifiers } : {}),
    }];
  }
  const quality: Record<string, unknown>[] = [];
  for (const q of finding.qualifiers ?? []) {
    if (!QUALITY.has(q.descriptor)) continue;
    const coding = codingFor(q.value, maps);
    if (!coding) {
      gaps.push({
        path: "keyFeatures.quality.value",
        clinergy: q.value,
        reason: `No verified code for ${q.descriptor} value ${q.value}; the code is the Clinergy key.`,
      });
    }
    quality.push({
      value: coding?.code ?? q.value,
      note: { text: `${displayOf(q.descriptor, maps)}: ${displayOf(q.value, maps)}` },
    });
  }
  if (quality.length) keyFeatures.quality = quality;

  const sev = qualifier(finding, SEVERITY);
  if (sev) {
    const coding = codingFor(sev.value, maps);
    if (!coding) {
      gaps.push({
        path: "keyFeatures.severity.value",
        clinergy: sev.value,
        reason: `No verified code for severity ${sev.value}; the code is the Clinergy key.`,
      });
    }
    keyFeatures.severity = { value: coding?.code ?? sev.value, note: { text: displayOf(sev.value, maps) } };
  }
  const freq = qualifier(finding, FREQUENCY);
  if (freq) {
    keyFeatures.frequency = { quality: displayOf(freq.value, maps) };
    gaps.push({
      path: "keyFeatures.frequency.quantity",
      clinergy: freq.value,
      reason: "Frequency on the form is qualitative only. No numeric rate is available for frequency.quantity.",
    });
  }

  const model: Record<string, unknown> = {
    resourceType: "SymptomLogicalModel",
    meta: { profile: [SYMPTOM_PROFILE] },
    identifier: finding.topic,
    symptomCode: topicCoding?.code ?? finding.topic,
    presentFlag: finding.summary !== "absence",
    keyFeatures,
  };
  if (narrative.trim()) model.symptomDescription = [{ text: narrative.trim() }];

  const onset = qualifier(finding, ONSET);
  const duration = qualifier(finding, DURATION_DESC);
  if (onset || (duration && duration.number != null)) {
    const timing: Record<string, unknown> = {};
    if (onset) {
      const coding = codingFor(onset.value, maps);
      if (!coding) {
        gaps.push({
          path: "timing.speedOfOnset",
          clinergy: onset.value,
          reason: `No verified code for onset ${onset.value}; the code is the Clinergy key.`,
        });
      }
      timing.speedOfOnset = coding?.code ?? onset.value;
    }
    if (duration && duration.number != null) {
      const ucum = ucumOf(duration.unit ?? duration.value);
      timing.duration = ucum
        ? { value: duration.number, unit: ucum.unit, system: ucum.system, code: ucum.code }
        : { value: duration.number, unit: duration.unit ?? duration.value };
      timing.note = { text: `Episode duration ${isoDuration(duration.number, duration.unit ?? duration.value)}` };
    }
    model.timing = timing;
    gaps.push({
      path: "timing.onset[x]",
      reason:
        "The form records qualitative onset as timing.speedOfOnset. It has no calendar date or period for first occurrence.",
    });
  }
  const trend = qualifier(finding, TREND);
  if (trend) model.trend = codingFor(trend.value, maps)?.code ?? trend.value;
  const course = qualifier(finding, COURSE);
  if (course) model.clinicalCourse = codingFor(course.value, maps)?.code ?? course.value;

  gaps.push({
    path: "reporter[x]",
    reason:
      "The extractor has no reporter on a finding. The Symptom Logical Model only allows Patient or RelatedPerson, so reporter is left unset rather than inventing a subject.",
  });

  const known = new Set([...QUALITY, ...SEVERITY, ...FREQUENCY, ...ONSET, ...TREND, ...COURSE, ...DURATION_DESC]);
  for (const q of finding.qualifiers ?? []) {
    if (known.has(q.descriptor)) continue;
    gaps.push({
      path: "unmappedDescriptor",
      clinergy: q.descriptor,
      reason: `Descriptor ${q.descriptor}=${q.value} has no Symptom Logical Model element in this mapping.`,
    });
  }
  return model;
}

function isRecord(value: unknown): value is Yaml {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueUnmapped(rows: Unmapped[]): Unmapped[] {
  const seen = new Set<string>();
  const out: Unmapped[] = [];
  for (const row of rows) {
    const key = `${row.key}|${row.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export interface WriteFhirOptions {
  outDir: string;
  destDir?: string;
  findingsPath?: string;
  opengalenPath?: string;
  snomedPath?: string;
}

async function readYamlIfPresent(path: string | undefined): Promise<unknown | null> {
  if (!path) return null;
  try {
    return parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export async function writeFhirTree(options: WriteFhirOptions): Promise<FhirWriteResult> {
  const destDir = options.destDir ?? join(options.outDir, "fhir");
  const maps: CodingMaps = emptyMaps();
  const ogDoc = await readYamlIfPresent(
    options.opengalenPath ?? join(dirname(options.outDir), "map", "mappings.yaml"),
  );
  if (ogDoc) maps.opengalen = loadOpenGalenCoding(ogDoc);
  const snomedDoc = await readYamlIfPresent(
    options.snomedPath ?? new URL("../mappings/snomed.yaml", import.meta.url).pathname,
  );
  if (snomedDoc) maps.snomed = loadSnomedCoding(snomedDoc);
  try {
    maps.displays = loadDisplays(parse(await Deno.readTextFile(join(options.outDir, "concepts.yaml"))));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const failures: { file: string; error: string }[] = [];
  const unmapped: Unmapped[] = [];
  const gaps: SymptomGap[] = [];
  const forms = await loadForms(options.outDir);
  await Deno.mkdir(destDir, { recursive: true });

  let questionnaires = 0;
  for (const form of forms) {
    const rel = join(form.category, `${form.topic}.questionnaire.json`);
    try {
      const q = buildQuestionnaire(form, maps, unmapped);
      await Deno.mkdir(join(destDir, form.category), { recursive: true });
      await Deno.writeTextFile(join(destDir, rel), JSON.stringify(q, null, 2) + "\n");
      questionnaires++;
    } catch (error) {
      failures.push({ file: form.file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  let responses = 0;
  let symptoms = 0;
  if (options.findingsPath) {
    let knowledge: SentenceKnowledge | null = null;
    try {
      knowledge = await loadSentenceKnowledge(options.outDir);
    } catch {
      knowledge = null;
    }
    const findings = findingsFromParsed(parse(await Deno.readTextFile(options.findingsPath)));
    const byTopic = new Map(forms.map((form) => [form.topic, form]));
    const symptomList: Record<string, unknown>[] = [];
    for (const [i, finding] of findings.entries()) {
      const form = byTopic.get(finding.topic);
      const narrative = knowledge ? render(finding, knowledge) : "";
      if (form) {
        const rel = join(form.category, `${form.topic}.${i + 1}.response.json`);
        try {
          const response = buildQuestionnaireResponse(form, finding, maps, narrative);
          await Deno.writeTextFile(join(destDir, rel), JSON.stringify(response, null, 2) + "\n");
          responses++;
        } catch (error) {
          failures.push({
            file: `${finding.topic}#${i + 1}`,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        failures.push({ file: finding.topic, error: "no form YAML for this topic in the extract" });
      }
      const model = buildSymptom(finding, maps, narrative, gaps);
      symptomList.push(model);
      symptoms++;
    }
    await Deno.writeTextFile(
      join(destDir, "symptoms.json"),
      JSON.stringify(
        {
          profile: SYMPTOM_PROFILE,
          documentation:
            "https://build.fhir.org/ig/HL7/fhir-symptoms-ig/en/StructureDefinition-SymptomLogicalModel.html",
          symptoms: symptomList,
          gaps,
        },
        null,
        2,
      ) + "\n",
    );
  }

  const summary: FhirWriteResult = {
    questionnaires,
    responses,
    symptoms,
    failures,
    unmapped: uniqueUnmapped(unmapped),
    gaps,
    destDir,
  };
  await Deno.writeTextFile(join(destDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}
