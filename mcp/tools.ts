/**
 * Read-only query functions over an OpenGALEN index (src/opengalen.ts), used
 * as MCP tools by mcp/opengalen-mcp.ts. Everything returned comes from the
 * loaded release; nothing is inferred beyond the published hierarchy.
 */
import { isGenerated, OG_NAMESPACE, type OgIndex, type OgKind } from "../src/opengalen.ts";
import { spell, tokens } from "../src/mapping.ts";

const BROWSER = "https://pen-pad-revival.github.io/opengalen-browser/#concept=";
const CHILD_CAP = 200;

/** Lazily built token index over names and labels. */
const tokenIndexes = new WeakMap<OgIndex, Map<string, string[]>>();
function tokenIndex(ix: OgIndex): Map<string, string[]> {
  let t = tokenIndexes.get(ix);
  if (t) return t;
  t = new Map();
  const add = (tok: string, n: string) => {
    const l = t!.get(tok);
    if (!l) t!.set(tok, [n]);
    else if (l[l.length - 1] !== n) l.push(n);
  };
  // "PainwhichhasLocationElbow" -> pain which has location elbow
  const words = (n: string) => tokens(n.replace(/which/g, " which "));
  for (const n of ix.kinds.keys()) for (const tok of new Set(words(n).map(spell))) add(tok, n);
  for (const [n, ann] of ix.annotations) {
    for (const vals of ann.values()) for (const v of vals) for (const tok of tokens(v).map(spell)) add(tok, n);
  }
  tokenIndexes.set(ix, t);
  return t;
}

export interface SearchHit {
  name: string;
  kind: OgKind;
  generated: boolean;
  parents: string[];
  labels: string[];
}

/**
 * Find entities whose name or label contains all query words (CamelCase and
 * spelling-normalised, e.g. "oedema" finds "Edema*" and vice versa).
 * Ranking: exact name, then fewest extra words, named before generated, shorter first.
 */
export function searchConcepts(
  ix: OgIndex,
  a: { query: string; limit?: number; kind?: OgKind; includeGenerated?: boolean },
): { total: number; hits: SearchHit[] } {
  const limit = Math.min(Math.max(a.limit ?? 20, 1), 100);
  const q = [...new Set(tokens(a.query).map(spell))];
  if (!q.length) return { total: 0, hits: [] };
  const t = tokenIndex(ix);
  const lists = q.map((x) => t.get(x) ?? []).sort((x, y) => x.length - y.length);
  let pool = new Set(lists[0]);
  for (const l of lists.slice(1)) {
    const s = new Set(l);
    pool = new Set([...pool].filter((n) => s.has(n)));
  }
  const exactLower = a.query.replace(/\s+/g, "").toLowerCase();
  let hits = [...pool].filter((n) =>
    (!a.kind || ix.kinds.get(n) === a.kind) && (a.includeGenerated || !isGenerated(n) || n.toLowerCase() === exactLower)
  );
  const rank = (n: string) => [
    n.toLowerCase() === exactLower ? 0 : 1,
    tokens(n.replace(/which/g, " which ")).length - q.length,
    isGenerated(n) ? 1 : 0,
    n.length,
  ];
  hits.sort((x, y) => {
    const rx = rank(x), ry = rank(y);
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
    return x < y ? -1 : 1;
  });
  const total = hits.length;
  hits = hits.slice(0, limit);
  return {
    total,
    hits: hits.map((n) => ({
      name: n,
      kind: ix.kinds.get(n)!,
      generated: isGenerated(n),
      parents: [...(ix.parents.get(n) ?? [])],
      labels: ix.annotations.get(n)?.get("label") ?? [],
    })),
  };
}

/** Everything the index knows about one entity, or exists: false. */
export function getConcept(ix: OgIndex, a: { name: string }) {
  const n = a.name;
  if (!ix.has(n)) {
    const lower = n.toLowerCase();
    const sameCase = [...ix.kinds.keys()].filter((x) => x.toLowerCase() === lower).slice(0, 5);
    return { name: n, exists: false, caseInsensitiveMatches: sameCase };
  }
  const children = [...(ix.children.get(n) ?? [])];
  const named = children.filter((c) => !isGenerated(c));
  return {
    name: n,
    exists: true,
    kind: ix.kinds.get(n),
    iri: OG_NAMESPACE + n,
    browserUrl: ix.kinds.get(n) === "Class" ? BROWSER + encodeURIComponent(n) : null,
    generated: isGenerated(n),
    parents: [...(ix.parents.get(n) ?? [])],
    equivalents: [...(ix.equivalents.get(n) ?? [])],
    childCount: children.length,
    namedChildren: named.slice(0, CHILD_CAP),
    generatedChildCount: children.length - named.length,
    definition: ix.axioms.get(n) ?? (isGenerated(n) ? ["(generated class: its name spells out its definition)"] : []),
    sanctions: Object.fromEntries(ix.sanctions.get(n) ?? []),
    annotations: Object.fromEntries(ix.annotations.get(n) ?? []),
  };
}

/** All ancestors, breadth-first, with their distance (1 = direct parent). */
export function getAncestors(ix: OgIndex, a: { name: string; maxDepth?: number }) {
  if (!ix.has(a.name)) return { name: a.name, exists: false, ancestors: [] };
  const maxDepth = a.maxDepth ?? 50;
  const seen = new Map<string, number>([[a.name, 0]]);
  let frontier = [a.name];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const p of ix.parents.get(n) ?? []) {
        if (!seen.has(p)) {
          seen.set(p, d);
          next.push(p);
        }
      }
    }
    frontier = next;
  }
  seen.delete(a.name);
  return { name: a.name, exists: true, ancestors: [...seen].map(([name, depth]) => ({ name, depth })) };
}

/** Verify a batch of names: which exist exactly (case-sensitive). */
export function checkNames(ix: OgIndex, a: { names: string[] }) {
  return {
    results: a.names.slice(0, 500).map((n) => ({ name: n, exists: ix.has(n), kind: ix.kinds.get(n) ?? null })),
  };
}

/** MCP tool descriptors (JSON Schema inputs). */
export const TOOLS = [
  {
    name: "search_concepts",
    description:
      "Search OpenGALEN 8 entity names and labels. All query words must occur (CamelCase split, British/American spelling folded). Generated '...which...' classes are excluded unless includeGenerated is true.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "words or a CamelCase name, e.g. 'severity' or 'ElbowPain'" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        kind: { type: "string", enum: ["Class", "ObjectProperty", "DataProperty", "NamedIndividual"] },
        includeGenerated: { type: "boolean", default: false },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_concept",
    description:
      "Get one OpenGALEN 8 entity by exact name: kind, IRI, browser link, parents, named children, equivalents, definition axioms, GRAIL sanctions and annotations. exists=false if the name is not in the release.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "exact, case-sensitive OpenGALEN name" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_ancestors",
    description: "All ancestors of an OpenGALEN 8 entity in the classified hierarchy, breadth-first with distance.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, maxDepth: { type: "integer", minimum: 1, default: 50 } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "check_names",
    description:
      "Verify that names exist in OpenGALEN 8 (exact, case-sensitive). Use before writing any mapping. Up to 500 names.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, maxItems: 500 } },
      required: ["names"],
      additionalProperties: false,
    },
  },
] as const;

// deno-lint-ignore no-explicit-any
export function callTool(ix: OgIndex, name: string, args: any): unknown {
  switch (name) {
    case "search_concepts":
      return searchConcepts(ix, args);
    case "get_concept":
      return getConcept(ix, args);
    case "get_ancestors":
      return getAncestors(ix, args);
    case "check_names":
      return checkNames(ix, args);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
