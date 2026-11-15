// Tests for the PNG encoder, BMP/ICO decoding, PE/NE resource reading and image
// collection, on synthetic data built in tests/image_fixtures.ts.
import { assert, assertEquals } from "@std/assert";
import { crc32, encodePng } from "../src/png.ts";
import { decodeBmpFile, decodeDib } from "../src/bmp.ts";
import { buildIcoFile, parseIcoFile, readResources, resolveGroup, RT } from "../src/resources.ts";
import { bodyMapUsage, collectImages, otherBitmapMentions } from "../src/images.ts";
import { parseBodyMapIni } from "../src/parse.ts";
import { bmpFile, dib, groupIcon, icoFile, neFile, peFile } from "./image_fixtures.ts";

const RED: [number, number, number] = [255, 0, 0], BLUE: [number, number, number] = [0, 0, 255];
const px = (
  d: { width: number; rgba: Uint8Array },
  x: number,
  y: number,
) => [...d.rgba.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 4)];

/** Decode our own PNG output (unfiltered rows) back to bytes per row, checking every CRC. */
async function readPng(png: Uint8Array) {
  assertEquals([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(png.buffer, png.byteOffset);
  let o = 8, ihdr: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = v.getUint32(o), type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const body = png.subarray(o + 8, o + 8 + len);
    assertEquals(v.getUint32(o + 8 + len), (crc32(png.subarray(o + 4, o + 8 + len)) ^ 0xffffffff) >>> 0, `${type} CRC`);
    if (type === "IHDR") ihdr = body;
    if (type === "IDAT") idat.push(body);
    o += 12 + len;
  }
  const iv = new DataView(ihdr!.buffer, ihdr!.byteOffset);
  const raw = new Uint8Array(
    await new Response(
      new Blob(idat as Uint8Array<ArrayBuffer>[]).stream().pipeThrough(new DecompressionStream("deflate")),
    )
      .arrayBuffer(),
  );
  return { width: iv.getUint32(0), height: iv.getUint32(4), colourType: ihdr![9], raw };
}

Deno.test("png: RGB when opaque, RGBA otherwise, valid CRCs and zlib data", async () => {
  const opaque = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
  let p = await readPng(await encodePng(2, 1, opaque));
  assertEquals([p.width, p.height, p.colourType], [2, 1, 2]);
  assertEquals([...p.raw], [0, 255, 0, 0, 0, 255, 0]);
  p = await readPng(await encodePng(1, 2, new Uint8Array([1, 2, 3, 0, 4, 5, 6, 128])));
  assertEquals(p.colourType, 6);
  assertEquals([...p.raw], [0, 1, 2, 3, 0, 0, 4, 5, 6, 128]);
  assertEquals((crc32(new TextEncoder().encode("IEND")) ^ 0xffffffff) >>> 0, 0xae426082);
});

Deno.test("bmp: 4-bit bottom-up file, 24-bit top-down, 1-bit, row padding", () => {
  const four = decodeBmpFile(
    bmpFile(dib({ width: 3, height: 2, bpp: 4, palette: [RED, BLUE], pixels: [[0, 1, 0], [1, 1, 0]] })),
  );
  assertEquals([four.width, four.height, four.bitsPerPixel], [3, 2, 4]);
  assertEquals(px(four, 0, 0), [255, 0, 0, 255]); // top-left stays top-left: rows are flipped
  assertEquals(px(four, 0, 1), [0, 0, 255, 255]);
  const td = decodeDib(dib({ width: 2, height: 2, bpp: 24, topDown: true, pixels: [[RED, BLUE], [BLUE, RED]] }));
  assertEquals([px(td, 0, 0), px(td, 1, 0)], [[255, 0, 0, 255], [0, 0, 255, 255]]);
  const one = decodeDib(
    dib({ width: 9, height: 1, bpp: 1, palette: [[0, 0, 0], [255, 255, 255]], pixels: [[1, 0, 0, 0, 0, 0, 0, 0, 1]] }),
  );
  assertEquals([px(one, 0, 0)[0], px(one, 1, 0)[0], px(one, 8, 0)[0]], [255, 0, 255]);
});

Deno.test("bmp: RLE8 and 16-bit 5-5-5", () => {
  // 3x2 RLE8, bottom-up: row 0 (bottom) = run of 3 x index 1, row 1 = absolute [0,1,0]
  const h = dib({ width: 3, height: 2, bpp: 8, palette: [RED, BLUE], pixels: [[0, 0, 0], [0, 0, 0]] });
  const rle = new Uint8Array([3, 1, 0, 0, 0, 3, 0, 1, 0, 0, 0, 0, 0, 1]);
  const head = h.subarray(0, 40 + 8).slice();
  new DataView(head.buffer).setUint32(16, 1, true); // BI_RLE8
  const r = decodeDib(new Uint8Array([...head, ...rle]));
  assertEquals([px(r, 0, 1)[2], px(r, 2, 1)[2]], [255, 255]); // bottom row blue
  assertEquals([px(r, 0, 0)[0], px(r, 1, 0)[2]], [255, 255]); // top row red, blue, red
  const b16 = new Uint8Array(40 + 4);
  const v = new DataView(b16.buffer);
  v.setUint32(0, 40, true),
    v.setInt32(4, 1, true),
    v.setInt32(8, 1, true),
    v.setUint16(12, 1, true),
    v.setUint16(14, 16, true);
  v.setUint16(40, 0x7c00, true); // pure red in 5-5-5
  assertEquals(px(decodeDib(b16), 0, 0), [255, 0, 0, 255]);
});

Deno.test("ico: AND mask makes pixels transparent; .ico parse and rebuild", () => {
  const image = dib({
    width: 2,
    height: 2,
    bpp: 4,
    palette: [RED, BLUE],
    pixels: [[0, 1], [1, 0]],
    mask: [[1, 0], [0, 0]],
  });
  const d = decodeDib(image, { icon: true });
  assertEquals([d.width, d.height], [2, 2]);
  assertEquals(px(d, 0, 0)[3], 0);
  assertEquals(px(d, 1, 0), [0, 0, 255, 255]);
  const ico = parseIcoFile(icoFile(image, 2, 2, 4));
  assertEquals([ico.cursor, ico.images.length, ico.images[0].bitCount], [false, 1, 4]);
  const again = parseIcoFile(buildIcoFile(ico.images));
  assertEquals([...again.images[0].data], [...image]);
});

function demoPe() {
  const icon = dib({
    width: 2,
    height: 2,
    bpp: 4,
    palette: [RED, BLUE],
    pixels: [[0, 1], [1, 0]],
    mask: [[0, 0], [0, 0]],
  });
  const toolbar = new Uint8Array(8 + 2);
  const tv = new DataView(toolbar.buffer);
  tv.setUint16(0, 1, true), tv.setUint16(2, 16, true), tv.setUint16(4, 15, true), tv.setUint16(6, 1, true);
  return peFile([
    { type: RT.BITMAP, name: 128, data: dib({ width: 2, height: 1, bpp: 24, pixels: [[RED, BLUE]] }) },
    { type: RT.ICON, name: 1, data: icon },
    {
      type: RT.GROUP_ICON,
      name: "MAINICON",
      data: groupIcon([{ width: 2, height: 2, bpp: 4, size: icon.length, id: 1 }]),
    },
    { type: RT.TOOLBAR, name: 128, data: toolbar },
  ]);
}

Deno.test("PE resources: bitmap, icon group, toolbar, string names", () => {
  const rs = readResources(demoPe());
  assertEquals(rs.map((r) => [r.type, r.name, r.lang]), [
    [RT.BITMAP, 128, 0x409],
    [RT.ICON, 1, 0x409],
    [RT.GROUP_ICON, "MAINICON", 0x409],
    [RT.TOOLBAR, 128, 0x409],
  ]);
  const group = resolveGroup(rs[2], rs);
  assertEquals([group.length, group[0].width, group[0].bitCount], [1, 2, 4]);
});

Deno.test("NE resources: 16-bit executables", () => {
  const icon = dib({ width: 2, height: 2, bpp: 4, palette: [RED], pixels: [[0, 0], [0, 0]], mask: [[0, 0], [0, 0]] });
  const rs = readResources(neFile([
    { type: RT.ICON, name: 7, data: icon },
    { type: RT.GROUP_ICON, name: 8, data: groupIcon([{ width: 2, height: 2, bpp: 4, size: icon.length, id: 7 }]) },
  ]));
  assertEquals(rs.map((r) => [r.type, r.name]), [[RT.ICON, 7], [RT.GROUP_ICON, 8]]);
  assertEquals([...rs[0].data.subarray(0, icon.length)], [...icon]); // padded to the 16-byte alignment
  assertEquals(resolveGroup(rs[1], rs).length, 1);
});

Deno.test("collectImages: loose bitmaps, executables, VB blobs; usage from the INI files", async () => {
  const pic = bmpFile(dib({ width: 2, height: 2, bpp: 4, palette: [RED, BLUE], pixels: [[0, 1], [1, 0]] }));
  const ico = icoFile(
    dib({ width: 2, height: 2, bpp: 4, palette: [RED], pixels: [[0, 0], [0, 0]], mask: [[0, 0], [0, 0]] }),
    2,
    2,
    4,
  );
  const blob = new Uint8Array(12 + ico.length);
  const bv = new DataView(blob.buffer);
  bv.setUint32(0, ico.length + 8, true),
    blob.set([0x6c, 0x74, 0, 0], 4),
    bv.setUint32(8, ico.length, true),
    blob.set(ico, 12);
  const ini = [
    "[BEGIN SELECTOR]",
    "Label,Test Selector",
    "OptionButton,1,M,arm,ArmSystem,arm1.bmp,arm2.bmp,TestAnatomy",
    "[END SELECTOR]",
    "[BEGIN TestAnatomy]",
    "MAINGRAPHIC",
    "BodyAsAWhole,0,10,0,20,body.bmp,0,0,10,20",
    "LOCATION",
    "Elbow,1,2,3,4,ELBOW.BMP,0,0,2,2",
    "SUBLOCATION",
    "ElbowTip,0,1,0,1",
    "[END TestAnatomy]",
  ].join("\n");
  const maps = new Map([["Test.ini", parseBodyMapIni(ini)]]);
  assertEquals(maps.get("Test.ini")!.mainGraphics.get("TestAnatomy")!.inset, "body.bmp");
  const usage = bodyMapUsage(maps);
  assertEquals(usage.get("elbow.bmp")!.dir, "bodymap");
  assertEquals(usage.get("arm1.bmp")!.dir, "buttons");
  assert(usage.get("body.bmp")!.usedFor[0].startsWith("main picture of the map"));
  const mentions = otherBitmapMentions(
    new Map([["Options.ini", "BANNERSCREEN, 'c:\\x\\banner.bmp',"]]),
    new Map([["Group1/app.dll", new TextEncoder().encode("\0tab1.bmp\0")]]),
  );
  assertEquals(mentions.get("banner.bmp"), ["Options.ini: BANNERSCREEN"]);
  assertEquals(mentions.get("tab1.bmp"), ["file name appears in app.dll"]);

  const set = await collectImages(
    new Map([
      ["Group5/Elbow.bmp", pic],
      ["Group5/Elbow.jk", pic],
      ["Group1/app.exe", demoPe()],
      ["Group6/Form.frx", blob],
      ["Group9/readme.txt", new TextEncoder().encode("BM is not enough")],
    ]),
    (p) => usage.get(p.slice(p.lastIndexOf("/") + 1).toLowerCase())?.dir ?? "bitmaps",
  );
  const files = [...set.files.keys()].sort();
  assertEquals(files, [
    "bitmaps/Elbow.jk.png",
    "bodymap/Elbow.png",
    "icons/app.exe/icon-MAINICON-2x2-4bpp.png",
    "icons/app.exe/icon-MAINICON.ico",
    "icons/vb-forms/Form-vb-0-2x2-4bpp.png",
    "icons/vb-forms/Form-vb-0.ico",
    "resources/app.exe/bitmap-128.png",
  ]);
  const byFile = new Map(set.entries.map((e) => [e.file, e]));
  assertEquals(byFile.get("icons/app.exe/icon-MAINICON.ico")!.usedFor, ["application icon of app.exe"]);
  assertEquals(byFile.get("resources/app.exe/bitmap-128.png")!.usedFor, ["toolbar strip: 1 buttons of 16x15 px"]);
  assertEquals(set.loose.get("elbow.bmp")!.file, "bodymap/Elbow.png");
  assert(set.entries.every((e) => !e.error));
  const png = await readPng(set.files.get("bodymap/Elbow.png")!);
  assertEquals([png.width, png.height, png.raw[1]], [2, 2, 255]); // top-left red
});
