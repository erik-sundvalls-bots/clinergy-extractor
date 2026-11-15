// Tests for the OpenGALEN MCP server: tool functions, JSON-RPC handling, and one
// real stdio round trip with a spawned server. Invented data only (og_fixture.ts).
import { assert, assertEquals } from "@std/assert";
import { OgIndex, scanDump, scanOwl } from "../src/opengalen.ts";
import { checkNames, getAncestors, getConcept, searchConcepts } from "../mcp/tools.ts";
import { handle } from "../mcp/opengalen-mcp.ts";
import { DUMP, OWL, writeOgZip } from "./og_fixture.ts";

// deno-lint-ignore no-explicit-any
type Y = any;

function index(): OgIndex {
  const ix = new OgIndex();
  scanOwl(OWL, ix);
  scanDump(DUMP, ix);
  return ix;
}

Deno.test("search_concepts: word match, ranking, generated names hidden by default", () => {
  const ix = index();
  const r = searchConcepts(ix, { query: "severity" });
  assertEquals(r.hits[0].name, "Severity"); // exact first
  assert(r.hits.some((h) => h.name === "hasSeverity")); // via CamelCase and label
  assertEquals(searchConcepts(ix, { query: "severity", kind: "ObjectProperty" }).hits.map((h) => h.name), [
    "hasSeverity",
  ]);
  assertEquals(searchConcepts(ix, { query: "edema" }).hits.map((h) => h.name), ["Oedema"]); // spelling folded
  assertEquals(searchConcepts(ix, { query: "pain elbow" }).total, 0);
  assertEquals(
    searchConcepts(ix, { query: "pain elbow", includeGenerated: true }).hits[0].name,
    "PainwhichhasLocationElbow",
  );
  assertEquals(searchConcepts(ix, { query: "slight", limit: 1 }).hits.length, 1);
});

Deno.test("get_concept, get_ancestors, check_names", () => {
  const ix = index();
  const c = getConcept(ix, { name: "Severity" }) as Y;
  assertEquals([c.exists, c.kind, c.parents], [true, "Class", ["Feature"]]);
  assertEquals(c.namedChildren.sort(), ["SlightSeverity", "StrongSeverity"]);
  assertEquals(c.browserUrl, "https://pen-pad-revival.github.io/opengalen-browser/#concept=Severity");
  assertEquals((getConcept(ix, { name: "Pain" }) as Y).sanctions, { hasSeverity: ["Severity"] });
  assertEquals((getConcept(ix, { name: "Pain" }) as Y).generatedChildCount, 1);
  const missing = getConcept(ix, { name: "severity" }) as Y;
  assertEquals([missing.exists, missing.caseInsensitiveMatches], [false, ["Severity"]]);
  assertEquals(getAncestors(ix, { name: "SlightSeverity" }).ancestors, [
    { name: "Severity", depth: 1 },
    { name: "Feature", depth: 2 },
    { name: "Phenomenon", depth: 3 },
    { name: "TopCategory", depth: 4 },
  ]);
  assertEquals(getAncestors(ix, { name: "SlightSeverity", maxDepth: 1 }).ancestors.length, 1);
  assertEquals(checkNames(ix, { names: ["Pain", "PainInvented"] }).results.map((r) => r.exists), [true, false]);
});

Deno.test("JSON-RPC handler: initialize, tools/list, tools/call, errors, notifications", async () => {
  const ix = Promise.resolve(index());
  const init = await handle(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    () => ix,
  ) as Y;
  assertEquals([init.result.protocolVersion, init.result.serverInfo.name], ["2025-06-18", "opengalen-mcp"]);
  assertEquals(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, () => ix), null);
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, () => ix) as Y;
  assertEquals(list.result.tools.map((t: Y) => t.name), [
    "search_concepts",
    "get_concept",
    "get_ancestors",
    "check_names",
  ]);
  const call = await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "check_names", arguments: { names: ["Severity"] } },
  }, () => ix) as Y;
  assertEquals(call.result.structuredContent.results[0].exists, true);
  assertEquals(JSON.parse(call.result.content[0].text).results[0].name, "Severity");
  const bad = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }, () => ix) as Y;
  assertEquals(bad.error.code, -32602);
  assertEquals((await handle({ jsonrpc: "2.0", id: 5, method: "resources/list" }, () => ix) as Y).error.code, -32601);
});

Deno.test("stdio round trip with a spawned server", async () => {
  const tmp = await Deno.makeTempDir();
  await writeOgZip(`${tmp}/og.zip`);
  const server = new URL("../mcp/opengalen-mcp.ts", import.meta.url).pathname;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-env", server, "--source", `${tmp}/og.zip`],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = child.stdin.getWriter();
  const enc = new TextEncoder();
  const send = (m: object) => w.write(enc.encode(JSON.stringify(m) + "\n"));
  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_ancestors", arguments: { name: "StrongSeverity" } },
  });
  await w.close();
  const out = new TextDecoder().decode((await child.output()).stdout).trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(out.map((m: Y) => m.id), [1, 2]);
  assertEquals(out[0].result.capabilities.tools.listChanged, false);
  assertEquals(out[1].result.structuredContent.ancestors[0], { name: "Severity", depth: 1 });
  await Deno.remove(tmp, { recursive: true });
});
