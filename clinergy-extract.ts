#!/usr/bin/env -S deno run -A
/**
 * clinergy-extract: turn your copy of ClinergyDemo.zip (the 1998 Clinergy /
 * PEN&PAD demo) into a tree of human-readable YAML files.
 *
 * Usage:
 *   deno run -A clinergy-extract.ts ClinergyDemo.zip out/
 *
 * Options:
 *   --wine-prefix DIR   Wine prefix to use/create (default ~/.cache/clinergy-extractor/wine-win32)
 *   --wine-arch A       win32 (default) or win64
 *   --probe-exe FILE    use a prebuilt probe.exe instead of compiling probe/probe.c
 *   --dumps DIR         skip Wine: parse probe dumps already in DIR (e.g. from running
 *                       probe.exe on Windows); the zip is still read for the INI files
 *   --verbose           show Wine / compiler output
 *
 * Pipeline: ZIP -> InstallShield 3 payload (TypeScript, src/installshield3.ts)
 *   -> Wine runs probe.exe, which asks the original TermEng.dll to dump its
 *      model (src/wine.ts, probe/probe.c) -> parse dumps (src/parse.ts)
 *   -> assemble forms (src/knowledge.ts) -> YAML tree (src/write.ts).
 */
import { parseArgs } from "@std/cli/parse-args";
import { basename } from "@std/path";
import { unpackClinergyZip } from "./src/installer.ts";
import { defaultPrefix, dumpWithWine, readDumps } from "./src/wine.ts";
import { buildKnowledge, statistics } from "./src/knowledge.ts";
import { writeOutput } from "./src/write.ts";
import { descriptorWords, valueAdverbs } from "./src/lexicon.ts";

const USAGE = "usage: deno run -A clinergy-extract.ts <ClinergyDemo.zip> <output-dir> [--wine-prefix DIR] " +
  "[--wine-arch win32|win64] [--probe-exe FILE] [--dumps DIR] [--verbose]";

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, {
    string: ["wine-prefix", "wine-arch", "probe-exe", "dumps"],
    boolean: ["verbose", "help"],
    alias: { h: "help" },
  });
  if (a.help || a._.length !== 2) {
    console.error(USAGE);
    return a.help ? 0 : 2;
  }
  const [zipPath, outDir] = a._.map(String);
  const zipBytes = await Deno.readFile(zipPath);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", zipBytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  console.error(`Unpacking ${zipPath} ...`);
  const inst = await unpackClinergyZip(zipBytes);
  console.error(
    `  ${inst.files.size} installer files, ${inst.modelFiles.size} model files, ${inst.inis.size} INI files`,
  );

  let dumps: Record<string, string>;
  if (a.dumps) dumps = await readDumps(a.dumps);
  else {
    const arch = (a["wine-arch"] ?? "win32") as "win32" | "win64";
    if (arch !== "win32" && arch !== "win64") throw new Error("--wine-arch must be win32 or win64");
    console.error("Dumping the model with TermEng.dll under Wine ...");
    dumps = await dumpWithWine(inst, {
      prefix: a["wine-prefix"] ?? defaultPrefix(arch),
      arch,
      probeExe: a["probe-exe"],
      verbose: a.verbose,
    });
  }

  // Word forms are not in the dumps; scan the binary model files for them (heuristic).
  const model = (ext: string) => [...inst.modelFiles].find(([p]) => p.toLowerCase().endsWith(ext))?.[1];
  const k = buildKnowledge(dumps, Object.fromEntries(inst.inis), {
    descriptorWords: descriptorWords([model(".p28"), model(".c28")].filter((x): x is Uint8Array => !!x)),
    valueAdverbs: model(".e28") ? valueAdverbs(model(".e28")!) : new Map(),
  });
  await Deno.mkdir(outDir, { recursive: true });
  const n = await writeOutput(k, outDir, {
    source: basename(zipPath),
    sha256,
    extractedAt: new Date().toISOString().slice(0, 10),
  });
  const s = statistics(k);
  console.error(
    `Wrote ${n} files to ${outDir}: ${s.completeTopics} forms, ${s.entitiesNamed} concepts, ${s.exams} exams, ` +
      `${s.languageDescriptors} sentence-rule descriptors.`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (e) {
    console.error(`clinergy-extract: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}
