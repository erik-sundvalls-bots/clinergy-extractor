/**
 * A small YAML emitter tuned for human review.
 *
 * Why not just `@std/yaml` stringify? We want short lists of plain names on
 * one line (`values: [mild, moderate, severe]`), block style for everything
 * else, keys in the order we build them, and a comment header per file.
 * Output is plain YAML 1.2; the test suite parses every emitted shape back with
 * `@std/yaml` to prove it round-trips.
 */

/** Strings that YAML would read as something other than a string. */
const RESERVED =
  /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\d[\d_]*)?(?:\.\d*)?(?:e[-+]?\d+)?|\.inf|\.nan|0x[0-9a-f]+|0o[0-7]+)$/i;
/** Plain (unquoted) scalars we allow: conservative on purpose. */
const PLAIN = /^[A-Za-z_(][A-Za-z0-9_ .()\/'+&-]*$/;

/** Format a string as a YAML scalar, quoting when needed. */
export function scalar(s: string): string {
  if (s !== "" && PLAIN.test(s) && !RESERVED.test(s) && !s.endsWith(" ") && !s.includes(" #") && !s.includes(": ")) {
    return s;
  }
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

function atom(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return scalar(String(v));
}
const isAtom = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Max width of an inline `[a, b]` list or `{k: v}` map before falling back to block style. */
const INLINE_WIDTH = 100;

function inline(v: unknown): string | null {
  if (isAtom(v)) return atom(v);
  if (Array.isArray(v)) {
    if (!v.every(isAtom)) return null;
    const s = `[${v.map(atom).join(", ")}]`;
    return s.length <= INLINE_WIDTH ? s : null;
  }
  if (isPlainObject(v)) {
    const e = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!e.every(([, x]) => isAtom(x))) return null;
    const s = `{${e.map(([k, x]) => `${scalar(k)}: ${atom(x)}`).join(", ")}}`;
    return s.length <= INLINE_WIDTH && e.length <= 4 ? s : null;
  }
  return null;
}

function emit(v: unknown, indent: string, out: string[]): void {
  if (Array.isArray(v)) {
    for (const x of v) {
      const i = inline(x); // short lists and small all-scalar maps stay on one line
      if (i !== null) {
        out.push(`${indent}- ${i}`);
        continue;
      }
      if (isPlainObject(x)) {
        // "- key: value" with the remaining keys aligned under the first one
        const sub: string[] = [];
        emitMap(x, indent + "  ", sub);
        if (sub.length === 0) {
          out.push(`${indent}- {}`);
          continue;
        }
        out.push(`${indent}- ${sub[0].slice(indent.length + 2)}`, ...sub.slice(1));
      } else {
        out.push(`${indent}-`);
        emit(x, indent + "  ", out);
      }
    }
  } else if (isPlainObject(v)) emitMap(v, indent, out);
  else out.push(indent + atom(v));
}

function emitMap(m: Record<string, unknown>, indent: string, out: string[]): void {
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined) continue;
    const key = scalar(k);
    if (Array.isArray(v) && v.length === 0) {
      out.push(`${indent}${key}: []`);
      continue;
    }
    if (isPlainObject(v) && Object.keys(v).length === 0) {
      out.push(`${indent}${key}: {}`);
      continue;
    }
    const i = inline(v);
    if (i !== null) {
      out.push(`${indent}${key}: ${i}`);
      continue;
    }
    out.push(`${indent}${key}:`);
    emit(v, indent + "  ", out);
  }
}

/**
 * Serialise a document. `comment` lines are written first as "# ..." lines.
 * Maps are written as Record objects; convert Map instances before calling.
 */
export function toYaml(doc: unknown, comment: string[] = []): string {
  const out: string[] = comment.map((c) => (c ? `# ${c}` : "#"));
  emit(doc, "", out);
  return out.join("\n") + "\n";
}
