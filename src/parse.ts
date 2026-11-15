/**
 * Parsers for the text dumps written by probe.exe (see probe/probe.c) and for
 * the Clinergy Compdata *.ini files. Every parser takes the file text and
 * returns plain JavaScript objects; nothing here touches the file system,
 * so the parsers can be unit-tested with small synthetic strings.
 *
 * Dump line formats (one statement per line, ending in "."):
 *   vis.txt.vf  <Concept> VisualF add <Attribute> { v1 } { v2 } ... <flag>.
 *               flag 0 = shown on the form's first layer, 1 = behind ">>" (more)
 *   vis.txt.vc  <Concept> VisCritLinkSummary add <Link> { att value } ... <flag>.
 *   vis.txt.vl  <Location> VisualLat add <Selector> { leftSelection } { rightSelection } .
 *   vis.txt.vs  <Location> VisualSubLoc add <Selector|NULL> { Sub1 } { Sub2 } .
 *   lang.txt    <Descriptor> descPrecedence <n>.
 *               <Descriptor> MakeLanguageRule <value> <valueForm> <descriptorForm> <order> <position>.
 *   values.txt  <Value> valuePrecedence <n> .
 *   permids.txt <n> Entity <Name>.
 *   search.txt  blocks of "<typed prefix>" followed by TAB-indented concept names
 *   entities.tsv / exams.tsv: TAB-separated "key=value" fields, and list fields
 *               written as "key[n]=a|b|c" (see probe.c).
 */

/** Values inside "{ ... }" groups, in order. */
export function braces(s: string): string[] {
  return [...s.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].trim());
}

/** Split into lines, tolerating CRLF. */
const lines = (text: string) => text.split(/\r?\n/);

export type Layer = "first" | "more";

export interface FeatureVisibility {
  feature: string;
  values: string[];
  layer: Layer;
}
export interface CritLinkVisibility {
  criterialLink: string;
  values: { attribute: string; value: string }[];
  layer: Layer;
}
export interface SelectorVisibility {
  selector: string;
  values: string[];
}

/** vis.txt.vf: concept -> ordered visible feature rows. */
export function parseFeatureVisibility(text: string): Map<string, FeatureVisibility[]> {
  const out = new Map<string, FeatureVisibility[]>();
  for (const line of lines(text)) {
    const m = line.match(/^(\S+) VisualF add (\S+) (.*?)\s+(\d)\.\s*$/);
    if (!m) continue;
    const [, concept, feature, vals, flag] = m;
    push(out, concept, { feature, values: braces(vals), layer: flag === "0" ? "first" : "more" });
  }
  return out;
}

/** vis.txt.vc: concept -> criterial-link summaries shown on its form. */
export function parseCritLinkVisibility(text: string): Map<string, CritLinkVisibility[]> {
  const out = new Map<string, CritLinkVisibility[]>();
  for (const line of lines(text)) {
    const m = line.match(/^(\S+) VisCritLinkSummary add (\S+) (.*?)\s*(\d)\.\s*$/);
    if (!m) continue;
    const [, concept, link, vals, flag] = m;
    push(out, concept, {
      criterialLink: link,
      values: braces(vals).map((v) => {
        const [attribute, value] = v.split(/\s+/);
        return { attribute, value };
      }),
      layer: flag === "0" ? "first" : "more",
    });
  }
  return out;
}

/** vis.txt.vl (kind "VisualLat") and vis.txt.vs (kind "VisualSubLoc"): location -> choices. */
export function parseSelectorVisibility(text: string, kind: string): Map<string, SelectorVisibility> {
  const out = new Map<string, SelectorVisibility>();
  const re = new RegExp(`^(\\S+) ${kind} add (\\S+) (.*)\\.\\s*$`);
  for (const line of lines(text)) {
    const m = line.match(re);
    if (m) out.set(m[1], { selector: m[2], values: braces(m[3]) });
  }
  return out;
}

export interface LanguageRule {
  valueForm: string;
  descriptorForm: string;
  order: string;
  position: string;
}
export interface Descriptor {
  precedence: number | null;
  rules: Map<string, LanguageRule>;
}

/** lang.txt: descriptor (feature attribute) -> sentence precedence and per-value rules. */
export function parseLanguage(text: string): Map<string, Descriptor> {
  const out = new Map<string, Descriptor>();
  const get = (d: string) => {
    let x = out.get(d);
    if (!x) out.set(d, x = { precedence: null, rules: new Map() });
    return x;
  };
  for (const line of lines(text)) {
    const p = line.trim().replace(/\.$/, "").split(/\s+/);
    if (p.length >= 3 && p[1] === "descPrecedence") get(p[0]).precedence = Number(p[2]);
    else if (p.length >= 7 && p[1] === "MakeLanguageRule") {
      get(p[0]).rules.set(p[2], { valueForm: p[3], descriptorForm: p[4], order: p[5], position: p[6] });
    }
  }
  return out;
}

/** values.txt: value -> precedence (ordering of values inside a sentence). */
export function parseValuePrecedence(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines(text)) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 3 && p[1] === "valuePrecedence") out.set(p[0], Number(p[2]));
  }
  return out;
}

/** permids.txt: entity name -> permanent id. */
export function parsePermanentIds(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines(text)) {
    const m = line.match(/^(\d+) Entity (\S+)\./);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

/** search.txt: typed prefix -> concepts offered by the type-ahead search. */
export function parseSearchSpace(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let key: string | null = null;
  for (const line of lines(text)) {
    if (!line.trim()) {
      key = null;
      continue;
    }
    if (line.startsWith("\t")) { if (key !== null) push(out, key, line.trim()); }
    else {
      key = line.trim();
      if (!out.has(key)) out.set(key, []);
    }
  }
  return out;
}

/** One TAB-separated "key=value" / "key[n]=a|b" record. */
export interface Record_ {
  fields: Record<string, string>;
  lists: Record<string, string[]>;
}
export function parseFields(cols: string[]): Record_ {
  const r: Record_ = { fields: {}, lists: {} };
  for (const c of cols) {
    const i = c.indexOf("=");
    const k = i < 0 ? c : c.slice(0, i), v = i < 0 ? "" : c.slice(i + 1);
    const m = k.match(/^(\w+)\[(\d+)\]$/);
    if (m) r.lists[m[1]] = v.split("|");
    else r.fields[k] = v;
  }
  return r;
}

export interface Entity {
  id: number;
  name: string;
  /** e.g. "Complete symptom", "Incomplete disease", "" */
  category: string;
  summaryType: string;
  relevance: number;
  /** display string, e.g. "elbow ache" */
  display: string;
  showSubLocations: boolean;
  leftHanded: boolean;
  /** list-valued query results keyed by probe tag (supers, formLinkTopics, exams, ...) */
  links: Record<string, string[]>;
}

/** entities.tsv -> entities keyed by name, in id order. */
export function parseEntities(text: string): Map<string, Entity> {
  const out = new Map<string, Entity>();
  for (const line of lines(text)) {
    const cols = line.split("\t");
    if (cols.length < 2 || !/^\d+$/.test(cols[0])) continue;
    const { fields, lists } = parseFields(cols.slice(2));
    out.set(cols[1], {
      id: Number(cols[0]),
      name: cols[1],
      category: fields.cat ?? "",
      summaryType: fields.sum ?? "",
      relevance: Number(fields.rel ?? 0),
      display: fields.topic ?? "",
      showSubLocations: fields.showSubLoc === "1",
      leftHanded: fields.leftHanded === "1",
      links: lists,
    });
  }
  return out;
}

export type ExamGroup = "root" | "system" | "location" | "sub";
export interface Exam {
  name: string;
  group: ExamGroup;
  lateral: boolean;
  super: string;
  level: number;
  baseSign: string;
  baseLocation: string;
  /** signs offered by the exam; signs0/signs1 are the engine's two sign modes */
  signs0: string[];
  signs1: string[];
  subExams: string[];
  symptomLinks: string[];
}

/** exams.tsv -> exams keyed by name, plus global lists and the model version. */
export function parseExams(
  text: string,
): { exams: Map<string, Exam>; lists: Map<string, string[]>; modelVersion: string } {
  const exams = new Map<string, Exam>();
  const lists = new Map<string, string[]>();
  let modelVersion = "";
  const groups: Record<string, ExamGroup> = { g0: "root", g1: "system", g2: "location", g3: "sub" };
  for (const line of lines(text)) {
    if (line.startsWith("#list ")) {
      const m = line.match(/^#list (\w+)\[(\d+)\]=?(.*)$/);
      if (m) lists.set(m[1], m[3] ? m[3].split("|") : []);
      continue;
    }
    if (line.startsWith("#version ")) {
      modelVersion = line.slice(9).trim();
      continue;
    }
    if (line.startsWith("#") || !line.trim()) continue;
    const cols = line.split("\t");
    const { fields, lists: l } = parseFields(cols.slice(2));
    const [baseSign, baseLocation = ""] = (fields.base ?? "").split("|");
    if (exams.has(cols[1])) continue; // first occurrence wins
    exams.set(cols[1], {
      name: cols[1],
      group: groups[cols[0]] ?? "sub",
      lateral: fields.lateral === "1",
      super: fields.super ?? "",
      level: Number(fields.level ?? 0),
      baseSign,
      baseLocation,
      signs0: l.signs0 ?? [],
      signs1: l.signs1 ?? [],
      subExams: l.subexams ?? [],
      symptomLinks: l.symptomLinks ?? [],
    });
  }
  return { exams, lists, modelVersion };
}

// ---- Compdata INI files ------------------------------------------------------

export interface SelectorOption {
  n: string;
  sex: string;
  label: string;
  system: string;
  bitmaps: string[];
  anatomyMap: string | null;
}
export interface Selector {
  options: SelectorOption[];
  settings: Record<string, string[]>;
}
export interface Hotspot {
  label: string | null;
  concept: string;
  hotspot: number[];
}
export interface MapLocation extends Hotspot {
  inset: string | null;
  insetRect: number[] | null;
  root: boolean;
  sublocations: Hotspot[];
}
export interface BodyMapFile {
  selectors: Selector[];
  maps: Map<string, MapLocation[]>;
  /** per map: the MAINGRAPHIC line, i.e. the picture the map's location hotspots are drawn on */
  mainGraphics: Map<string, MapLocation>;
}

/**
 * Selector.ini / Onelist.ini / Demosel.ini / Vga.ini / Manmap.ini / Womanmap.ini.
 * "[BEGIN SELECTOR]" blocks hold window settings and OptionButton lines (one
 * per body-system filter). "[BEGIN <Name>Anatomy]" blocks (and the top level
 * of Manmap/Womanmap) hold body-map click areas: a BEGIN/LOCATION line is
 *   [label,]Concept,x1,x2,y1,y2[,inset.bmp,ix1,iy1,ix2,iy2]
 * and following SUBLOCATION lines are click areas on that location's inset.
 * A MAINGRAPHIC line (same layout) names the map's base picture.
 * Hotspot numbers are kept exactly as written. Checked against the pictures,
 * they are [top, bottom, left, right] in pixels of the picture being clicked:
 * locations on the map's main graphic, sublocations on the location's inset.
 * The inset rectangle is [left, top, width, height] in the graphic window.
 */
export function parseBodyMapIni(text: string): BodyMapFile {
  const res: BodyMapFile = { selectors: [], maps: new Map(), mainGraphics: new Map() };
  let mapName = "_toplevel";
  type Cur = { kind: "selector"; sel: Selector } | { kind: "map"; locs: MapLocation[] } | null;
  const top: MapLocation[] = [];
  res.maps.set("_toplevel", top);
  let cur: Cur = { kind: "map", locs: top };
  let mode: string | null = null;
  let loc: MapLocation | null = null;
  const isInt = (x: string) => /^-?\d+$/.test(x);
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const b = line.match(/^\[BEGIN (\w+)\]$/);
    if (b) {
      if (b[1] === "SELECTOR") {
        const sel: Selector = { options: [], settings: {} };
        res.selectors.push(sel);
        cur = { kind: "selector", sel };
      } else {
        const locs: MapLocation[] = [];
        res.maps.set(b[1], locs);
        mapName = b[1];
        cur = { kind: "map", locs };
      }
      mode = null;
      continue;
    }
    if (line.startsWith("[END")) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line === "BEGIN" || line === "LOCATION" || line === "SUBLOCATION" || line === "MAINGRAPHIC") {
      mode = line;
      continue;
    }
    const f = line.split(",").map((x) => x.trim());
    if (cur.kind === "selector") {
      if (f[0] === "OptionButton") {
        cur.sel.options.push({
          n: f[1],
          sex: f[2],
          label: f[3],
          system: f[4],
          bitmaps: f.slice(5, 7),
          anatomyMap: f[7] ?? null,
        });
      } else cur.sel.settings[f[0]] = f.slice(1);
      continue;
    }
    if (f.length < 5) continue;
    const [label, g] = isInt(f[1]) ? [null, f] : [f[0], f.slice(1)];
    if (mode === "MAINGRAPHIC") {
      res.mainGraphics.set(mapName, {
        label,
        concept: g[0],
        hotspot: g.slice(1, 5).map(Number),
        inset: g[5] ?? null,
        insetRect: g.length > 9 ? g.slice(6, 10).map(Number) : null,
        root: false,
        sublocations: [],
      });
    } else if (mode === "BEGIN" || mode === "LOCATION") {
      loc = {
        label,
        concept: g[0],
        hotspot: g.slice(1, 5).map(Number),
        inset: g[5] ?? null,
        insetRect: g.length > 9 ? g.slice(6, 10).map(Number) : null,
        root: mode === "BEGIN",
        sublocations: [],
      };
      cur.locs.push(loc);
    } else if (mode === "SUBLOCATION" && loc) {
      loc.sublocations.push({ label, concept: g[0], hotspot: g.slice(1, 5).map(Number) });
    }
  }
  return res;
}

export interface TopicListRow {
  label: string;
  topicPermId: number;
  locationPermId: number;
}
/** Comtopic.ini, Symptoms.ini, ...: "label,topicPermId,locationPermId" quick-pick lists. */
export function parseTopicList(text: string): TopicListRow[] {
  const rows: TopicListRow[] = [];
  for (const line of lines(text)) {
    const f = line.trim().split(",");
    if (f.length === 3 && /^\d+$/.test(f[1])) {
      rows.push({ label: f[0], topicPermId: Number(f[1]), locationPermId: Number(f[2]) });
    }
  }
  return rows;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}
