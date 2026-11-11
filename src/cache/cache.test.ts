import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { CallParams, LayerContext } from "../layer.ts";
import { INVALIDATED_BY, NOT_MODIFIED, VALIDATOR, canonicalJson, createLayer } from "./index.ts";

const ctx: LayerContext = { server: "fake", principal: "alice" };
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const tool = (name: string, meta?: Record<string, unknown>): Tool => ({
  name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  ...(meta ? { _meta: meta } : {}),
});

/** In-process fake server. `handle` builds each answer; `calls` records what reached upstream. */
function fake(handle: (params: CallParams, n: number) => CallToolResult | Promise<CallToolResult>) {
  const calls: CallParams[] = [];
  const next = async (params: CallParams) => {
    calls.push(params);
    return handle(params, calls.length);
  };
  return { calls, next };
}

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 0 }));
afterEach(() => mock.timers.reset());

test("TTL from options: hit inside the window, miss after it", async () => {
  const layer = createLayer({ tools: { search: { ttlMs: 1000, readOnlyHint: true } } });
  const server = fake((_p, n) => ({ content: [{ type: "text", text: `v${n}` }] }));

  assert.equal(text(await layer.callTool!({ name: "search", arguments: { q: "x", n: 1 } }, server.next, ctx)), "v1");
  mock.timers.tick(999);
  // Same arguments in another key order hit the same entry.
  assert.equal(text(await layer.callTool!({ name: "search", arguments: { n: 1, q: "x" } }, server.next, ctx)), "v1");
  assert.equal(server.calls.length, 1);

  mock.timers.tick(2);
  assert.equal(text(await layer.callTool!({ name: "search", arguments: { q: "x", n: 1 } }, server.next, ctx)), "v2");
  assert.equal(server.calls.length, 2);
});

test("TTL from the server (SEP-2549 words) is used, and the smaller TTL wins", async () => {
  const layer = createLayer({ tools: { search: { ttlMs: 10_000 } } });
  layer.listTools!([tool("search")], ctx);
  const server = fake((_p, n) => ({ content: [{ type: "text", text: `v${n}` }], ttlMs: 100, cacheScope: "private" }));

  await layer.callTool!({ name: "search" }, server.next, ctx);
  mock.timers.tick(50);
  await layer.callTool!({ name: "search" }, server.next, ctx);
  assert.equal(server.calls.length, 1);
  mock.timers.tick(51);
  await layer.callTool!({ name: "search" }, server.next, ctx);
  assert.equal(server.calls.length, 2);
});

/** Fake server with an ETag-like validator. `state.version` changes when the source changes. */
function versioned() {
  const state = { version: 1, full: 0, notModified: 0 };
  const server = fake((params) => {
    const sent = params._meta?.[VALIDATOR];
    if (sent === `v${state.version}`) {
      state.notModified++;
      return { content: [], ttlMs: 0, _meta: { [NOT_MODIFIED]: true } };
    }
    state.full++;
    return { content: [{ type: "text", text: `data ${state.version}` }], ttlMs: 0, _meta: { [VALIDATOR]: `v${state.version}` } };
  });
  return { state, server };
}

test("validator: not modified reuses the cached body", async () => {
  const layer = createLayer({});
  layer.listTools!([tool("read")], ctx);
  const { state, server } = versioned();

  assert.equal(text(await layer.callTool!({ name: "read" }, server.next, ctx)), "data 1");
  assert.equal(text(await layer.callTool!({ name: "read" }, server.next, ctx)), "data 1");
  assert.equal(server.calls[1]!._meta?.[VALIDATOR], "v1");
  assert.deepEqual([state.full, state.notModified], [1, 1]);
});

test("validator: changed source returns the fresh result and the new validator is used next", async () => {
  const layer = createLayer({});
  layer.listTools!([tool("read")], ctx);
  const { state, server } = versioned();

  await layer.callTool!({ name: "read" }, server.next, ctx);
  state.version = 2;
  assert.equal(text(await layer.callTool!({ name: "read" }, server.next, ctx)), "data 2");
  assert.equal(text(await layer.callTool!({ name: "read" }, server.next, ctx)), "data 2");
  assert.equal(server.calls[2]!._meta?.[VALIDATOR], "v2");
  assert.deepEqual([state.full, state.notModified], [2, 1]);
});

const URI = "test://channels/C1";
const ack = (uris: string[]) => ({
  method: "notifications/subscriptions/acknowledged",
  params: { notifications: { resourceSubscriptions: uris } },
});

test("events: an update for a declared URI evicts, other URIs do not", async () => {
  const layer = createLayer({});
  layer.listTools!([tool("history", { [INVALIDATED_BY]: [URI] })], ctx);
  assert.deepEqual(layer.resourceSubscriptions(ctx), [URI]);
  const server = fake((_p, n) => ({ content: [{ type: "text", text: `v${n}` }] }));

  // No live stream yet: events cannot protect the entry and there is no TTL, so nothing is stored.
  await layer.callTool!({ name: "history" }, server.next, ctx);
  await layer.callTool!({ name: "history" }, server.next, ctx);
  assert.equal(server.calls.length, 2);

  await layer.onNotification!(ack([URI]), ctx);
  await layer.callTool!({ name: "history" }, server.next, ctx);
  mock.timers.tick(3_600_000);
  await layer.onNotification!({ method: "notifications/resources/updated", params: { uri: "test://channels/C2" } }, ctx);
  assert.equal(text(await layer.callTool!({ name: "history" }, server.next, ctx)), "v3");
  assert.equal(server.calls.length, 3);

  // A sub-resource of the declared URI counts as an update too.
  await layer.onNotification!({ method: "notifications/resources/updated", params: { uri: `${URI}/messages/9` } }, ctx);
  assert.equal(text(await layer.callTool!({ name: "history" }, server.next, ctx)), "v4");
});

test("events: a server that does not acknowledge the URI does not protect the entry", async () => {
  const layer = createLayer({});
  layer.listTools!([tool("history", { [INVALIDATED_BY]: [URI] })], ctx);
  await layer.onNotification!(ack([]), ctx);
  const server = fake(() => ({ content: [] }));
  await layer.callTool!({ name: "history" }, server.next, ctx);
  await layer.callTool!({ name: "history" }, server.next, ctx);
  assert.equal(server.calls.length, 2);
});

test("events: a result fetched while an event arrives is returned but not stored", async () => {
  const layer = createLayer({});
  layer.listTools!([tool("history", { [INVALIDATED_BY]: [URI] })], ctx);
  await layer.onNotification!(ack([URI]), ctx);
  const server = fake(async (_p, n) => {
    if (n === 1) await layer.onNotification!({ method: "notifications/resources/updated", params: { uri: URI } }, ctx);
    return { content: [{ type: "text", text: `v${n}` }] };
  });
  assert.equal(text(await layer.callTool!({ name: "history" }, server.next, ctx)), "v1");
  assert.equal(text(await layer.callTool!({ name: "history" }, server.next, ctx)), "v2");
});

test("dropped stream: every event-dependent entry is flushed, TTL-only entries stay", async () => {
  const layer = createLayer({ tools: { history: { ttlMs: 60_000 }, search: { ttlMs: 60_000 } } });
  layer.listTools!([tool("history", { [INVALIDATED_BY]: [URI] }), tool("search")], ctx);
  await layer.onNotification!(ack([URI]), ctx);
  const server = fake((_p, n) => ({ content: [{ type: "text", text: `v${n}` }] }));

  await layer.callTool!({ name: "history" }, server.next, ctx);
  await layer.callTool!({ name: "search" }, server.next, ctx);
  assert.equal(server.calls.length, 2);

  layer.onStreamClosed(ctx);
  await layer.callTool!({ name: "history" }, server.next, ctx);
  await layer.callTool!({ name: "search" }, server.next, ctx);
  assert.equal(server.calls.length, 3, "history refetched, search still cached");

  // A re-opened stream also flushes: events may have been missed between the two streams.
  await layer.onNotification!(ack([URI]), ctx);
  await layer.callTool!({ name: "history" }, server.next, ctx);
  assert.equal(server.calls.length, 4);
});

test("scope: user A's entry is never served to user B", async () => {
  const layer = createLayer({ tools: { me: { ttlMs: 60_000, readOnlyHint: true } } });
  const server = fake((_p, n) => ({ content: [{ type: "text", text: `secret ${n}` }] }));
  const alice = { server: "fake", principal: "alice" };
  const bob = { server: "fake", principal: "bob" };
  const unknown = { server: "fake" };

  assert.equal(text(await layer.callTool!({ name: "me" }, server.next, alice)), "secret 1");
  assert.equal(text(await layer.callTool!({ name: "me" }, server.next, bob)), "secret 2");
  assert.equal(text(await layer.callTool!({ name: "me" }, server.next, unknown)), "secret 3");
  assert.equal(text(await layer.callTool!({ name: "me" }, server.next, alice)), "secret 1");
  assert.equal(text(await layer.callTool!({ name: "me" }, server.next, bob)), "secret 2");
  // Same caller on another server is another key.
  assert.equal(text(await layer.callTool!({ name: "me" }, server.next, { server: "other", principal: "alice" })), "secret 4");
  // Unknown caller on another layer instance never sees this instance's store.
  const other = createLayer({ tools: { me: { ttlMs: 60_000, readOnlyHint: true } } });
  assert.equal(text(await other.callTool!({ name: "me" }, server.next, unknown)), "secret 5");
});

test("scope: public is shared only when declared, and private always wins", async () => {
  const alice = { server: "fake", principal: "alice" };
  const bob = { server: "fake", principal: "bob" };
  const publicHint = () => fake((_p, n) => ({ content: [{ type: "text", text: `v${n}` }], ttlMs: 60_000, cacheScope: "public" }));

  const shared = createLayer({ tools: { docs: { readOnlyHint: true } } });
  let server = publicHint();
  await shared.callTool!({ name: "docs" }, server.next, alice);
  assert.equal(text(await shared.callTool!({ name: "docs" }, server.next, bob)), "v1");

  const strict = createLayer({ tools: { docs: { readOnlyHint: true, cacheScope: "private" } } });
  server = publicHint();
  await strict.callTool!({ name: "docs" }, server.next, alice);
  assert.equal(text(await strict.callTool!({ name: "docs" }, server.next, bob)), "v2");
});

test("error results and non-final results are not cached", async () => {
  const layer = createLayer({ tools: { search: { ttlMs: 60_000, readOnlyHint: true } } });
  const failing = fake(() => ({ content: [{ type: "text", text: "boom" }], isError: true }));
  await layer.callTool!({ name: "search" }, failing.next, ctx);
  await layer.callTool!({ name: "search" }, failing.next, ctx);
  assert.equal(failing.calls.length, 2);

  const asking = fake(() => ({ content: [], resultType: "input_required" }));
  await layer.callTool!({ name: "search", arguments: { q: 1 } }, asking.next, ctx);
  await layer.callTool!({ name: "search", arguments: { q: 1 } }, asking.next, ctx);
  assert.equal(asking.calls.length, 2);
});

test("a tool that is not read-only is not cached unless the options say so", async () => {
  const layer = createLayer({});
  layer.listTools!([{ name: "send", inputSchema: { type: "object" } }], ctx);
  const server = fake(() => ({ content: [], ttlMs: 60_000, cacheScope: "private" }));
  await layer.callTool!({ name: "send" }, server.next, ctx);
  await layer.callTool!({ name: "send" }, server.next, ctx);
  assert.equal(server.calls.length, 2);
});

test("two identical calls at the same time make one upstream call", async () => {
  const layer = createLayer({ tools: { search: { ttlMs: 0, readOnlyHint: true } } });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const server = fake(async () => {
    await gate;
    return { content: [{ type: "text", text: "once" }] };
  });
  const both = Promise.all([
    layer.callTool!({ name: "search", arguments: { q: "x" } }, server.next, ctx),
    layer.callTool!({ name: "search", arguments: { q: "x" } }, server.next, ctx),
  ]);
  release();
  const [a, b] = await both;
  assert.equal(server.calls.length, 1);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, "each caller gets its own copy");
});

test("bad options fail loudly", () => {
  assert.throws(() => createLayer({ tools: { search: { ttl: 5 } } }));
  assert.throws(() => createLayer({ tools: { search: { ttlMs: -1 } } }));
});

test("canonicalJson sorts keys at every level", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }), '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
});
