#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * opengalen-mcp: a small, read-only MCP server (stdio transport) over the
 * public OpenGALEN 8 OWL release.
 *
 *   deno run --allow-read --allow-env mcp/opengalen-mcp.ts --source opengalen8-owl-sources.zip
 *
 * The source can also come from the OPENGALEN_SOURCE environment variable.
 * Tools: search_concepts, get_concept, get_ancestors, check_names (mcp/tools.ts).
 *
 * Protocol: JSON-RPC 2.0, one message per line on stdin/stdout (MCP stdio
 * transport). Logs go to stderr. The index (about 2 s, ~0.5 GB RAM for the full
 * release) is loaded in the background at start, so `initialize` and
 * `tools/list` answer immediately; tool calls wait for the load.
 */
import { parseArgs } from "@std/cli/parse-args";
import { DEFAULT_DUMP, loadOpenGalen, type OgIndex } from "../src/opengalen.ts";
import { callTool, TOOLS } from "./tools.ts";

export const SERVER_INFO = { name: "opengalen-mcp", version: "0.1.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = "Read-only access to the OpenGALEN 8 release (GALEN Open Source License). " +
  "Names are exact and case-sensitive. Use check_names or get_concept to verify every name before using it.";

interface Msg {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Handle one JSON-RPC message; returns the response or null for notifications. */
export async function handle(msg: Msg, index: () => Promise<OgIndex>): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return error(-32602, `unknown tool: ${name}`);
      try {
        const result = callTool(await index(), name, msg.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result });
      } catch (e) {
        return reply({
          content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : e}` }],
          isError: true,
        });
      }
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}

async function main() {
  const a = parseArgs(Deno.args, { string: ["source", "dump"] });
  const source = a.source ?? Deno.env.get("OPENGALEN_SOURCE");
  if (!source) {
    console.error("usage: opengalen-mcp.ts --source <opengalen8-owl-sources.zip | folder | file.owl> [--dump NAME]");
    Deno.exit(2);
  }
  const started = performance.now();
  const loading = loadOpenGalen(source, a.dump ?? DEFAULT_DUMP).then((ix) => {
    console.error(
      `opengalen-mcp: ${ix.kinds.size} names from ${ix.files.length} files in ${
        Math.round(performance.now() - started)
      } ms`,
    );
    return ix;
  });
  loading.catch((e) => console.error(`opengalen-mcp: load failed: ${e}`));
  const enc = new TextEncoder();
  let buf = "";
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let res: object | null;
      try {
        res = await handle(JSON.parse(line), () => loading);
      } catch {
        res = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
      }
      if (res) await Deno.stdout.write(enc.encode(JSON.stringify(res) + "\n"));
    }
  }
}

if (import.meta.main) await main();
