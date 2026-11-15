/**
 * Run probe.exe against the demo's own TermEng.dll under Wine.
 *
 * The Clinergy model files (Model.*28) are a proprietary binary format that is
 * only documented by the engine code itself. Rather than reverse-engineer it,
 * we let the original 1998 engine load the model and call its own export
 * functions (see probe/probe.c). Steps:
 *
 *  1. ensure a 32-bit Wine prefix exists (created once, then reused)
 *  2. copy the engine DLLs and model files into C:\clinergy-extractor\
 *  3. build probe.exe from probe.c with the mingw cross compiler (unless a
 *     prebuilt probe.exe is supplied)
 *  4. `wine probe.exe C:\clinergy-extractor\model\model C:\clinergy-extractor\out`
 *  5. read the text dumps back
 *
 * Nothing is installed system-wide and the demo installer is never executed.
 */
import { join } from "@std/path";
import { DUMP_FILES } from "./knowledge.ts";
import { type Installer, runtimeFiles } from "./installer.ts";

export interface WineOptions {
  /** Wine prefix directory (created if missing). */
  prefix: string;
  /** "win32" (default, what we test with) or "win64" for Wine builds without 32-bit prefixes. */
  arch: "win32" | "win64";
  /** Path to a prebuilt probe.exe; if absent we compile probe.c. */
  probeExe?: string;
  /** Print progress / tool output. */
  verbose?: boolean;
}

/** Environment for every Wine call: quiet, no Mono/Gecko prompts, native MFC42, built-in msvcrt. */
function wineEnv(o: WineOptions): Record<string, string> {
  return {
    WINEPREFIX: o.prefix,
    WINEARCH: o.arch,
    WINEDEBUG: "-all",
    WINEDLLOVERRIDES: "mscoree,mshtml,winemenubuilder.exe=d;mfc42,mfc42u=n;msvcrt=b",
  };
}

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; verbose?: boolean },
) {
  let out;
  try {
    out = await new Deno.Command(cmd, { args, cwd: opts.cwd, env: opts.env, stdout: "piped", stderr: "piped" })
      .output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw new Error(`'${cmd}' not found on PATH (see README: prerequisites)`);
    throw e;
  }
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  if (opts.verbose && text.trim()) console.error(text.trim());
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${out.code}):\n${text}`);
  return text;
}

const exists = async (p: string) => !!(await Deno.stat(p).catch(() => null));

/** Default prefix location: $XDG_CACHE_HOME/clinergy-extractor/wine-<arch> (or ~/.cache/...). */
export function defaultPrefix(arch: string): string {
  const cache = Deno.env.get("XDG_CACHE_HOME") ?? join(Deno.env.get("HOME") ?? ".", ".cache");
  return join(cache, "clinergy-extractor", `wine-${arch}`);
}

/** Create the Wine prefix on first use (takes a little while). */
export async function ensurePrefix(o: WineOptions) {
  if (await exists(join(o.prefix, "system.reg"))) return;
  console.error(`Creating Wine prefix ${o.prefix} (first run only)...`);
  await Deno.mkdir(o.prefix, { recursive: true });
  await run("wineboot", ["-i"], { env: wineEnv(o), verbose: o.verbose });
  await run("wineserver", ["-w"], { env: wineEnv(o) });
}

/** Locate probe.c next to this module (works for local checkouts and remote URLs). */
async function probeSource(): Promise<string> {
  const url = new URL("../probe/probe.c", import.meta.url);
  return await (await fetch(url)).text();
}

/** Run the whole Wine step; returns the dump texts keyed by file name. */
export async function dumpWithWine(inst: Installer, o: WineOptions): Promise<Record<string, string>> {
  await ensurePrefix(o);
  const root = join(o.prefix, "drive_c", "clinergy-extractor");
  await Deno.remove(root, { recursive: true }).catch(() => {});
  const progDir = join(root, "Programs"), modelDir = join(root, "model"), outDir = join(root, "out");
  for (const d of [progDir, modelDir, outDir]) await Deno.mkdir(d, { recursive: true });
  for (const [name, bytes] of runtimeFiles(inst)) await Deno.writeFile(join(progDir, name), bytes);
  // The engine opens "<base>.a28", "<base>.c28", ...; Wine file names are case-insensitive.
  for (const [p, bytes] of inst.modelFiles) {
    await Deno.writeFile(join(modelDir, "model" + p.slice(p.lastIndexOf(".")).toLowerCase()), bytes);
  }

  const exe = join(progDir, "probe.exe");
  if (o.probeExe) await Deno.copyFile(o.probeExe, exe);
  else {
    const src = join(root, "probe.c");
    await Deno.writeTextFile(src, await probeSource());
    await run("i686-w64-mingw32-gcc", ["-O1", "-o", exe, src], { verbose: o.verbose });
  }
  const log = await run("wine", ["probe.exe", "C:\\clinergy-extractor\\model\\model", "C:\\clinergy-extractor\\out"], {
    cwd: progDir,
    env: wineEnv(o),
    verbose: o.verbose,
  });
  if (!/LoadModel28\(.*\) = 1/.test(log)) throw new Error(`probe could not load the model:\n${log}`);
  return await readDumps(outDir);
}

/** Read probe dump files from a directory (also used by --dumps). */
export async function readDumps(dir: string): Promise<Record<string, string>> {
  const dec = new TextDecoder("windows-1252");
  const out: Record<string, string> = {};
  for (const f of DUMP_FILES) {
    const p = join(dir, f);
    if (!(await exists(p))) throw new Error(`missing dump file ${p}`);
    out[f] = dec.decode(await Deno.readFile(p));
  }
  return out;
}
