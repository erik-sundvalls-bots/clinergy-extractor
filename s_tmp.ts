import { unpackClinergyZip } from "./src/installer.ts";
import { ZipArchive } from "./src/zip.ts";
import { extractAll } from "./src/installshield3.ts";
import { collectImages } from "./src/images.ts";
const zb = await Deno.readFile("/tmp/clin/ClinergyDemo.zip");
const inst = await unpackClinergyZip(zb);
const z = new ZipArchive(zb);
const files = new Map(inst.files);
for (const e of z.entries) if (!/_SETUP\.\d/.test(e.name)) files.set("zip/" + e.name, await z.read(e));
for (const [p, b] of extractAll([files.get("zip/_SETUP.LIB")!])) files.set("_SETUP.LIB/" + p, b);
const t = performance.now();
const s = await collectImages(files);
console.log(Math.round(performance.now() - t), "ms", s.entries.length, s.files.size);
const c: Record<string, number> = {};
for (const e of s.entries) {
  const k = `${e.format} ${e.source.split("/")[0]}${e.error ? " ERR" : ""}`;
  c[k] = (c[k] ?? 0) + 1;
}
console.log(c);
for (const e of s.entries.filter((e) => e.error)) console.log(e.source, e.resource, e.error);
await Deno.mkdir("/tmp/img", { recursive: true });
for (const [p, b] of s.files) {
  const f = "/tmp/img/" + p;
  await Deno.mkdir(f.slice(0, f.lastIndexOf("/")), { recursive: true });
  await Deno.writeFile(f, b);
}
