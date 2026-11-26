#!/usr/bin/env -S deno run -A
/**
 * Write a penpad-image-pack/v1 zip from an existing extract tree (no Wine).
 *
 *   deno task image-pack <extract-dir> [zip-path]
 *
 * Default zip: <extract-dir>/penpad-image-pack-clinergy-1998.zip
 * The zip is a local study copy and must not be committed or published.
 */
import { writeImagePack, defaultZipPath } from "./image-pack.ts";

const USAGE = "usage: deno task image-pack <extract-dir> [zip-path]";

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length < 1 || argv.length > 2) {
    console.error(USAGE);
    return argv.includes("-h") || argv.includes("--help") ? 0 : 2;
  }
  const extractDir = argv[0];
  const zipPath = argv[1] ?? defaultZipPath(extractDir);
  const result = await writeImagePack(extractDir, { zipPath });
  console.error(
    `Wrote image pack ${result.zipPath} (${result.imageCount} images, ${result.mapCount} maps). ` +
      "Local study copy: do not commit, publish, or redistribute.",
  );
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (e) {
    console.error(`image-pack: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}
