// End-to-end tests of the proxy core: an SDK Client -> proxy (in-process) -> fixture server.
// Every test runs against four upstreams: stdio and streamable HTTP, each on 2026-07-28 and on the 2025 revisions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { loadLayers } from "./cli.ts";
import { snapshotPath, startProxy, type ProxyConfig, type Upstream } from "./proxy.ts";

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
async function until(check: () => boolean) {
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

  test("an upstream that exits on the probe is started again with the 2025 handshake", async () => {
    const starts = join(dir, "exit-on-probe-starts.txt");
    const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
    const upstream = { command: process.execPath, args: [fixture, "--exit-on-probe"], env: { FIXTURE_STARTS: starts } };
    const proxy = await startProxy({ server: "fixture", upstream }, [], proxySide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    try {
      assert.deepEqual(text(await client.callTool({ name: "protocol" })), [LEGACY]);
    } finally {
      await client.close();
      await proxy.closed;
    }
    // The first process exited before the second one started, so only one ran at a time.
    assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 2);
  });

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
    s.setRequestHandler("resources/read", () => ({ contents: [], ttlMs: 7000, cacheScope: "public", "x-extra": "read" }));
    return s;
  };

  for (const modern of [true, false]) {
    test(`pass through unchanged (${modern ? MODERN : LEGACY} upstream)`, async () => {
      const http = await startHttpFixture(modern, build);
      const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
      const proxy = await startProxy({ server: "extra", upstream: http.upstream }, [], proxySide);
      // The client speaks what the upstream speaks, so cache fields on a 2026-07-28 read reach it.
      const client = new Client({ name: "test", version: "0" }, modern ? { versionNegotiation: { mode: "auto" } } : {});
      await client.connect(clientSide);
      try {
        // Read the raw result, so the test client's own schema cannot drop anything.
        const raw = await client.request({ method: "tools/list", params: {} }, z.looseObject({ tools: z.array(z.looseObject({})) }));
        assert.deepEqual(raw.tools[0]?.["x-extra"], { a: 1 });
        assert.deepEqual(raw.tools[0]?._meta, { "dev.test/tool": true });
        const result = await client.request({ method: "tools/call", params: { name: "t" } }, z.looseObject({ content: z.array(z.looseObject({})) }));
        assert.deepEqual([result.ttlMs, result.cacheScope, result["x-extra"]], [5000, "public", "call"]);
        const read = await client.request({ method: "resources/read", params: { uri: "x://y" } }, z.looseObject({}));
        assert.equal(read["x-extra"], "read");
        assert.deepEqual([read.ttlMs, read.cacheScope], [7000, "public"]);
      } finally {
        await client.close();
        await proxy.closed;
        await http.stop();
      }
    });
  }
});

describe("lazy start", () => {
  let n = 0;
  /** A fresh cache folder, a stdio fixture config, and a start counter per phase. */
  const fresh = (args: string[] = []) => {
    const cacheDir = join(dir, `lazy-${++n}`);
    mkdirSync(cacheDir); // The start counters live here too.
    const config = (starts: string, env: Record<string, string> = {}): ProxyConfig => ({
      server: "fixture",
      upstream: { command: process.execPath, args: [fixture, ...args], env: { FIXTURE_STARTS: join(cacheDir, starts), ...env } },
      lazy: true,
      cacheDir,
    });
    return { cacheDir, config, starts: (name: string) => (existsSync(join(cacheDir, name)) ? readFileSync(join(cacheDir, name), "utf8").trim().split("\n").length : 0) };
  };
  async function open(config: ProxyConfig, layers: Layer[] = []) {
    const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
    const proxy = await startProxy(config, layers, proxySide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return {
      client,
      async stop() {
        await client.close();
        await proxy.closed;
      },
    };
  }
  /** The first lazy start has no snapshot: it connects at once and saves one. */
  async function prime(config: ProxyConfig) {
    const { stop } = await open(config);
    try {
      await until(() => existsSync(snapshotPath(config)));
    } finally {
      await stop();
    }
  }

  for (const args of [[], ["--legacy"]]) {
    test(`with a snapshot, initialize and tools/list do not start the upstream, the first call starts it once (${args.length ? "2025" : "2026-07-28"} upstream)`, async () => {
      const { config, starts } = fresh(args);
      await prime(config("prime.txt"));
      assert.equal(starts("prime.txt"), 1);

      const { client, stop } = await open(config("run.txt"));
      try {
        assert.deepEqual(client.getServerVersion(), { name: "fixture", version: "1.2.3" });
        assert.equal(client.getInstructions(), "fixture instructions");
        assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["echo", "notify", "protocol", "exit"]);
        assert.equal(starts("run.txt"), 0);
        // Two calls at the same time share one start.
        const both = await Promise.all([client.callTool({ name: "echo", arguments: { text: "a" } }), client.callTool({ name: "echo", arguments: { text: "b" } })]);
        assert.deepEqual(both.map(text), [["echo: a"], ["echo: b"]]);
        assert.equal(starts("run.txt"), 1);
      } finally {
        await stop();
      }
    });
  }

  test("a changed upstream tool list sends tools/list_changed and updates the snapshot", async () => {
    const { config } = fresh();
    const c = config("starts.txt");
    await prime(c);
    const saved = JSON.parse(readFileSync(snapshotPath(c), "utf8")) as { tools: { name: string }[] };
    saved.tools = saved.tools.filter((t) => t.name !== "exit"); // The upstream "lost" a tool since last time.
    writeFileSync(snapshotPath(c), JSON.stringify(saved));

    const { client, stop } = await open(c);
    try {
      const changed = Promise.withResolvers<void>();
      client.setNotificationHandler("notifications/tools/list_changed", () => changed.resolve());
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["echo", "notify", "protocol"]);
      await client.callTool({ name: "echo", arguments: { text: "hi" } });
      await changed.promise;
      const now = JSON.parse(readFileSync(snapshotPath(c), "utf8")) as { tools: { name: string }[] };
      assert.deepEqual(now.tools.map((t) => t.name), ["echo", "notify", "protocol", "exit"]);
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["echo", "notify", "protocol", "exit"]);
    } finally {
      await stop();
    }
  });

  test("an upstream that cannot start gives an error result, and a later call works", async () => {
    const flag = join(dir, `fail-${n + 1}.flag`);
    const { config, starts } = fresh(["--fail-while", flag]);
    await prime(config("prime.txt"));
    writeFileSync(flag, "");
    const { client, stop } = await open(config("run.txt"));
    try {
      const failed = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      assert.equal(failed.isError, true);
      assert.match(text(failed)[0] ?? "", /could not start upstream server "fixture"/);
      rmSync(flag);
      assert.deepEqual(text(await client.callTool({ name: "echo", arguments: { text: "hi" } })), ["echo: hi"]);
      // The failed start counts twice: the proxy retries a server that exits during the 2026-07-28 probe.
      assert.equal(starts("run.txt"), 3);
    } finally {
      await stop();
    }
  });

  test("a cache hit does not start the upstream", async () => {
    const { config, starts } = fresh();
    await prime(config("prime.txt"));
    // One cache layer shared by two proxies, so the second one has a stored answer before its upstream runs.
    const layers = await loadLayers([{ use: "cache", options: { tools: { echo: { ttlMs: 60_000, readOnlyHint: true } } } }]);
    // The cache does not store a result fetched while its event stream changes, so wait for the stream first.
    let acked = false;
    const onNotification = layers[0]!.onNotification!;
    layers[0]!.onNotification = (n, ctx) => ((acked ||= n.method === "notifications/subscriptions/acknowledged"), onNotification.call(layers[0], n, ctx));
    const a = await open(config("a.txt"), layers);
    try {
      await a.client.listTools();
      await a.client.callTool({ name: "echo", arguments: { text: "hi" } });
      await until(() => acked);
      await a.client.callTool({ name: "echo", arguments: { text: "hi" } }); // Stored now.
      assert.equal(starts("a.txt"), 1);
      const b = await open(config("b.txt"), layers);
      try {
        await b.client.listTools();
        assert.deepEqual(text(await b.client.callTool({ name: "echo", arguments: { text: "hi" } })), ["echo: hi"]);
        assert.equal(starts("b.txt"), 0);
      } finally {
        await b.stop();
      }
    } finally {
      await a.stop();
    }
  });

  test("the snapshot holds no header or env values, and only its owner can read it", async () => {
    const SECRET = "synthetic-env-secret";
    const { config } = fresh();
    const stdio = config("starts.txt", { SECRET_FOR_TEST: SECRET });
    await prime(stdio);
    const http = await startHttpFixture(false);
    const viaHttp: ProxyConfig = { server: "fixture", upstream: http.upstream, lazy: true, cacheDir: stdio.cacheDir };
    try {
      await prime(viaHttp);
    } finally {
      await http.stop();
    }
    for (const c of [stdio, viaHttp]) {
      const saved = readFileSync(snapshotPath(c), "utf8");
      for (const secret of [SECRET, "SECRET_FOR_TEST", "synthetic-key", "x-test-key", "127.0.0.1"]) assert.ok(!saved.includes(secret), `snapshot holds ${secret}`);
      assert.equal(statSync(snapshotPath(c)).mode & 0o777, 0o600);
    }
    assert.notEqual(snapshotPath(stdio), snapshotPath(viaHttp));
  });

  test("a snapshot that is not valid is ignored and replaced", async () => {
    const { config, starts } = fresh();
    const c = config("starts.txt");
    await prime(c);
    writeFileSync(snapshotPath(c), JSON.stringify({ format: 1, tools: "not a list" }));
    const { client, stop } = await open(c);
    try {
      assert.equal(starts("starts.txt"), 2); // Connected at start, as with no snapshot.
      await client.listTools();
      await until(() => readFileSync(snapshotPath(c), "utf8").includes('"echo"'));
    } finally {
      await stop();
    }
  });

  test("without lazy, no snapshot is written", async () => {
    const { config } = fresh();
    const { client, stop } = await open({ ...config("starts.txt"), lazy: false });
    try {
      await client.callTool({ name: "echo", arguments: { text: "hi" } });
    } finally {
      await stop();
    }
    assert.ok(!existsSync(snapshotPath(config("starts.txt"))));
  });
});
