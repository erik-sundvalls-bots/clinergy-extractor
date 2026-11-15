# clinergy-extractor

Turns your own copy of `ClinergyDemo.zip`, the 1998 demo of the Clinergy / PEN&PAD structured data-entry system, into a
tree of human-readable YAML files. It also includes a helper that suggests OpenGALEN 8 names for the Clinergy names.

This repository contains **only our own code**. It contains no Clinergy program code, model files or extracted content.
The demo's content is © 1997-8 Semantic Technologies Ltd / Victoria University of Manchester, All Rights Reserved. The
YAML you generate stays a private study copy: don't publish or redistribute it without the rights holders' permission.
The tests use synthetic data only.

## Get the demo

`ClinergyDemo.zip` (5,973,054 bytes, sha256 `f138c38b24de630ce0c89bc8018dbc68fc2b17e040235c9c01e10761d8114270`):

- OpenGALEN mirror: <https://opengalen.eggbird.eu/download/ClinergyDemo.zip>, linked from
  [the software page](https://opengalen.eggbird.eu/sources/software.html)
- Internet Archive copy of the original opengalen.org file (August 2007):
  <https://web.archive.org/web/20070818150258/http://www.opengalen.org/download/clinergydemo.zip>

## Prerequisites

- [Deno](https://deno.com/) 2.x
- Wine with 32-bit support, plus the 32-bit MinGW cross compiler. On Debian or Ubuntu:
  ```sh
  sudo dpkg --add-architecture i386 && sudo apt update
  sudo apt install wine wine32 gcc-mingw-w64-i686
  ```
  Tested with Wine 10.0 and gcc-mingw-w64-i686 14.2 on Debian. No display is needed.

## Run

```sh
deno task extract ClinergyDemo.zip out/      # = deno run -A clinergy-extract.ts ClinergyDemo.zip out/
```

The first run creates a Wine prefix in `~/.cache/clinergy-extractor/wine-win32`, which takes a few seconds. A whole run
takes about 15 seconds. Options:

| Option              | Meaning                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--wine-prefix DIR` | use or create this Wine prefix                                                                              |
| `--wine-arch win64` | for Wine builds that cannot make 32-bit prefixes (untested)                                                 |
| `--probe-exe FILE`  | use a prebuilt `probe.exe` instead of compiling `probe/probe.c`                                             |
| `--dumps DIR`       | skip Wine and parse dumps that `probe.exe` already wrote, e.g. on Windows: `probe.exe <dir>\model <outdir>` |
| `--verbose`         | show Wine and compiler output                                                                               |

## Output

```
out/
  README.md                         provenance and copyright notice
  model.yaml                        model version, counts, global lists
  forms/<category>/<Topic>.yaml     one data-entry form per topic (symptom, sign, disease, ...)
  concepts/<A-Z>/<Name>.yaml        every named concept: ids, display text, supertypes, all per-concept query results
  exams/<group>/<Exam>.yaml         examination tree (root, system, location, sub)
  sentence-rules/                   descriptor precedences, per-value word forms, value precedences, summary types,
                                    lexicon.yaml (noun/adjective/negative forms and adverbs, heuristic)
  bodymap/<file>.yaml               body-map click areas and selector buttons from the INI files
  topic-lists/<file>.yaml           quick-pick lists
  search/search-space.yaml          type-ahead search index
  */index.yaml                      indexes with file paths
```

Every YAML file starts with a comment header that says what it is, where it came from and who holds the rights. A form
file lists `firstLayer` (shown when the form opens) and `moreLayer` (behind the `>>` button) in order. Each item has its
curated values and an `inheritance` flag that compares it with the nearest supertype that has its own rows. The file
then lists associated symptoms and signs, diagnoses and examinations. For the 1998 demo the tree has 2,121 forms, 7,442
visible items on 2,057 concepts, 230 exams and 222 sentence-rule descriptors, in about 10,300 files.

## How it works, and why

1. **Unpacking** happens in TypeScript and needs no external tools. `src/zip.ts` reads the ZIP file.
   `src/installshield3.ts` reads the InstallShield 3 split archive `_SETUP.1`…`_SETUP.5`. `src/explode.ts` decompresses
   the PKWARE DCL "implode" data, using the algorithm from Mark Adler's `blast.c`. The installer itself never runs.
2. **The model files** (`Model.*28`) use an undocumented binary format. Rather than reverse-engineer it, `src/wine.ts`
   copies the demo's own `TermEng.dll` and the model into a Wine prefix. It then builds and runs `probe/probe.c`, our
   small Win32 program that asks the 1998 engine to export its knowledge: visibility, language rules, values, search
   space, permanent ids, plus per-concept and per-exam queries. This gives the engine's own view of the model and avoids
   guessing at its format.
3. **Parsing and assembly** in `src/parse.ts` and `src/knowledge.ts` turn the text dumps and INI files into forms.
   `src/lexicon.ts` adds word forms that the exporters do not write out. It finds them with a heuristic scan of the
   model files, so they are marked for review.
4. **Writing** is done by `src/write.ts` with a small YAML emitter, `src/yaml.ts`, that keeps short lists on one line.

## OpenGALEN 8 name mapping

```sh
deno task map out/ opengalen8-owl-sources.zip map/ --annotate
```

Download the OpenGALEN 8 OWL release from <https://opengalen.eggbird.eu/download/opengalen8-owl-sources.zip>, listed on
[the sources page](https://opengalen.eggbird.eu/sources/sources.html). You can pass the zip as is, its unpacked folder,
or a single `.owl` or `.dump` file. The tool reads every class and property declared in the OWL Functional-syntax files,
plus the classified hierarchy dump. Each Clinergy name then gets one status:

| Status       | Meaning                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact`      | the identical name exists in OpenGALEN 8. This is the only status that counts as a mapping.                                                                                                        |
| `normalised` | the names are equal after ignoring case and punctuation, dropping a `NAMED` prefix and allowing for spelling variants (ae/e, oe/e, -isation/-ization, -our/-or, -ant/-ent, plurals). Needs review. |
| `candidate`  | up to 5 suggestions, ranked by weighted token overlap (Dice score 0–1). Needs review.                                                                                                              |
| `unmapped`   | nothing scored above `--min-score`, which defaults to 0.5.                                                                                                                                         |

It writes `map/summary.yaml` (coverage per kind of name), `map/index.yaml` and one file per name in
`map/names/<A-Z>/<Name>.yaml`. With `--annotate`, an `opengalen:` block is appended to each form file, and re-running
replaces it. For the 1998 demo, 2,651 of 7,687 concept names (34.5 %) match exactly, including 274 of the 2,121 form
topics. OpenGALEN content is under the GALEN Open Source License.

## Tests

```sh
deno task test                                       # synthetic fixtures only
CLINERGY_ZIP=/path/to/ClinergyDemo.zip deno task test  # also the full run on the real demo (needs Wine)
```

## Credits and licence

Apache-2.0, see `LICENSE`. The DCL decoder follows the format described in zlib's `contrib/blast/blast.c` by Mark Adler,
which is under the zlib licence. The InstallShield 3 layout follows the documentation in Philippe Valembois'
[idecomp](https://github.com/lephilousophe/idecomp). No code was copied from either. Part of the
[PEN&PAD revival](https://pen-pad-revival.github.io/) project.
