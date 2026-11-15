/**
 * Match Clinergy names to OpenGALEN 8 names.
 *
 * The 1998 Clinergy model is an adaptation of a GALEN Common Reference Model,
 * so many names are shared, but many are not (Clinergy uses e.g.
 * "AbsoluteSeverity" where OpenGALEN uses hasSeverity + Severity). We never
 * invent a mapping. Each Clinergy name gets exactly one status:
 *
 *   exact       identical name exists in OpenGALEN 8 (only this tier is a mapping)
 *   normalised  equal after normalisation: case, punctuation, a "NAMED" prefix,
 *               British/American and simple spelling variants -> needs review
 *   candidate   no equal name; up to N scored suggestions from token overlap -> needs review
 *   unmapped    nothing scored above the threshold
 */
import type { OgKind, OgNames } from "./opengalen.ts";

/** Split CamelCase / digits / punctuation into lower-case tokens. */
export function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Spelling normalisation of one lower-case token. Deliberately small and
 * documented; every rule only produces "normalised"/"candidate" results that
 * a human reviews.
 */
export function spell(t: string): string {
  return t
    .replace(/ae/g, "e") // haemorrhage / hemorrhage
    .replace(/oe(?=[a-z])/g, "e") // oedema / edema, oesophagus / esophagus
    .replace(/isation/g, "ization")
    .replace(/yse$/, "yze")
    .replace(/our$/, "or") // tumour / tumor
    .replace(/tre$/, "ter") // centre / center
    .replace(/ant$/, "ent") // intermittant / intermittent, persistant / persistent
    .replace(/ies$/, "y")
    .replace(/([^s])s$/, "$1"); // simple plural
}

/** Normalised key: tokens without a leading "named", spelling-normalised, joined. */
export function normKey(name: string): string {
  const t = tokens(name);
  if (t[0] === "named" && t.length > 1) t.shift();
  return t.map(spell).join("");
}

/** Words that carry little meaning for matching. */
const STOP = new Set([
  "of",
  "in",
  "on",
  "the",
  "a",
  "an",
  "which",
  "has",
  "is",
  "with",
  "by",
  "to",
  "from",
  "and",
  "for",
  "at",
]);
/** Clinergy affixes that OpenGALEN often expresses differently: counted, but with low weight. */
const WEAK = new Set(["symptom", "sign", "diagnosis", "absolute", "quantity", "named", "finding", "complaint", "exam"]);
const weight = (t: string) => (STOP.has(t) ? 0 : WEAK.has(t) ? 0.25 : 1);

export interface Candidate {
  name: string;
  kind: OgKind;
  score: number;
  reason: string;
}
export type Status = "exact" | "normalised" | "candidate" | "unmapped";
export interface MappingResult {
  clinergy: string;
  status: Status;
  needsReview: boolean;
  /** only set for status "exact" */
  opengalen: string | null;
  opengalenKind: OgKind | null;
  candidates: Candidate[];
}

export interface MatcherOptions {
  /** maximum candidates to report (default 5) */
  maxCandidates?: number;
  /** minimum weighted Dice score for a candidate (default 0.5) */
  minScore?: number;
  /** skip index tokens shared by more names than this when looking up candidates (default 4000) */
  maxPosting?: number;
}

/** Index over the OpenGALEN names; build once, then call match() per Clinergy name. */
export class Matcher {
  #names: OgNames;
  #byKey = new Map<string, string[]>();
  #byToken = new Map<string, string[]>();
  #tokenSets = new Map<string, Map<string, number>>();
  #opt: Required<MatcherOptions>;

  constructor(names: OgNames, opt: MatcherOptions = {}) {
    this.#names = names;
    // undefined options fall back to the defaults
    const given = Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined));
    this.#opt = { maxCandidates: 5, minScore: 0.5, maxPosting: 4000, ...given };
    for (const n of names.keys()) {
      push(this.#byKey, normKey(n), n);
      for (const t of this.#weighted(n).keys()) push(this.#byToken, t, n);
    }
  }

  /** Token -> weight for a name (spelling-normalised, stop words dropped). */
  #weighted(n: string): Map<string, number> {
    let m = this.#tokenSets.get(n);
    if (m) return m;
    m = new Map();
    for (const raw of tokens(n)) {
      const t = spell(raw), w = weight(raw);
      if (w > 0) m.set(t, Math.max(m.get(t) ?? 0, w));
    }
    this.#tokenSets.set(n, m);
    return m;
  }

  /** Weighted Dice coefficient of two token sets (1 = same tokens). */
  #score(a: Map<string, number>, b: Map<string, number>): number {
    let common = 0, sa = 0, sb = 0;
    for (const [t, w] of a) {
      sa += w;
      if (b.has(t)) common += Math.min(w, b.get(t)!);
    }
    for (const w of b.values()) sb += w;
    return sa + sb ? (2 * common) / (sa + sb) : 0;
  }

  match(name: string): MappingResult {
    const res = (status: Status, candidates: Candidate[], og: string | null = null): MappingResult => ({
      clinergy: name,
      status,
      needsReview: status !== "exact",
      opengalen: og,
      opengalenKind: og ? this.#names.get(og)! : null,
      candidates,
    });
    if (this.#names.has(name)) return res("exact", [], name);

    const same = (this.#byKey.get(normKey(name)) ?? []).filter((n) => n !== name);
    if (same.length) {
      return res(
        "normalised",
        same.slice(0, this.#opt.maxCandidates).map((n) => ({
          name: n,
          kind: this.#names.get(n)!,
          score: 1,
          reason: "equal after normalisation (case, punctuation, NAMED prefix, spelling)",
        })),
      );
    }

    const mine = this.#weighted(name);
    const pool = new Set<string>();
    const toks = [...mine.keys()].sort((x, y) =>
      (this.#byToken.get(x)?.length ?? 0) - (this.#byToken.get(y)?.length ?? 0)
    );
    for (const [i, t] of toks.entries()) {
      const post = this.#byToken.get(t) ?? [];
      if (post.length > this.#opt.maxPosting && i > 0) continue; // very common token, and we already have rarer ones
      for (const n of post.slice(0, this.#opt.maxPosting * 4)) pool.add(n);
    }
    const scored: Candidate[] = [];
    for (const n of pool) {
      const s = this.#score(mine, this.#weighted(n));
      if (s >= this.#opt.minScore) {
        const shared = [...mine.keys()].filter((t) => this.#weighted(n).has(t));
        scored.push({
          name: n,
          kind: this.#names.get(n)!,
          score: Math.round(s * 1000) / 1000,
          reason: `shared tokens: ${shared.join(", ")}`,
        });
      }
    }
    // best score first; shorter names first on ties (generated OpenGALEN names can be very long)
    scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
    const top = scored.slice(0, this.#opt.maxCandidates);
    return top.length ? res("candidate", top) : res("unmapped", []);
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}
