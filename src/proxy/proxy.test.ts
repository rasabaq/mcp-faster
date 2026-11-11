// End-to-end tests of the proxy core: an SDK Client -> proxy (in-process) -> fixture server.
// Every test runs against four upstreams: stdio and streamable HTTP, each on 2026-07-28 and on the 2025 revisions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult, type ClientOptions } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Layer } from "../layer.ts";
import { createFixtureServer } from "./fixtures/server.ts";
import { startProxy, type Upstream } from "./proxy.ts";

const fixture = fileURLToPath(new URL("./fixtures/server.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcp-faster-proxy-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const KINDS = ["stdio", "stdio-2025", "http", "http-2025"] as const;
type Kind = (typeof KINDS)[number];
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

async function startHttpFixture(modern: boolean, build?: () => Server) {
  const headers: string[] = [];
  let listener: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown;
  let closeServer: () => Promise<void>;
  if (modern) {
    // One server per request, as createMcpHandler wants. The runtime tool and its list change live here.
    const state = { added: false };
    const handler = createMcpHandler(() => build?.() ?? createFixtureServer(state, () => handler.notify.toolsChanged()));
    listener = toNodeHandler(handler);
    closeServer = () => handler.close();
  } else {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const mcp = build?.() ?? createFixtureServer();
    await mcp.connect(transport);
    listener = (req, res) => transport.handleRequest(req, res);
    closeServer = () => mcp.close();
  }
  const http = createServer((req, res) => {
    headers.push(String(req.headers["x-test-key"]));
    void listener(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    upstream: { url: `http://127.0.0.1:${port}/mcp`, headers: { "x-test-key": "synthetic-key" } },
    headers,
    async stop() {
      await closeServer();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/** Starts an upstream, the proxy in front of it, and a client. `stop` cleans up all three. */
async function setup(kind: Kind, layers: Layer[] = [], clientOptions?: ClientOptions, env: Record<string, string> = {}) {
  const http = kind.startsWith("http") ? await startHttpFixture(kind === "http") : undefined;
  const upstream: Upstream = http?.upstream ?? { command: process.execPath, args: kind === "stdio" ? [fixture] : [fixture, "--legacy"], env };
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const proxy = await startProxy({ server: "fixture", upstream }, layers, proxySide);
  const client = new Client({ name: "test", version: "0" }, clientOptions);
  await client.connect(clientSide);
  return {
    client,
    proxy,
    headers: http?.headers ?? [],
    async stop() {
      await client.close();
      await proxy.closed;
      await http?.stop();
    },
  };
}

/** Waits until `check` is true, polling every 10 ms, for at most 5 s. */
export async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition never became true");
}

const text = (result: unknown) => ((result as CallToolResult).content as { text: string }[]).map((c) => c.text);

/** A layer that tags tool descriptions and records the order it sees calls in. */
const tagLayer = (name: string, order: string[]): Layer => ({
  name,
  listTools: (tools) => tools.map((tool) => ({ ...tool, description: `${tool.description} [${name}]` })),
  async callTool(params, next) {
    order.push(`${name}>`);
    const result = await next(params);
    order.push(`<${name}`);
    return { ...result, content: [...result.content, { type: "text", text: name }] };
  },
});

for (const kind of KINDS) {
  describe(`proxy with a ${kind} upstream`, () => {
    test("with no layers, everything passes through", async () => {
      const { client, headers, stop } = await setup(kind);
      try {
        assert.deepEqual(client.getServerVersion(), { name: "fixture", version: "1.2.3" });
        assert.equal(client.getInstructions(), "fixture instructions");
        const caps = client.getServerCapabilities();
        assert.ok(caps?.tools && caps.resources && caps.prompts && caps.logging);

        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name), ["echo", "notify", "protocol", "exit"]);
        assert.deepEqual(tools[0]?.inputSchema.required, ["text"]);
        assert.deepEqual(text(await client.callTool({ name: "echo", arguments: { text: "hi" } })), ["echo: hi"]);

        const resource = await client.readResource({ uri: "fixture://hello" });
        assert.deepEqual(resource.contents, [{ uri: "fixture://hello", text: "hello resource" }]);
        const prompt = await client.getPrompt({ name: "greet", arguments: { name: "Ada" } });
        assert.deepEqual(prompt.messages[0]?.content, { type: "text", text: "hello Ada" });
        assert.deepEqual(await client.setLoggingLevel("debug"), {});
        assert.deepEqual(await client.ping(), {});
        if (kind.startsWith("http")) assert.ok(headers.length > 0 && headers.every((h) => h === "synthetic-key"));
        // The proxy speaks 2026-07-28 to an upstream that can, and a 2025 revision to the client that asked for one.
        assert.deepEqual(text(await client.callTool({ name: "protocol" })), [kind.endsWith("2025") ? LEGACY : MODERN]);
        assert.equal(client.getNegotiatedProtocolVersion(), LEGACY);
      } finally {
        await stop();
      }
    });

    test("two layers run in the documented order", async () => {
      const order: string[] = [];
      const { client, stop } = await setup(kind, [tagLayer("A", order), tagLayer("B", order)]);
      try {
        const { tools } = await client.listTools();
        // listTools: upstream -> B -> A -> client
        assert.equal(tools[0]?.description, "Echo text back. [B] [A]");
        // callTool: client -> A -> B -> upstream
        const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
        assert.deepEqual(order, ["A>", "B>", "<B", "<A"]);
        assert.deepEqual(text(result), ["echo: hi", "B", "A"]);
      } finally {
        await stop();
      }
    });

    test("upstream notifications reach every layer and the client", async () => {
      const seen: [string, string][] = [];
      const recorder = (name: string): Layer => ({ name, onNotification: (n) => void seen.push([name, n.method]) });
      const { client, stop } = await setup(kind, [recorder("A"), recorder("B")]);
      try {
        const logged = Promise.withResolvers<unknown>();
        const changed = Promise.withResolvers<void>();
        client.setNotificationHandler("notifications/message", (n) => logged.resolve(n.params.data));
        client.setNotificationHandler("notifications/tools/list_changed", () => changed.resolve());
        const progress: number[] = [];
        await client.listTools(); // HTTP: make sure the standalone event stream is open before the change.
        // 2026-07-28: list changes come only on the proxy's listen stream, so wait until it is acknowledged.
        if (!kind.endsWith("2025")) await until(() => seen.some(([, m]) => m === "notifications/subscriptions/acknowledged"));
        await client.callTool({ name: "notify" }, { onprogress: (p) => void progress.push(p.progress) });

        assert.equal(await logged.promise, "hello from fixture");
        await changed.promise;
        assert.deepEqual(progress, [1]);
        assert.ok((await client.listTools()).tools.some((t) => t.name === "later"));
        for (const method of ["notifications/message", "notifications/progress", "notifications/tools/list_changed"]) {
          assert.ok(seen.some(([l, m]) => l === "A" && m === method), `A saw ${method}`);
          assert.ok(seen.some(([l, m]) => l === "B" && m === method), `B saw ${method}`);
        }
      } finally {
        await stop();
      }
    });

    test("a throwing layer returns an error result and the proxy keeps working", async () => {
      const thrower: Layer = {
        name: "thrower",
        callTool: (params, next) => (params.arguments?.text === "boom" ? Promise.reject(new Error("boom")) : next(params)),
        onNotification() {
          throw new Error("notification boom");
        },
      };
      const { client, stop } = await setup(kind, [thrower]);
      try {
        const failed = await client.callTool({ name: "echo", arguments: { text: "boom" } });
        assert.equal(failed.isError, true);
        assert.match(text(failed)[0] ?? "", /boom/);
        await client.callTool({ name: "notify" }); // onNotification throws here.
        assert.deepEqual(text(await client.callTool({ name: "echo", arguments: { text: "ok" } })), ["echo: ok"]);
      } finally {
        await stop();
      }
    });

    test("closing the client closes the upstream and every layer", async () => {
      let closed = 0;
      const closer = (name: string): Layer => ({ name, close: () => void closed++ });
      const { stop } = await setup(kind, [closer("A"), closer("B")]);
      await stop();
      assert.equal(closed, 2);
    });
  });
}

describe("protocol revisions", () => {
  for (const kind of KINDS) {
    test(`a 2026-07-28 client works through the proxy (${kind} upstream)`, async () => {
      const { client, stop } = await setup(kind, [], { versionNegotiation: { mode: "auto" } });
      try {
        // The proxy serves 2026-07-28 only when the upstream speaks it. Otherwise the client falls back.
        assert.equal(client.getNegotiatedProtocolVersion(), kind.endsWith("2025") ? LEGACY : MODERN);
        assert.deepEqual(text(await client.callTool({ name: "protocol" })), [kind.endsWith("2025") ? LEGACY : MODERN]);
        assert.deepEqual(text(await client.callTool({ name: "echo", arguments: { text: "hi" } })), ["echo: hi"]);
        const resource = await client.readResource({ uri: "fixture://hello" });
        assert.deepEqual(resource.contents, [{ uri: "fixture://hello", text: "hello resource" }]);
      } finally {
        await stop();
      }
    });
  }

  test("a client pinned to an older revision still works", async () => {
    const { client, stop } = await setup("stdio", [], { supportedProtocolVersions: ["2025-06-18"] });
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), "2025-06-18");
      assert.deepEqual(text(await client.callTool({ name: "echo", arguments: { text: "hi" } })), ["echo: hi"]);
    } finally {
      await stop();
    }
  });

  test("a client pinned to 2026-07-28 works", async () => {
    const { client, stop } = await setup("stdio", [], { versionNegotiation: { mode: { pin: MODERN } } });
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
      assert.deepEqual(text(await client.callTool({ name: "echo", arguments: { text: "hi" } })), ["echo: hi"]);
    } finally {
      await stop();
    }
  });

  for (const kind of ["stdio", "stdio-2025"] as const) {
    test(`the ${kind} upstream starts exactly once`, async () => {
      const starts = join(dir, `${kind}-starts.txt`);
      const { client, stop } = await setup(kind, [], undefined, { FIXTURE_STARTS: starts });
      try {
        await client.callTool({ name: "echo", arguments: { text: "hi" } });
      } finally {
        await stop();
      }
      assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 1);
    });
  }

  for (const kind of KINDS) {
    test(`an upstream protocol error keeps its code (${kind} upstream)`, async () => {
      const { client, stop } = await setup(kind);
      try {
        await assert.rejects(client.callTool({ name: "no-such-tool" }), (error: { code?: number }) => error.code === -32602);
        await assert.rejects(client.getPrompt({ name: "no-such-prompt" }), (error: { code?: number }) => error.code === -32602);
      } finally {
        await stop();
      }
    });
  }
});

describe("fields the SDK schemas do not name", () => {
  /** A raw upstream that adds fields no schema names, on a tool and on results. */
  const build = () => {
    const s = new Server({ name: "extra", version: "0" }, { capabilities: { tools: {}, resources: {} } });
    s.setRequestHandler("tools/list", () => ({
      tools: [{ name: "t", inputSchema: { type: "object" as const }, "x-extra": { a: 1 }, _meta: { "dev.test/tool": true } }],
    }));
    s.setRequestHandler("tools/call", () => ({ content: [], ttlMs: 5000, cacheScope: "public", "x-extra": "call" }));
    s.setRequestHandler("resources/read", () => ({ contents: [], "x-extra": "read" }));
    return s;
  };

  for (const modern of [true, false]) {
    test(`pass through unchanged (${modern ? MODERN : LEGACY} upstream)`, async () => {
      const http = await startHttpFixture(modern, build);
      const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
      const proxy = await startProxy({ server: "extra", upstream: http.upstream }, [], proxySide);
      const client = new Client({ name: "test", version: "0" });
      await client.connect(clientSide);
      try {
        // Read the raw result, so the test client's own schema cannot drop anything.
        const raw = await client.request({ method: "tools/list", params: {} }, z.looseObject({ tools: z.array(z.looseObject({})) }));
        assert.deepEqual(raw.tools[0]?.["x-extra"], { a: 1 });
        assert.deepEqual(raw.tools[0]?._meta, { "dev.test/tool": true });
        const result = await client.request({ method: "tools/call", params: { name: "t" } }, z.looseObject({ content: z.array(z.looseObject({})) }));
        assert.deepEqual([result.ttlMs, result.cacheScope, result["x-extra"]], [5000, "public", "call"]);
        assert.equal((await client.request({ method: "resources/read", params: { uri: "x://y" } }))["x-extra"], "read");
      } finally {
        await client.close();
        await proxy.closed;
        await http.stop();
      }
    });
  }
});
