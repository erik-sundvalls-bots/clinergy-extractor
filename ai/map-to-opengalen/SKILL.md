---
name: map-to-opengalen
description: Review the Clinergy -> OpenGALEN 8 mapping worklist written by clinergy-to-opengalen.ts, using the read-only OpenGALEN MCP server (mcp/opengalen-mcp.ts) to find, check and justify a mapping for each name, and write the results to a reviewed-mappings YAML file. Use when asked to map, review or improve Clinergy-to-OpenGALEN mappings.
---

# Map Clinergy names to OpenGALEN 8

Clinergy (1998) adapted a GALEN Common Reference Model, so about a third of its names exist unchanged in OpenGALEN 8.
Those are already in `map/mappings.yaml`. Your job is the rest, in `map/worklist/*.yaml`. Decide what each name means in
Clinergy, then find the OpenGALEN 8 entity with the same meaning, or record that there is none.

## Inputs

- `map/worklist/<kind>.yaml`: one entry per Clinergy name. The kinds are formTopic, exam, descriptor, criterialLink,
  value and concept. Each entry carries context from the Clinergy model:
  - `display`: the user-facing text;
  - `category`, `summaryType`, `supers`: its Clinergy parents;
  - `location`;
  - `usedInForms` and `valueSets`, for descriptors;
  - `usedAsValueOf`, for values: the feature it fills, its sibling values and how many forms use it;
  - `sentenceWords` and `adverb`: the noun and adjective used in generated sentences;
  - `examGroup`, `baseSign` and `baseLocation`, for exams.
- `unverifiedHints`: lexical look-alikes only. Treat them as search ideas, never as answers.
- The Clinergy form files `forms/<category>/<Topic>.yaml` and `concepts.yaml`, when you need more context.
- The OpenGALEN MCP tools: `search_concepts`, `get_concept`, `get_ancestors` and `check_names`.

## Procedure, per name

1. **Understand the Clinergy name first.** Read the display text, the supers and where the name is used. A value's
   meaning comes from its feature and siblings: `mild` next to `moderate` and `severe` under a severity descriptor is a
   degree of severity.
2. **Decide which OpenGALEN kind you need.**

   | Clinergy role                                  | Usual OpenGALEN counterpart                                                                                                                                                                                                                           |
   | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Form topic (symptom, sign, disease, procedure) | Class under the matching top category (e.g. `Pain`, `Symptom`, `Sign`), often named in GALEN style without the Clinergy suffix (an `ElbowAcheSymptom` topic would point to `ElbowPain`, a child of `Pain`)                                            |
   | Descriptor (feature)                           | An attribute (`ObjectProperty`, e.g. `hasSeverity`) together with the modifier class for its value range (e.g. `Severity`). Give the property as `opengalen` and the class in the rationale, or the reverse if the descriptor is plainly a value type |
   | Value                                          | A modifier class or individual under the descriptor's value range (e.g. a subclass of `Severity`)                                                                                                                                                     |
   | Exam                                           | An examination class (e.g. under `ExaminationAct`)                                                                                                                                                                                                    |
   | Criterial link                                 | An `ObjectProperty`                                                                                                                                                                                                                                   |

3. **Search.** Call `search_concepts` with the display words, with the CamelCase parts and with synonyms (British and
   American spellings are folded already). For values, restrict by meaning: look at the children of the value range you
   expect (`get_concept` on `Severity` lists its named children).
4. **Check each candidate's semantics** with `get_concept` (parents, definition axioms, sanctions) and `get_ancestors`:
   - The ancestors must fit the Clinergy role. A severity value must descend from `Severity` or a similar modifier, not
     from a disease or a mood. `MildSadness` shares the word "mild" but is a mood state, so it is wrong for `mild`.
     `MildSeverity` (`Severity` with a low level) is right.
   - The definition must not add or drop meaning. An elbow ache is not just `Pain`. If only a broader concept exists, it
     may be used with confidence `low` and a rationale that says it is broader.
   - Sanctions (`sanctions` in `get_concept`) show which attributes a class accepts. Use them to check that a
     descriptor's property applies to the form's topic.
5. **Verify the name exists.** Before writing anything, call `check_names` on every OpenGALEN name you are about to
   record. Copy names exactly: they are case-sensitive. Never write a name the tools have not returned. Never build a
   compositional name such as `PainwhichhasLocationThumb` yourself, even when one seems obvious. If no single entity
   fits, record `opengalen: null` and describe the composition in the rationale.
6. **Write the result** to a reviewed file, e.g. `map/reviewed.yaml`. Keep entries already there; one entry per Clinergy
   name:

   ```yaml
   mild:
     opengalen: MildSeverity
     confidence: high # high | medium | low
     rationale: "Value of the severity descriptor (siblings moderate, severe). MildSeverity is Severity with a low level (get_concept: hasQuantity LevelwhichhasMagnitudelowLevel); ancestors Severity > DiseaseFeature. Hint MildSadness rejected: a mood state (parent DepressedMoodSymptom)."
     needsHumanReview: true
   ThumbAcheSymptom: # illustrative name
     opengalen: null
     confidence: medium
     rationale: "No named class (search_concepts 'thumb pain': none). Composition Pain + hasLocation Thumb (all three exist) left for the expression work in issue #4."
     needsHumanReview: true
   ```

   - Set `needsHumanReview: true` unless the match is unambiguous and the ancestors confirm it.
   - The rationale must cite what the tools showed (parents, definition) and why the hints were rejected.
7. **Merge and check.** Run `deno task map out/ <opengalen-source> map/ --reviewed map/reviewed.yaml`. The preprocessor
   re-checks every name against the release. Any entry under `reviewedRejected` in `map/summary.yaml` is an error you
   must fix. Accepted entries move from the worklist into `mappings.yaml` with method `reviewed`. Add `--annotate` to
   copy the verified mappings into the form files.

## Rules

- Never invent concept names, IRIs, definitions or sources. Everything you claim about OpenGALEN must come from a tool
  result in this session.
- Lexical similarity is not evidence. Ancestors and definitions are.
- Work in batches by kind: descriptors first, then their values, then topics. The descriptor decision constrains the
  values.
- The Clinergy content is © 1997-8 Semantic Technologies Ltd / Victoria University of Manchester and private. Do not
  paste worklist or reviewed content into public places (issues, PRs, chats) unless the owner says so.
