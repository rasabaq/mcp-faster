// The three real layers together, behind the real proxy: client -> compact -> consolidate -> cache -> upstream.
// Each layer has its own tests. This one proves they load by name and work as one chain,
// and that the cache's event mode works through the proxy's subscriptions/listen stream.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { INVALIDATED_BY } from "../cache/index.ts";
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

/** Waits until `check` is true, polling every 10 ms, for at most 5 s. */
async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition never became true");
}

for (const modernClient of [false, true]) {
  test(`cache event mode: a resource update evicts, and a broken stream drops every event-protected entry (${modernClient ? "2026-07-28" : "2025"} client)`, async () => {
    // A 2026-07-28 upstream. Its read-only tool has no TTL: it says which resource makes its results stale.
    const CHANNEL = "fixture://channels/C1";
    let runs = 0;
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name: "chat", version: "0" }, { capabilities: { resources: { subscribe: true } } });
      mcp.registerTool(
        "history",
        { description: "Read channel history.", annotations: { readOnlyHint: true }, _meta: { [INVALIDATED_BY]: [CHANNEL] } },
        () => ({ content: [{ type: "text", text: `history v${++runs}` }] }),
      );
      return mcp;
    });
    const http = createServer(toNodeHandler(handler));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;

    const [cache] = await loadLayers([{ use: "cache" }]);
    // Watch what the real cache layer is told, without changing what it does.
    const seen: string[] = [];
    let acked: unknown[] = []; // The URIs of the latest acknowledged stream.
    const { onNotification, onStreamClosed } = cache!;
    cache!.onNotification = (n, ctx) => {
      seen.push(n.method);
      if (n.method === "notifications/subscriptions/acknowledged") {
        acked = (n.params as { notifications?: { resourceSubscriptions?: unknown[] } }).notifications?.resourceSubscriptions ?? [];
      }
      return onNotification!.call(cache, n, ctx);
    };
    cache!.onStreamClosed = (ctx) => {
      seen.push("stream closed");
      acked = [];
      return onStreamClosed!.call(cache, ctx);
    };

    const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
    const proxy = await startProxy({ server: "chat", upstream: { url: `http://127.0.0.1:${port}/mcp`, headers: {} } }, [cache!], proxySide);
    const client = new Client({ name: "test", version: "0" }, modernClient ? { versionNegotiation: { mode: "auto" } } : {});
    const clientUpdates: string[] = [];
    client.setNotificationHandler("notifications/resources/updated", (n) => void clientUpdates.push(n.params.uri));
    await client.connect(clientSide);
    assert.equal(client.getNegotiatedProtocolVersion(), modernClient ? "2026-07-28" : "2025-11-25");
    const history = async () => textOf(await client.callTool({ name: "history" }));
    try {
      // tools/list tells the cache which URI the tool depends on. The proxy then listens for it.
      await client.listTools();
      await until(() => acked.includes(CHANNEL));

      // A cached answer is served.
      assert.equal(await history(), "history v1");
      assert.equal(await history(), "history v1");
      assert.equal(runs, 1);

      // The event evicts it, and the next call reaches the server.
      handler.notify.resourceUpdated(CHANNEL);
      await until(() => seen.includes("notifications/resources/updated"));
      assert.equal(await history(), "history v2");
      assert.equal(await history(), "history v2");
      assert.equal(runs, 2);
      // The client never subscribed to that URI, so the update stayed in the proxy.
      assert.deepEqual(clientUpdates, []);

      // The client's own subscription (resources/subscribe, or its own listen stream) rides the same stream. The new filter means a new stream,
      // and the cache cannot know what the gap held, so it fetches once more.
      const OTHER = "fixture://channels/C2";
      if (modernClient) await client.listen({ resourceSubscriptions: [OTHER] });
      else await client.subscribeResource({ uri: OTHER });
      await until(() => acked.includes(OTHER) && acked.includes(CHANNEL));
      assert.equal(await history(), "history v3");
      handler.notify.resourceUpdated(OTHER);
      await until(() => clientUpdates.length > 0);
      assert.deepEqual(clientUpdates, [OTHER]);
      // An update for another URI leaves the entry alone.
      assert.equal(await history(), "history v3");
      assert.equal(runs, 3);

      // A broken stream drops every event-protected entry.
      http.closeAllConnections();
      await until(() => seen.includes("stream closed"));
      assert.equal(await history(), "history v4");
      assert.equal(runs, 4);

      // The proxy listens again after a backoff, and caching works again.
      await until(() => acked.includes(CHANNEL));
      assert.equal(await history(), "history v5");
      assert.equal(await history(), "history v5");
      assert.equal(runs, 5);
    } finally {
      await client.close();
      await proxy.closed;
      await handler.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  });
}
