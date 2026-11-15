// A tiny, invented OpenGALEN-style release for tests (no real release content).
import { buildZip } from "./helpers.ts";

const I = (n: string) => `<http://www.opengalen.org/owl/opengalen.owl#${n}>`;
const decl = (k: string, n: string) => `Declaration(${k}(${I(n)}))`;

export const OWL = [
  "Prefix(:=<http://www.opengalen.org/owl/opengalen.owl#>)",
  "Ontology(<http://www.opengalen.org/owl/opengalen.owl>",
  ...[
    "TopCategory",
    "Phenomenon",
    "Feature",
    "Severity",
    "SlightSeverity",
    "StrongSeverity",
    "Mood",
    "SlightSadness",
    "ElbowAcheSymptom",
    "NAMEDElbow",
    "Oedema",
    "Pain",
    "PainwhichhasLocationElbow",
  ].map((n) => decl("Class", n)),
  decl("ObjectProperty", "Attribute"),
  decl("ObjectProperty", "hasSeverity"),
  `AnnotationAssertion(rdfs:label ${I("hasSeverity")} "has severity"^^xsd:string)`,
  `AnnotationAssertion(${I("S-SANCTION-hasSeverityAP")} ${I("Pain")} "Severity"^^xsd:string)`,
  `AnnotationAssertion(${I("SANCTION-LEVELAP")} ${I("Pain")} "GRAMMATICAL"^^xsd:string)`,
  `SubClassOf(${I("Severity")} ${I("Feature")})`,
  `EquivalentClasses(${I("SlightSeverity")} ObjectIntersectionOf(${I("Severity")} ObjectSomeValuesFrom(${
    I("hasSeverity")
  } ${I("Feature")})))`,
  `SubClassOf(${I("PainwhichhasLocationElbow")} ${I("Pain")})`,
  `SubObjectPropertyOf(${I("hasSeverity")} ${I("Attribute")})`,
  ")",
].join("\n");

export const DUMP = [
  ";; invented test dump",
  "(implies Phenomenon TopCategory)",
  "(implies Feature Phenomenon)",
  "(implies Severity Feature)",
  "(implies SlightSeverity Severity)",
  "(implies StrongSeverity Severity)",
  "(implies Mood Phenomenon)",
  "(implies SlightSadness Mood)",
  "(implies Pain Phenomenon)",
  "(implies ElbowAcheSymptom Pain)",
  "(implies PainwhichhasLocationElbow Pain)",
  "(implies NAMEDElbow TopCategory)",
  "(implies Oedema Phenomenon)",
  "(equivalent ElbowAcheSymptom ElbowAche2)",
  "",
].join("\n");

export const DUMP_NAME = "OpenGALEN8_WithoutPropertyChains_CRM+Diseases+SurgicalProcedures+DrugOntology.dump";

/** Write the fixture as a release-shaped zip (with an RDF copy that must be ignored). */
export async function writeOgZip(path: string) {
  const enc = new TextEncoder();
  await Deno.writeFile(
    path,
    await buildZip({
      "OpenGALEN8/OWL_Sources/OWL-F/test.owl": enc.encode(OWL),
      "OpenGALEN8/OWL_Sources/RDF/test.owl": enc.encode(decl("Class", "OnlyInRdf")),
      [`OpenGALEN8/Hierarchy_Dumps/${DUMP_NAME}`]: enc.encode(DUMP),
      "OpenGALEN8/Hierarchy_Dumps/Other.dump": enc.encode("(implies OnlyInOtherDump TopCategory)\n"),
    }, ["OpenGALEN8/OWL_Sources/OWL-F/test.owl"]),
  );
}
