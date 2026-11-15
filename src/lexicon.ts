/**
 * Word forms used by the summary-sentence generator that the engine's text
 * exporters do not write out: per-descriptor noun / adjective / negative forms
 * (e.g. a severity descriptor -> "severity", "severe", ...) and per-value adverbs
 * (moderate -> "moderately").
 *
 * They are read straight from the binary model files with a HEURISTIC scan
 * (the file format is undocumented):
 *  - Model.p28 and Model.c28 store names as Pascal strings (a length byte
 *    followed by the text). A CamelCase descriptor name is followed by up to
 *    three plain-word strings: noun, adjective, negative form.
 *  - Model.e28 stores value entities with an "...ly" adverb string in the
 *    record header, followed shortly by the value's own name.
 * Treat the result as a starting point for review, not as ground truth.
 */

export interface DescriptorWords {
  noun: string | null;
  adjective: string | null;
  negative: string | null;
}

const latin1 = new TextDecoder("latin1");
const CAMEL = /^[A-Z][a-z]+[A-Z]\w+$/;

/** All Pascal strings (length-prefixed, letters/digits/space/-/') in a binary file. */
export function pascalStrings(bytes: Uint8Array): string[] {
  const s = latin1.decode(bytes);
  const out: string[] = [];
  // deno-lint-ignore no-control-regex -- binary record markers
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9 \-']*/g)) {
    if (m.index! > 0 && s.charCodeAt(m.index! - 1) === m[0].length) out.push(m[0]);
  }
  return out;
}

/** Descriptor name -> word forms, from the Pascal strings of Model.p28 / Model.c28. */
export function descriptorWords(files: Uint8Array[]): Map<string, DescriptorWords> {
  const lex = new Map<string, DescriptorWords>();
  for (const f of files) {
    const t = pascalStrings(f);
    t.forEach((w, i) => {
      if (!CAMEL.test(w)) return;
      const forms: string[] = [];
      for (const x of t.slice(i + 1, i + 4)) {
        if (CAMEL.test(x)) break;
        if (x.length > 1) forms.push(x);
      }
      lex.set(w, { noun: forms[0] ?? null, adjective: forms[1] ?? null, negative: forms[2] ?? null });
    });
  }
  return lex;
}

/** Value name -> adverb, from Model.e28. */
export function valueAdverbs(e28: Uint8Array): Map<string, string> {
  const s = latin1.decode(e28);
  const out = new Map<string, string>();
  for (const m of s.matchAll(/\x01\x00\x00([\x03-\x14])([a-z]+ly)\x00/g)) {
    if (m[1].charCodeAt(0) !== m[2].length) continue;
    const end = m.index! + m[0].length;
    // deno-lint-ignore no-control-regex -- binary record markers
    const n = s.slice(end, end + 40).match(/\x01\x00([\x03-\x20])([A-Za-z]+)/);
    if (n && n[1].charCodeAt(0) === n[2].length) out.set(n[2], m[2]);
  }
  return out;
}
