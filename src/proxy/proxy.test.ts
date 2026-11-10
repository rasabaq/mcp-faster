// End-to-end tests of the proxy core: an SDK Client -> proxy (in-process) -> fixture server.
// Every test runs against a stdio upstream (child process) and a streamable HTTP upstream (in-process).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LoggingMessageNotificationSchema, ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Layer } from "../layer.ts";
import { createFixtureServer } from "./fixtures/server.ts";
import { startProxy, type Upstream } from "./proxy.ts";

const fixture = fileURLToPath(new URL("./fixtures/server.ts", import.meta.url));

async function startHttpFixture() {
  const headers: string[] = [];
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const mcp = createFixtureServer();
  await mcp.connect(transport);
  const http = createServer((req, res) => {
    headers.push(String(req.headers["x-test-key"]));
    void transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    upstream: { url: `http://127.0.0.1:${port}/mcp`, headers: { "x-test-key": "synthetic-key" } },
    headers,
    async stop() {
      await mcp.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/** Starts an upstream, the proxy in front of it, and a client. `stop` cleans up all three. */
async function setup(kind: "stdio" | "http", layers: Layer[] = []) {
  const http = kind === "http" ? await startHttpFixture() : undefined;
  const upstream: Upstream = http?.upstream ?? { command: process.execPath, args: [fixture], env: {} };
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const proxy = await startProxy({ server: "fixture", upstream }, layers, proxySide);
  const client = new Client({ name: "test", version: "0" });
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

for (const kind of ["stdio", "http"] as const) {
  describe(`proxy with a ${kind} upstream`, () => {
    test("with no layers, everything passes through", async () => {
      const { client, headers, stop } = await setup(kind);
      try {
        assert.deepEqual(client.getServerVersion(), { name: "fixture", version: "1.2.3" });
        assert.equal(client.getInstructions(), "fixture instructions");
        const caps = client.getServerCapabilities();
        assert.ok(caps?.tools && caps.resources && caps.prompts && caps.logging);

        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name), ["echo", "notify", "exit"]);
        assert.deepEqual(tools[0]?.inputSchema.required, ["text"]);
        assert.deepEqual(text(await client.callTool({ name: "echo", arguments: { text: "hi" } })), ["echo: hi"]);

        const resource = await client.readResource({ uri: "fixture://hello" });
        assert.deepEqual(resource.contents, [{ uri: "fixture://hello", text: "hello resource" }]);
        const prompt = await client.getPrompt({ name: "greet", arguments: { name: "Ada" } });
        assert.deepEqual(prompt.messages[0]?.content, { type: "text", text: "hello Ada" });
        assert.deepEqual(await client.setLoggingLevel("debug"), {});
        assert.deepEqual(await client.ping(), {});
        if (kind === "http") assert.ok(headers.every((h) => h === "synthetic-key"));
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
        client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => logged.resolve(n.params.data));
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed.resolve());
        const progress: number[] = [];
        await client.listTools(); // HTTP: make sure the standalone event stream is open before the change.
        await client.callTool({ name: "notify" }, undefined, { onprogress: (p) => void progress.push(p.progress) });

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
