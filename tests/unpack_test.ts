// Unit tests for the archive readers, using only synthetic data built in helpers.ts.
import { assertEquals, assertThrows } from "@std/assert";
import { explode } from "../src/explode.ts";
import { extractAll, listFiles } from "../src/installshield3.ts";
import { ZipArchive } from "../src/zip.ts";
import { unpackClinergyZip } from "../src/installer.ts";
import { buildIs3, buildZip, implode } from "./helpers.ts";

const enc = new TextEncoder(), dec = new TextDecoder();
const sample = enc.encode("Hello hello hello, this is a test of the DCL explode decoder. ".repeat(40) + "end");

Deno.test("explode: reference vector from blast.c decodes to AIAIAIAIAIAIA", () => {
  const out = explode(new Uint8Array([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f]));
  assertEquals(dec.decode(out), "AIAIAIAIAIAIA");
});

for (const [dict, coded] of [[4, false], [5, true], [6, false], [6, true]] as const) {
  Deno.test(`explode: round trip dict=${dict} codedLiterals=${coded}`, () => {
    const all = new Uint8Array(256).map((_, i) => i); // every byte value
    for (const data of [sample, all, new Uint8Array(0), enc.encode("aa")]) {
      assertEquals(explode(implode(data, dict, coded), data.length), data);
    }
  });
}

Deno.test("explode: rejects bad headers and size mismatches", () => {
  assertThrows(() => explode(new Uint8Array([2, 4, 0])), Error, "literal flag");
  assertThrows(() => explode(new Uint8Array([0, 7, 0])), Error, "dictionary");
  assertThrows(() => explode(implode(sample), sample.length + 1), Error, "expected");
});

Deno.test("installshield3: unsplit archive with stored and compressed files", () => {
  const files = [
    { path: "Group1/a.txt", data: sample },
    { path: "Group2/b.bin", data: new Uint8Array([1, 2, 3]), stored: true },
    { path: "top.ini", data: enc.encode("[x]\n") },
  ];
  const [arc] = buildIs3(files);
  assertEquals(listFiles(arc).map((f) => f.path), ["Group1/a.txt", "Group2/b.bin", "top.ini"]);
  const out = extractAll([arc]);
  for (const f of files) assertEquals(out.get(f.path), f.data);
});

Deno.test("installshield3: file spanning two parts", () => {
  const files = [
    { path: "G/one.txt", data: sample },
    { path: "G/two.txt", data: enc.encode("second ".repeat(300)) },
    { path: "G/three.txt", data: enc.encode("third") },
  ];
  const first = implode(sample).length;
  const parts = buildIs3(files, first + 20); // "two" starts in part 1 and ends in part 2
  assertEquals(parts.length, 2);
  const out = extractAll(parts);
  for (const f of files) assertEquals(out.get(f.path), f.data);
});

Deno.test("installshield3: bad magic", () => {
  assertThrows(() => listFiles(new Uint8Array(64)), Error, "magic");
});

Deno.test("zip: stored and deflated entries, case-insensitive find", async () => {
  const z = new ZipArchive(await buildZip({ "A.TXT": enc.encode("stored"), "dir/b.txt": sample }, ["dir/b.txt"]));
  assertEquals(z.entries.map((e) => [e.name, e.method]), [["A.TXT", 0], ["dir/b.txt", 8]]);
  assertEquals(dec.decode(await z.read(z.find("a.txt")!)), "stored");
  assertEquals(await z.read(z.find("dir/b.txt")!), sample);
  assertThrows(() => new ZipArchive(new Uint8Array(100)), Error, "end of central directory");
});

Deno.test("installer: finds program dir, model files and INIs in a synthetic installer zip", async () => {
  const parts = buildIs3([
    { path: "Group1/TermEng.dll", data: enc.encode("fake dll") },
    { path: "Group2/Mfc42.dll", data: enc.encode("fake mfc") },
    { path: "Group2/Msvcrt.dll", data: enc.encode("fake crt") },
    { path: "Group3/Model.a28", data: enc.encode("fake model") },
    { path: "Group4/Selector.ini", data: enc.encode("[BEGIN SELECTOR]\n") },
  ], 30);
  const zip = await buildZip({ "SETUP.EXE": enc.encode("MZ"), "_SETUP.1": parts[0], "_SETUP.2": parts[1] });
  const inst = await unpackClinergyZip(zip);
  assertEquals(inst.programDir, "Group1");
  assertEquals([...inst.modelFiles.keys()], ["Group3/Model.a28"]);
  assertEquals([...inst.inis.keys()], ["Selector.ini"]);
  const { runtimeFiles } = await import("../src/installer.ts");
  assertEquals([...runtimeFiles(inst).keys()].sort(), ["Mfc42.dll", "TermEng.dll"]); // Msvcrt.dll left out
});
