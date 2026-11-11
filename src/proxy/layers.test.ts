// The three real layers together, behind the real proxy: client -> compact -> consolidate -> cache -> upstream.
// Each layer has its own tests. This one proves they load by name and work as one chain.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { META_KEY, MORE_TOOL } from "../compact/index.ts";
import { loadLayers } from "./cli.ts";
import { startProxy } from "./proxy.ts";

const bio = "synthetic bio text. ".repeat(200); // about 1000 tokens

/** A synthetic upstream that counts how often each tool really runs. */
async function startUpstream() {
  const calls = { find_user: 0, get_profile: 0 };
  const mcp = new McpServer({ name: "people", version: "0" });
  mcp.registerTool(
    "find_user",
    { description: "Find a user by name.", inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
    ({ name }) => {
      calls.find_user++;
      return { content: [{ type: "text", text: JSON.stringify({ id: "u1", name }) }] };
    },
  );
  mcp.registerTool(
    "get_profile",
    {
      description: "Get a user profile by id.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
      // The server ships its own compaction manifest.
      _meta: { [META_KEY]: { fields: { "/id": "keep", "/bio": "summarize" } } },
    },
    ({ id }) => {
      calls.get_profile++;
      return { content: [{ type: "text", text: JSON.stringify({ id, bio }) }] };
    },
  );
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(transport);
  const http = createServer((req, res) => void transport.handleRequest(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    calls,
    url: `http://127.0.0.1:${port}/mcp`,
    async stop() {
      await mcp.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

const textOf = (result: unknown) =>
  ((result as CallToolResult).content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

test("compact, consolidate and cache work as one chain behind the proxy", async () => {
  const upstream = await startUpstream();
  const layers = await loadLayers([
    { use: "compact", options: { budget: 300 } },
    {
      use: "consolidate",
      options: {
        composites: [
          {
            name: "find_profile",
            description: "Find a user by name and return the profile.",
            approved: true,
            steps: [
              { tool: "find_user", args: { name: { input: "name" } } },
              { tool: "get_profile", args: { id: { fromStep: 0, in: "text", path: ["id"] } } },
            ],
          },
        ],
      },
    },
    { use: "cache", options: { tools: { find_user: { ttlMs: 60_000 }, get_profile: { ttlMs: 60_000 } } } },
  ]);
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const proxy = await startProxy({ server: "people", upstream: { url: upstream.url, headers: {} } }, layers, proxySide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  try {
    // The model sees the server's tools plus one composite and the "more" tool.
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [MORE_TOOL, "find_profile", "find_user", "get_profile"].sort());

    // cache: the second identical call does not reach the server.
    await client.callTool({ name: "find_user", arguments: { name: "ada" } });
    await client.callTool({ name: "find_user", arguments: { name: "ada" } });
    assert.equal(upstream.calls.find_user, 1);

    // consolidate over cache: one call runs both steps, and step 1 is served from the cache.
    const composite = await client.callTool({ name: "find_profile", arguments: { name: "ada" } });
    assert.ok(!composite.isError, textOf(composite));
    assert.match(textOf(composite), /synthetic bio text/);
    assert.deepEqual(upstream.calls, { find_user: 1, get_profile: 1 });

    // compact over cache: the big profile is cut to the budget, the keep field survives,
    // and the cached copy is reused.
    const profile = await client.callTool({ name: "get_profile", arguments: { id: "u1" } });
    const info = (profile._meta as Record<string, { cursor: string; tokensBefore: number; tokensAfter: number }>)[META_KEY];
    assert.ok(info, "the result says it was compacted");
    assert.ok(info.tokensAfter < info.tokensBefore && info.tokensAfter <= 300);
    assert.match(textOf(profile), /"id":\s*"u1"/);
    assert.equal(upstream.calls.get_profile, 1);

    // The cut text comes back through the "more" tool.
    const more = await client.callTool({ name: MORE_TOOL, arguments: { cursor: info.cursor } });
    assert.ok(!more.isError, textOf(more));
    assert.match(textOf(more), /synthetic bio text/);
  } finally {
    await client.close();
    await proxy.closed;
    await upstream.stop();
  }
});
