#!/usr/bin/env -S deno run -A
/**
 * clinergy-wine: install and run the 1998 ClinergyDemo (PEN&PAD) under Wine on
 * Linux, without its 16-bit installer.
 *
 *   deno run -A clinergy-wine.ts install ClinergyDemo.zip   create the prefix and unpack the demo into C:\Clinergy
 *   deno run -A clinergy-wine.ts start                      start penpad.exe
 *   deno run -A clinergy-wine.ts demo                       start, load the model, open the Symptom Selector
 *   deno run -A clinergy-wine.ts kill                       stop it (wineserver -k)
 *
 * Options: --prefix DIR (default ~/.cache/clinergy-extractor/wine-clinergy, or $WINEPREFIX)
 *
 * Needs wine (tested with Wine 10.0), and i686-w64-mingw32-gcc for the small
 * wine/ppctl.c helper that `demo` uses because the menu bar does not show.
 * What it does, and why (all found by trial):
 *  - 32-bit prefix (WINEARCH=win32) reporting Windows XP.
 *  - SETUP.EXE is a 16-bit InstallShield 3 launcher that 64-bit Wine cannot run, so
 *    the payload is unpacked directly (src/installer.ts) into C:\Clinergy\Programs,
 *    C:\Clinergy\Compdata\{archive,ini,bmp,dbfiles} and the demo/documentation folders.
 *  - The bundled Mfc42.dll is used (mfc42=n); the bundled 1997 Msvcrt.dll is NOT
 *    copied, and msvcrt=b keeps Wine's own.
 *  - penpad.exe must start in C:\Clinergy\Programs; C:\windows\Penpad.ini points the engine at
 *    C:\clinergy\compdata, and the model is then loaded by the relative name "model"
 *    from the archive folder.
 */
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { unpackClinergyZip } from "./src/installer.ts";

const OVERRIDES = "mscoree,mshtml,winemenubuilder.exe=d;mfc42,mfc42u=n;msvcrt=b";
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/** Where each installer group goes, chosen by a file that identifies the group. */
const PLACES: [RegExp, string][] = [
  [/^penpad\.exe$/i, "Clinergy/Programs"],
  [/^mfc42\.dll$/i, "Clinergy/Programs"],
  [/^penpad\.ini$/i, "windows"], // read from %WINDIR% (WorkDir=C:\clinergy\compdata)
  [/^model\.a28$/i, "Clinergy/Compdata/archive"],
  [/^selector\.ini$/i, "Clinergy/Compdata/ini"],
  [/\.bmp$/i, "Clinergy/Compdata/bmp"],
  [/^vbdemo\.exe$/i, "Clinergy/VB Demo"],
  [/^gendemo\.exe$/i, "Clinergy/Gen Demo"],
  [/^windemo\.exe$/i, "Clinergy/Win Demo"],
  [/^penpad api\.rtf$/i, "Clinergy/Documentation"],
  [/\.ttf$/i, "windows/Fonts"],
];

async function run(cmd: string, args: string[], env: Record<string, string>, cwd?: string, quiet = false) {
  const p = new Deno.Command(cmd, {
    args,
    env,
    cwd,
    stdout: quiet ? "null" : "inherit",
    stderr: quiet ? "null" : "inherit",
  });
  const { code } = await p.output();
  if (code !== 0 && !quiet) throw new Error(`${cmd} ${args.join(" ")} failed (${code})`);
  return code;
}

export async function install(zip: string, prefix: string, env: Record<string, string>) {
  const inst = await unpackClinergyZip(await Deno.readFile(zip));
  if (!(await Deno.stat(join(prefix, "system.reg")).catch(() => null))) {
    console.error(`Creating 32-bit Wine prefix ${prefix} ...`);
    await Deno.mkdir(prefix, { recursive: true });
    await run("wineboot", ["-i"], env);
  }
  await run("winecfg", ["-v", "winxp"], env);
  const groupDir = new Map<string, string>();
  for (const p of inst.files.keys()) {
    const hit = PLACES.find(([re]) => re.test(base(p)));
    if (hit && !groupDir.has(dir(p))) groupDir.set(dir(p), hit[1]);
  }
  const c = join(prefix, "drive_c");
  let n = 0;
  for (const [p, bytes] of inst.files) {
    const to = groupDir.get(dir(p));
    if (!to || /^msvcrt\.dll$/i.test(base(p))) continue; // keep Wine's msvcrt
    await Deno.mkdir(join(c, to), { recursive: true });
    await Deno.writeFile(join(c, to, base(p)), bytes);
    n++;
  }
  await Deno.mkdir(join(c, "Clinergy/Compdata/dbfiles"), { recursive: true });
  const src = new URL("./wine/ppctl.c", import.meta.url).pathname;
  const built = await run(
    "i686-w64-mingw32-gcc",
    ["-O1", "-o", join(c, "Clinergy/Programs/ppctl.exe"), src],
    env,
    undefined,
    true,
  ).catch(() => 1);
  await run("wineserver", ["-w"], env);
  console.error(
    `Installed ${n} files into C:\\Clinergy (${c}).` + (built === 0 ? "" : " (ppctl.exe not built: no mingw)"),
  );
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { string: ["prefix"], boolean: ["help"], alias: { h: "help" } });
  const [cmd, zip] = a._.map(String);
  if (a.help || !cmd || (cmd === "install" && !zip)) {
    console.error("usage: clinergy-wine.ts install ClinergyDemo.zip | start | demo | kill  [--prefix DIR]");
    return a.help ? 0 : 2;
  }
  const prefix = a.prefix ?? Deno.env.get("WINEPREFIX") ??
    join(Deno.env.get("HOME") ?? ".", ".cache/clinergy-extractor/wine-clinergy");
  const env = { WINEPREFIX: prefix, WINEARCH: "win32", WINEDLLOVERRIDES: OVERRIDES, WINEDEBUG: "-all" };
  const prog = join(prefix, "drive_c/Clinergy/Programs");
  const ppctl = (...args: string[]) => run("wine", ["ppctl.exe", ...args], env, prog, true);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  switch (cmd) {
    case "install":
      await install(zip, prefix, env);
      return 0;
    case "start":
      return await run("wine", ["penpad.exe"], env, prog);
    case "demo": {
      const app = new Deno.Command("wine", { args: ["penpad.exe"], env, cwd: prog, stdout: "null", stderr: "null" })
        .spawn();
      // wait for the main window, then: Load model -> type "model" -> OK -> dismiss "loaded" -> Symptom Selector
      for (let i = 0; i < 60 && await ppctl("find") !== 0; i++) await sleep(500);
      await sleep(1000);
      const steps: [string[], number][] = [
        [["cmd", "load"], 800],
        [["text", "model"], 300],
        [["ok"], 1500],
        [["ok"], 500], // dismiss "Model loaded OK"
        [["cmd", "symptom"], 500],
      ];
      for (const [args, wait] of steps) {
        await ppctl(...args);
        await sleep(wait);
      }
      console.error("Symptom Selector open: click a body region, then a topic, to open a form. Ctrl-C to quit.");
      return (await app.status).code;
    }
    case "kill":
      return await run("wineserver", ["-k"], env, undefined, true);
    default:
      console.error(`unknown command ${cmd}`);
      return 2;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
