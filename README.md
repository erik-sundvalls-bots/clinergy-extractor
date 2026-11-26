# clinergy-extractor

Turns your own copy of `ClinergyDemo.zip`, the 1998 demo of the Clinergy / PEN&PAD structured data-entry system, into a
tree of human-readable YAML files, one per data-entry form. It also includes tools to map Clinergy names to OpenGALEN 8
(a deterministic preprocessor, a read-only OpenGALEN MCP server and an AI-agent skill), and a script that installs and
runs the demo itself under Wine.

A live [experimental workbench](https://erik-sundvalls-bots.github.io/penpad-clinergy-workbench/) uses this repo's
sentence generator and openEHR builder: fill a Clinergy-like thumb pain form in the browser and watch English and
Swedish summary sentences, OpenGALEN bindings, and openEHR output update as you click. Nothing is installed and nothing
is saved on a server.

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

| Option               | Meaning                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--wine-prefix DIR`  | use or create this Wine prefix                                                                                                                                                                                                                              |
| `--wine-arch win64`  | for Wine builds that cannot make 32-bit prefixes (untested)                                                                                                                                                                                                 |
| `--probe-exe FILE`   | use a prebuilt `probe.exe` instead of compiling `probe/probe.c`                                                                                                                                                                                             |
| `--dumps DIR`        | skip Wine and parse dumps that `probe.exe` already wrote, e.g. on Windows: `probe.exe <dir>\model <outdir>`                                                                                                                                                 |
| `--verbose`          | show Wine and compiler output                                                                                                                                                                                                                               |
| `--fhir`             | also write FHIR Questionnaires under `out/fhir/` (opt-in; see below). Default extract stays YAML only.                                                                                                                                                      |
| `--image-pack`       | also write `<out>/penpad-image-pack-clinergy-1998.zip`, a swappable image pack (pictures + hotspot config) for the remake web app. Local study copy: do not commit or publish. The pack format is documented in the workbench repo at `docs/image-pack.md`. |
| `--image-pack-out P` | write that pack zip to `P` (implies `--image-pack`).                                                                                                                                                                                                        |

From an existing extract tree, without re-running Wine:

```sh
deno task image-pack out/clinergy-extract-out
# → out/clinergy-extract-out/penpad-image-pack-clinergy-1998.zip
```

Upload the zip in the remake UI, or unpack it into `remake/local-originals/` and open the remake with `?images=local`.
The zip is gitignored (`*.zip`, `out/`).

## Output

```
out/
  README.md                         provenance, copyright notice, field guide
  model.yaml                        model version, counts, global lists
  forms/<category>/<Topic>.yaml     one data-entry form per topic (symptom, sign, disease, ...)
  forms/index.yaml                  topic -> form file, display text, category
  concepts.yaml                     every named concept: ids, display text, category, supertypes, form path, visible
                                    features, laterality and sub-locations
  concept-links.yaml                raw per-concept engine query results (links, sanctions), for concepts that have any
  exams.yaml                        examination tree (root, system, location, sub)
  sentence-rules.yaml               descriptor precedences and per-value word forms, value precedences, summary types,
                                    lexicon (noun/adjective/negative forms and adverbs, heuristic)
  bodymap.yaml                      body-map click areas and selector buttons, per INI file
  topic-lists.yaml                  quick-pick lists
  search-space.yaml                 type-ahead search index
  images.yaml                       every picture and icon found: source, resource id, size, what it is used for
  images/bodymap/                   body-map pictures and close-ups (PNG), linked from bodymap.yaml
  images/buttons/                   selector buttons (body-system filters)
  images/bitmaps/                   other loose bitmaps (banner, tab buttons, installer pictures, VB form pictures)
  images/resources/<module>/        RT_BITMAP resources of the EXEs, DLLs and OCXs (e.g. the toolbar strip)
  images/icons/<module>/            icons and cursors: the original .ico/.cur plus one PNG per size
  images/metafiles/<module>/        Windows metafile resources, kept as .wmf (not converted)
```

Every YAML file starts with a comment header that says what it is, where it came from and who holds the rights. A form
file lists `firstLayer` (shown when the form opens) and `moreLayer` (behind the `>>` button) in order. Each item has its
curated values and an `inheritance` flag that compares it with the nearest supertype that has its own rows. The file
then lists associated symptoms and signs, diagnoses and examinations. Its `concept:` key (`concepts.yaml#<Name>`) and
exam names point into the lookup files. For the 1998 demo there are 2,121 forms, 7,442 visible items on 2,057 concepts,
230 exams and 222 sentence-rule descriptors, in 2,132 YAML files (about 20 MB). The largest files are
`concept-links.yaml` (5.6 MB) and `concepts.yaml` (3.4 MB). Forms are 1 to 7 KB each.

### Images

Every image in the zip is converted to PNG with our own decoders and encoder (`src/bmp.ts`, `src/png.ts`,
`src/resources.ts`, `src/images.ts`; no external tools). That covers:

- loose bitmaps, found by content, so the `.jk` and `.hf` files that are bitmaps are included;
- `RT_BITMAP`, `RT_GROUP_ICON` and `RT_GROUP_CURSOR` resources in 32-bit PE and 16-bit NE executables, including the
  installer's `_SETUP.LIB`;
- icons stored in Visual Basic form data (`.frx` and compiled VB programs).

Bitmap rows are flipped from the BMP bottom-up order, and icon AND masks become transparency. For the 1998 demo that is
455 images in 625 files:

| Kind                                         | Count |
| -------------------------------------------- | ----- |
| Loose bitmaps (Compdata, installer, VB form) | 126   |
| Bitmap resources                             | 191   |
| Icon groups                                  | 48    |
| Cursor groups                                | 66    |
| Metafiles (`.wmf`, in `GRAPH32.OCX`)         | 24    |

The 24 metafiles are vector graphics and are kept as they are. Not covered: `_INST32I.EX_`, InstallShield's own
compressed engine, whose format we don't read.

In `bodymap.yaml`, each location's `inset`, each map's `mainGraphics` picture and each selector button now has its PNG
path (`insetImage`, `image`, `bitmapImages`). Hotspots are `[top, bottom, left, right]` in pixels of the picture being
clicked. A map's locations are on its main picture (e.g. `M_main.png`, 240×330). A location's sublocations are on its
close-up (e.g. the hand close-up `B_fhnd.png`, 96×152, with the thumb and fingers). This was checked by drawing the
hotspots on the extracted pictures. `insetRect` is `[left, top, width, height]` in the selector's graphic window.

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

## Mapping to OpenGALEN 8

The 1998 model adapted a GALEN Common Reference Model, so about a third of its names exist unchanged in OpenGALEN 8.
Matching the rest needs judgement: `mild` looks like `MildSadness` but means `MildSeverity`. That judgement is split
from the mechanical work.

1. **Preprocess** (deterministic):

   ```sh
   deno task map out/ opengalen8-owl-sources.zip map/
   ```

   Download the OpenGALEN 8 OWL release from <https://opengalen.eggbird.eu/download/opengalen8-owl-sources.zip>, listed
   on [the sources page](https://opengalen.eggbird.eu/sources/sources.html). You can pass the zip, its unpacked folder,
   or one `.owl` or `.dump` file. It writes:
   - `map/mappings.yaml`: verified mappings only. `exact` means an identical name. `normalised` means the only name that
     is equal after ignoring case and punctuation, dropping a `NAMED` prefix and folding spelling variants (ae/e, oe/e,
     -isation/-ization, -our/-or, -ant/-ent, plurals); these are flagged `needsHumanReview`.
   - `map/worklist/<kind>.yaml`: every other name (form topics, exams, descriptors, criterial links, values, other
     concepts). Each entry carries its context from the model: display text, category, supertypes, the forms and
     features that use it, sibling values, sentence words. It also has up to 5 `unverifiedHints`, which are lexical
     look-alikes and not mappings.
   - `map/summary.yaml`: counts.

   For the 1998 demo, 2,663 of 8,142 names match exactly and 98 after normalisation; 5,381 go to the worklist.
2. **Review** the worklist, by hand or with an AI agent. The agent follows the skill in
   [`ai/map-to-opengalen/SKILL.md`](ai/map-to-opengalen/SKILL.md) and uses the OpenGALEN MCP server below. It writes its
   decisions to a reviewed file, e.g. `map/reviewed.yaml`, with a confidence, a rationale and `needsHumanReview` for
   each entry. It must never invent names.
3. **Merge and annotate**:

   ```sh
   deno task map out/ opengalen8-owl-sources.zip map/ --reviewed map/reviewed.yaml --annotate
   ```

   Every reviewed OpenGALEN name is checked against the release. Unknown names are rejected and listed in
   `summary.yaml`. Accepted entries move to `mappings.yaml` with method `reviewed`. `--annotate` appends an `opengalen:`
   block to each form, with verified and reviewed mappings only and no guesses. Re-running replaces the block.

OpenGALEN content is under the GALEN Open Source License.

### OpenGALEN MCP server

`mcp/opengalen-mcp.ts` is a small, read-only [MCP](https://modelcontextprotocol.io/) server (stdio transport). It reads
the public OWL release directly: loading takes about 2 s and 0.5 GB RAM. It has four tools (the browser link points to
the [OpenGALEN browser](https://pen-pad-revival.github.io/opengalen-browser/)):

| Tool              | Returns                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `search_concepts` | names and labels containing all query words (CamelCase split, spelling folded); generated names on request |
| `get_concept`     | kind, IRI, parents, named children, equivalents, definition, sanctions, annotations, browser link          |
| `get_ancestors`   | all ancestors with their distance                                                                          |
| `check_names`     | whether names exist (exact, case-sensitive), for verifying mappings                                        |

The hierarchy comes from the dump without property chains, because the with-chains dumps contain known inversions. To
use the server, add it to your MCP client's configuration (e.g. `mcp.json` or `claude_desktop_config.json`), together
with the skill:

```json
{
  "mcpServers": {
    "opengalen": {
      "command": "deno",
      "args": [
        "run",
        "--allow-read",
        "--allow-env",
        "/path/to/clinergy-extractor/mcp/opengalen-mcp.ts",
        "--source",
        "/path/to/opengalen8-owl-sources.zip"
      ]
    }
  }
}
```

Then put `ai/map-to-opengalen/` where your agent finds skills, or paste its `SKILL.md` into the prompt. Then ask it to
work through `map/worklist/descriptor.yaml`.

## Running the demo under Wine

`clinergy-wine.ts` installs the demo into a 32-bit Wine prefix without its installer, then starts it:

```sh
deno run -A clinergy-wine.ts install ClinergyDemo.zip   # prefix: ~/.cache/clinergy-extractor/wine-clinergy (--prefix DIR)
deno run -A clinergy-wine.ts demo                       # start Pen&Pad, load the model, open the Symptom Selector
```

What it does, all found by trial with Wine 10.0:

- It creates a 32-bit prefix (`WINEARCH=win32`) that reports Windows XP.
- `SETUP.EXE` is a 16-bit InstallShield 3 launcher, so the payload is unpacked directly. Programs and runtime DLLs go to
  `C:\Clinergy\Programs`. Model, INI and bitmap files go to `C:\Clinergy\Compdata\{archive,ini,bmp}`. `Penpad.ini` goes
  to `C:\windows` (it sets `WorkDir=C:\clinergy\compdata`).
- It uses the bundled `Mfc42.dll` but not the bundled 1997 `Msvcrt.dll`:
  `WINEDLLOVERRIDES="mscoree,mshtml,winemenubuilder.exe=d;mfc42,mfc42u=n;msvcrt=b"`.
- `penpad.exe` runs from `C:\Clinergy\Programs`. _Load model_ takes the name `model`, which the engine resolves in
  `Compdata\archive`.
- The frame window's menu bar does not appear under Wine, so `demo` uses our helper `wine/ppctl.c` to send the menu
  commands: `WM_COMMAND` 32771 = Load model, 32772 = Symptom Selector. After that, the body map, topic lists, forms and
  the sentence summary work with the mouse.
- Not working in this setup: the host demos (`VB Demo`, `Gen Demo`, `Win Demo`). They drive Pen&Pad through its
  `PENPAD.CONNECT` OLE automation server and expect the VB4 runtime and a patient database, `penpad.mdb`, that is not in
  the zip.

## Summary sentences

`src/sentence.ts` turns a structured finding into one English summary sentence. `render(finding, knowledge)` does no
I/O. The knowledge is the extractor output: `sentence-rules.yaml` (one file, with `descriptors`, `valuePrecedences`,
`summaryTypes` and `lexicon`), `concepts.yaml` and `concept-links.yaml` (locative links such as `in Thumb` supply the
preposition).

```sh
deno task sentence out/ finding.yaml
```

`finding.yaml` is one finding, a list of findings, or a list of `{ finding }` wrappers:

```yaml
topic: ThumbPainSymptom
location: Thumb
laterality: right # left | right
subLocation: DistalPhalanx # optional
summary: presence # rendered via the topic's summary type, e.g. hasClinicalAbsence
qualifiers:
  - descriptor: Severity
    value: moderate
  - descriptor: Duration
    value: week
    number: 2
    unit: week
```

Rules come from the extracted YAML: descriptor `precedence` (a higher value sits closer to the topic), and per value the
`valueForm`, `descriptorForm`, `order` and `position`. The summary value is rendered as the descriptor named in that
topic's summary type (`AbsentPresent: { hasClinicalAbsence presence }` in the synthetic model). A pre-coordinated topic
whose display already starts with the location ("thumb pain") stays in that short form until a laterality or a
sub-location needs the prepositional form ("Pain in right thumb"). Missing lexicon entries fall back (an adverb becomes
the display plus `-ly`) and `renderReport` lists them.

The checked example is the public
[thumb-pain walkthrough](https://pen-pad-revival.github.io/docs/clinergy-thumb-pain-demo/).
`tests/fixtures/thumb-pain/extract/` is laid out like an extractor `out/` directory: synthetic rules and findings we
wrote so that walkthrough's summary lines come back out. It is not named `out/`, because `.gitignore` ignores every
`out/` directory. It is not a Clinergy extract: no model files, and the only Clinergy strings in it are concept keys.
Which of those lines is public UI text, and which keys we invented, is noted at the top of the fixture. Real extracts
stay out of the repo.

The [experimental workbench](https://erik-sundvalls-bots.github.io/penpad-clinergy-workbench/) vendors this sentence
generator and shows the English and Swedish summaries live as you fill that same form.

## openEHR

`src/openehr.ts` turns the same findings into a canonical JSON COMPOSITION and the FLAT form of
`templates/thumb-pain.webtemplate.json`. The composition is `COMPOSITION.encounter.v1` (category `433` event) holding
`OBSERVATION.story.v1`, and each finding is a `CLUSTER.symptom_sign.v2` with a `CLUSTER.anatomical_location.v1` in the
structured body-site slot. Paths and at-codes are in `mappings/openehr.yaml`, copied from the published CKM archetypes
named there.

```sh
deno task openehr out/ finding.yaml --opengalen map/mappings.yaml
```

OpenGALEN names are taken only from a verified `mappings.yaml` (`exact`, `normalised` or `reviewed`). Worklist hints are
ignored. Keys with no such mapping are printed as unmapped. The checked thumb-pain case binds `Thumb` and
`DistalPhalanx`, which are identical names of classes in OpenGALEN 8; the other fixture keys are reported unmapped.
`CLUSTER.exam.v2` is not in this template. Validating against an EHRbase is optional: set `EHRBASE_URL` and the ignored
test in `tests/openehr_test.ts` runs. CI checks the composition against the web template locally.

The same [experimental workbench](https://erik-sundvalls-bots.github.io/penpad-clinergy-workbench/) vendors this builder
and updates the openEHR canonical JSON and FLAT as you click.

## SNOMED CT expressions

`src/snomed.ts` turns the same findings into SNOMED CT post-coordinated expressions in compositional grammar. Concept
and attribute ids come only from the reviewed map `mappings/snomed.yaml`. Rows that are not `verified: true` are never
written into an expression; unmapped parts are listed instead of being dropped.

```sh
deno task snomed finding.yaml
```

The checked case is the public thumb-pain walkthrough, using `tests/fixtures/thumb-pain/findings.yaml`. Laterality is
applied to the body structure (`272741003 |Laterality|` is a body-structure attribute in the MRCM, not a
clinical-finding attribute). Finding site, severity and clinical course are grouped as the SNOMED CT Editorial Guide
requires. Clinical course is the attribute for onset; clinical finding has no duration attribute, so a numeric duration
such as 2 weeks is reported unmapped and is not written into the expression.

`ThumbPainSymptom` has a verified precoordinated concept, `300955002 |Pain in thumb|`. `ThumbSwellingSymptom` does not;
the map records that and uses `65124004 |Swelling|` as the focus, with the site added from the finding.

Optional validation against a terminology server runs only when an endpoint is configured (the same pattern as EHRbase
for openEHR):

```sh
SNOMED_FHIR_URL=https://tx-nordics.fhir.org/fhir/r4 deno task snomed finding.yaml --validate
# or
SNOWSTORM_URL=https://your-snowstorm.example/snowstorm/snomed-ct deno task snomed finding.yaml --validate
```

`--validate` looks up each concept id (`CodeSystem/$validate-code` or Snowstorm `browser/{branch}/concepts/{id}`). Full
expression/MRCM validation is used when the server accepts a compositional-grammar code; otherwise the CLI reports that
only the ids were checked, and tests still assert local syntax and the reviewed MRCM grouping.

The workbench already shows verified pre-coordinated SNOMED codes in its bindings table. Showing these post-coordinated
expressions there is a follow-up; this repo does not change the workbench.

## FHIR Questionnaire and Symptoms IG

`src/fhir.ts` reads the per-form YAML already written by an extract and builds a draft FHIR R4 SDC `Questionnaire` for
each form, plus (when you pass findings) a `QuestionnaireResponse` and
[Symptom Logical Model](https://build.fhir.org/ig/HL7/fhir-symptoms-ig/en/StructureDefinition-SymptomLogicalModel.html)
instances. This is opt-in. A default extract still writes YAML only.

```sh
deno task fhir out/                                      # Questionnaires for every form in out/forms/
deno task fhir out/ --findings finding.yaml              # plus responses and symptoms.json
deno task extract ClinergyDemo.zip out/ --fhir           # chain after a successful extract
```

Output goes to `out/fhir/` by default (`--dest DIR` to override): one `<category>/<Topic>.questionnaire.json` per form,
optional numbered responses, `symptoms.json`, and `summary.json` with counts, uncoded items and mapping gaps. Generated
files from a private Clinergy extract stay private and must not be committed.

Codes are written only from a verified OpenGALEN `mappings.yaml` (`--opengalen`, default `out/../map/mappings.yaml` when
that file exists) or a reviewed SNOMED map (`--snomed`, default `mappings/snomed.yaml` when present). Everything else
stays as display text and is listed as uncoded. Don't guess codes.

Descriptor mapping for the Symptom Logical Model: topic → `symptomCode`; present/absent → `presentFlag`; location,
laterality and sub-location → `keyFeatures.location`; character / consistency / texture → `keyFeatures.quality`;
severity → `keyFeatures.severity`; frequency → `keyFeatures.frequency.quality`; onset → `timing.speedOfOnset`; duration
→ `timing.duration`; progress → `trend`; pattern → `clinicalCourse`; the English summary sentence →
`symptomDescription`. Gaps are listed: there is no calendar onset, frequency is qualitative only, the model has no
examination slot, and `reporter[x]` is left unset because a finding has no reporter and the model only allows a patient
or a related person.

The [experimental workbench](https://erik-sundvalls-bots.github.io/penpad-clinergy-workbench/) already does a runtime
export for the public thumb-pain form. This command is the extractor-side, all-forms version of that work (issues #7 and
#8).

## Tests

```sh
deno task test                                       # synthetic fixtures only
CLINERGY_ZIP=/path/to/ClinergyDemo.zip deno task test  # also the full run on the real demo (needs Wine)
```

Sentences against a real extract (the expected lines stay in a file you supply, not in the repo):

```sh
# out/ already produced by `deno task extract`:
CLINERGY_OUT=/path/to/out \
CLINERGY_SENTENCE_EXPECTATIONS=/path/to/expectations.yaml \
  deno test -A tests/sentence_test.ts

# or extract from the zip first (needs Wine), then render:
CLINERGY_ZIP=/path/to/ClinergyDemo.zip \
CLINERGY_SENTENCE_EXPECTATIONS=/path/to/expectations.yaml \
  deno test -A tests/sentence_test.ts
```

`CLINERGY_OUT` wins when both it and `CLINERGY_ZIP` are set. The expectations file is a list (or `{ cases: [...] }`):

```yaml
- expected: "the sentence the engine showed"
  finding:
    topic: ThumbPainSymptom
    location: Thumb
    laterality: right
    qualifiers: []
```

Use the concept keys from that extract. A case may set `lang: sv` (or a path to a pack). `en` and a missing `lang` use
the extracted English lexicon, which is what a real extract needs. Swedish expectations for a real extract are a
separate file:

```sh
CLINERGY_OUT=/path/to/out \
CLINERGY_SENTENCE_EXPECTATIONS_SV=/path/to/expectations-sv.yaml \
  deno test -A tests/language_test.ts
```

## Other languages

`render(finding, knowledge, lang)` takes a language pack. `lang/en.yaml` and `lang/sv.yaml` are ours: English repeats
the synthetic fixture's words, Swedish is our translation and has not had a native-speaker review. Rules (precedence,
position, order) stay in the extractor YAML. The pack holds the lexicon, en/ett/plural/definite agreement, adverb
formation (`-t`), prepositions (including a choice by location type) and location-slot order. A missing entry is
reported by `renderReport` and the concept key is used.

```sh
deno task sentence out/ finding.yaml --lang sv
```

## Credits and licence

Apache-2.0, see `LICENSE`. The DCL decoder follows the format described in zlib's `contrib/blast/blast.c` by Mark Adler,
which is under the zlib licence. The InstallShield 3 layout follows the documentation in Philippe Valembois'
[idecomp](https://github.com/lephilousophe/idecomp). No code was copied from either. Part of the
[PEN&PAD revival](https://pen-pad-revival.github.io/) project.

SNOMED CT is used under a national member licence (Sweden, via the Swedish eHealth Agency). This repository is not a
distribution of the SNOMED CT corpus. `mappings/snomed.yaml` and the tests hold a small set of identifiers and preferred
terms for the public thumb-pain demo only, checked against SNOMED CT International edition 20260801 on the HL7 Nordics
FHIR terminology server. Using SNOMED CT requires an affiliate or national member licence. SNOMED CT is a registered
trademark of SNOMED International.
