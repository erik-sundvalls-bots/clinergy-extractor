import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { pngSize, writeImagePack, PACK_SCHEMA } from "../src/image-pack.ts";
import { unzipStore, zipStore } from "../src/zip-store.ts";

const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

Deno.test("pngSize reads IHDR", () => {
  assertEquals(pngSize(TINY_PNG), { width: 1, height: 1 });
  assertEquals(pngSize(new Uint8Array([1, 2, 3])), null);
});

Deno.test("zipStore round-trips and drops .. entries on read", () => {
  const bytes = zipStore({ "pack.yaml": new TextEncoder().encode("hello"), "images/a.png": TINY_PNG });
  const out = unzipStore(bytes);
  assertEquals(new TextDecoder().decode(out["pack.yaml"]), "hello");
  assertEquals(out["images/a.png"], TINY_PNG);
});

Deno.test("writeImagePack builds a v1 zip from a synthetic extract tree", async () => {
  const dir = await Deno.makeTempDir({ prefix: "image-pack-fix-" });
  try {
    const yaml = `
Onelist.ini:
  selectors:
    - settings:
        TSFlagType: [symptom]
        Label: [Symptom Selector]
      options:
        - n: "1"
          sex: M
          label: all
          system: FunctionalSystem
          anatomyMap: MaleSurfaceAnatomy
          bitmaps: [all1.bmp]
          bitmapImages: [images/buttons/All1.png]
  mainGraphics:
    MaleSurfaceAnatomy:
      concept: BodyAsAWhole
      hotspot: [30, 324, 3, 236]
      picture: m_main.bmp
      image: images/bodymap/M_main.png
      rect: [0, 0, 240, 330]
  maps:
    MaleSurfaceAnatomy:
      - concept: Hand
        hotspot: [169, 202, 9, 40]
        inset: b_fhnd.bmp
        insetRect: [7, 95, 96, 148]
        insetImage: images/bodymap/B_fhnd.png
        sublocations:
          - concept: Thumb
            hotspot: [42, 99, 7, 37]
      - concept: Head
        hotspot: [35, 70, 99, 137]
        inset: "null"
        insetRect: [0, 0, 0, 0]
`;
    await Deno.mkdir(join(dir, "images/bodymap"), { recursive: true });
    await Deno.mkdir(join(dir, "images/buttons"), { recursive: true });
    await Deno.writeTextFile(join(dir, "bodymap.yaml"), yaml);
    await Deno.writeFile(join(dir, "images/bodymap/M_main.png"), TINY_PNG);
    await Deno.writeFile(join(dir, "images/bodymap/B_fhnd.png"), TINY_PNG);
    await Deno.writeFile(join(dir, "images/buttons/All1.png"), TINY_PNG);

    const zipPath = join(dir, "out.zip");
    const result = await writeImagePack(dir, { zipPath });
    assertEquals(result.imageCount, 3);
    assertEquals(result.mapCount, 1);

    const files = unzipStore(await Deno.readFile(zipPath));
    const packText = new TextDecoder().decode(files["pack.yaml"]);
    assertStringIncludes(packText, `schema: ${PACK_SCHEMA}`);
    assertStringIncludes(packText, "id: clinergy-1998-local");
    assertStringIncludes(packText, "Must not be committed");
    assertStringIncludes(packText, "concept: Thumb");
    assertStringIncludes(packText, "buttonUp: All1");
    assert("images/bodymap/M_main.png" in files);
    assert("images/bodymap/B_fhnd.png" in files);
    assert("images/buttons/All1.png" in files);
    // The INI string "null" must not become an image id.
    assert(!packText.includes("image: null") || packText.includes("label: null"));
    assert(!("images/bodymap/null.png" in files));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
