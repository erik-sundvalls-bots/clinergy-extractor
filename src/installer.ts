/**
 * Unpack ClinergyDemo.zip: the outer ZIP holds an InstallShield 3 installer
 * whose payload is the split archive _SETUP.1 ... _SETUP.n. We never run the
 * installer; we read the payload directly and classify the files we need.
 */
import { ZipArchive } from "./zip.ts";
import { extractAll } from "./installshield3.ts";

export interface Installer {
  /** every payload file, keyed by its path inside the installer (e.g. "Group1/TermEng.dll") */
  files: Map<string, Uint8Array>;
  /** directory holding TermEng.dll + penpad.exe */
  programDir: string;
  /** the format-28 model files Model.a28 ... Model.x28 (path -> bytes) */
  modelFiles: Map<string, Uint8Array>;
  /** Compdata INI files keyed by base name (Selector.ini, Symptoms.ini, ...) */
  inis: Map<string, string>;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/** Read the installer payload from the ClinergyDemo.zip bytes. */
export async function unpackClinergyZip(zipBytes: Uint8Array): Promise<Installer> {
  const zip = new ZipArchive(zipBytes);
  // Collect _SETUP.1, _SETUP.2, ... in numeric order.
  const parts = zip.entries
    .map((e) => ({ e, m: base(e.name).match(/^_SETUP\.(\d+)$/i) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]));
  if (!parts.length) throw new Error("no _SETUP.1 found: is this the ClinergyDemo.zip installer?");
  const files = extractAll(await Promise.all(parts.map((p) => zip.read(p.e))));

  const termEng = [...files.keys()].find((p) => base(p).toLowerCase() === "termeng.dll");
  if (!termEng) throw new Error("TermEng.dll not found in installer payload");
  const modelFiles = new Map([...files].filter(([p]) => /^model\.[a-z]28$/i.test(base(p))));
  if (!modelFiles.size) throw new Error("model files (Model.*28) not found in installer payload");
  const latin1 = new TextDecoder("windows-1252");
  const inis = new Map<string, string>();
  for (const [p, b] of files) if (/\.ini$/i.test(p)) inis.set(base(p), latin1.decode(b));
  return { files, programDir: dir(termEng), modelFiles, inis };
}

/**
 * Files to place next to probe.exe: the program directory (TermEng.dll and
 * the other engine DLLs) plus the runtime DLL directory that ships MFC42.
 * The 1997 Msvcrt.dll is left out on purpose: Wine's built-in msvcrt works
 * better, and a copy in the program directory would shadow it.
 */
export function runtimeFiles(inst: Installer): Map<string, Uint8Array> {
  const mfc = [...inst.files.keys()].find((p) => base(p).toLowerCase() === "mfc42.dll");
  const dirs = new Set([inst.programDir, mfc ? dir(mfc) : inst.programDir]);
  const out = new Map<string, Uint8Array>();
  for (const [p, b] of inst.files) {
    if (!dirs.has(dir(p))) continue;
    if (base(p).toLowerCase() === "msvcrt.dll") continue;
    if (!/\.(dll|ocx|exe|tlb)$/i.test(p)) continue;
    out.set(base(p), b);
  }
  return out;
}
