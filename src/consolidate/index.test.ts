import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallParams } from "../layer.ts";
import { createLayer } from "./index.ts";

const ctx = { server: "acme" };
const readOnly = { readOnlyHint: true };
const tools: Tool[] = [
  {
    name: "search",
    annotations: readOnly,
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  { name: "get_item", annotations: readOnly, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_item", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

const searchThenGet = {
  name: "search_then_get",
  description: "Find an item and read it.",
  approved: true,
  steps: [
    { tool: "search", args: { query: { input: "query" }, limit: { input: "limit" } } },
    { tool: "get_item", args: { id: { fromStep: 0, in: "structuredContent", path: ["items", 0, "id"] } } },
  ],
};
const searchThenDelete = {
  name: "search_then_delete",
  approved: true,
  steps: [
    { tool: "search", args: { query: { input: "query" } } },
    { tool: "delete_item", args: { id: { fromStep: 0, in: "text", path: ["items", 0, "id"] } } },
  ],
};

// A fake upstream server that records calls.
function fakeNext(answers: Record<string, CallToolResult>) {
  const calls: CallParams[] = [];
  const next = async (p: CallParams) => {
    calls.push(p);
    const a = answers[p.name];
    if (!a) throw new Error(`no answer for ${p.name}`);
    return a;
  };
  return { calls, next };
}

const text = (t: string) => ({ type: "text" as const, text: t });

test("lists the composite with caller inputs and the real tool names", async () => {
  const layer = createLayer({ composites: [searchThenGet, { ...searchThenGet, name: "not_approved", approved: false }] });
  const out = await layer.listTools!(tools, ctx);
  assert.deepEqual(out.slice(0, 3), tools);
  assert.equal(out.length, 4);
  const c = out[3]!;
  assert.equal(c.name, "search_then_get");
  assert.match(c.description!, /search, then get_item/);
  assert.deepEqual(c.inputSchema, {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  });
  assert.deepEqual(c.annotations, { readOnlyHint: true });
});

test("runs the steps and maps a result value into the next call", async () => {
  const layer = createLayer({ composites: [searchThenGet] });
  await layer.listTools!(tools, ctx);
  const { calls, next } = fakeNext({
    search: { content: [text("found")], structuredContent: { items: [{ id: "item-7" }] } },
    get_item: { content: [text("item body")] },
  });
  const r = await layer.callTool!({ name: "search_then_get", arguments: { query: "cats" } }, next, ctx);
  assert.deepEqual(calls, [
    { name: "search", arguments: { query: "cats" } },
    { name: "get_item", arguments: { id: "item-7" } },
  ]);
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.content, [text("Step 1: search"), text("found"), text("Step 2: get_item"), text("item body")]);
});

test("fails the step when a mapped value is missing, and keeps what it has", async () => {
  const layer = createLayer({ composites: [searchThenGet] });
  await layer.listTools!(tools, ctx);
  const { calls, next } = fakeNext({ search: { content: [text("nothing")], structuredContent: { items: [] } } });
  const r = await layer.callTool!({ name: "search_then_get", arguments: { query: "cats" } }, next, ctx);
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(r.content.slice(0, 2), [text("Step 1: search"), text("nothing")]);
  assert.match((r.content[2] as { text: string }).text, /Step 2 of 2 \(get_item\) failed: .*structuredContent\.items\.0\.id/);
});

test("stops when a step returns an error or throws", async () => {
  const layer = createLayer({ composites: [searchThenGet] });
  await layer.listTools!(tools, ctx);
  const failing = fakeNext({ search: { isError: true, content: [text("rate limited")] } });
  const r1 = await layer.callTool!({ name: "search_then_get", arguments: { query: "x" } }, failing.next, ctx);
  assert.equal(r1.isError, true);
  assert.equal(failing.calls.length, 1);
  assert.match((r1.content.at(-1) as { text: string }).text, /Step 1 of 2 \(search\) failed/);

  const throwing = fakeNext({});
  const r2 = await layer.callTool!({ name: "search_then_get", arguments: { query: "x" } }, throwing.next, ctx);
  assert.equal(r2.isError, true);
  assert.match((r2.content.at(-1) as { text: string }).text, /Step 1 of 2 \(search\) failed: no answer for search/);
});

test("refuses a call that lacks a required input, before any step runs", async () => {
  const layer = createLayer({ composites: [searchThenGet] });
  await layer.listTools!(tools, ctx);
  const { calls, next } = fakeNext({});
  const r = await layer.callTool!({ name: "search_then_get", arguments: { limit: 5 } }, next, ctx);
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /needs: query/);
  assert.equal(calls.length, 0);
});

test("refuses a composite with a step that is not read-only", async () => {
  const layer = createLayer({ composites: [searchThenDelete] });
  const out = await layer.listTools!(tools, ctx);
  assert.equal(out.length, 3);
  const { calls, next } = fakeNext({});
  const r = await layer.callTool!({ name: "search_then_delete", arguments: { query: "x" } }, next, ctx);
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /delete_item.*readOnlyHint/);
  assert.equal(calls.length, 0);
});

test("refuses a composite before the live tool list is known", async () => {
  const layer = createLayer({ composites: [searchThenGet] });
  const { calls, next } = fakeNext({});
  const r = await layer.callTool!({ name: "search_then_get", arguments: { query: "x" } }, next, ctx);
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test("exposes a non-read-only composite only with an explicit opt-in", async () => {
  const layer = createLayer({ composites: [{ ...searchThenDelete, allowNonReadOnly: true }] });
  const out = await layer.listTools!(tools, ctx);
  assert.deepEqual(out[3]!.annotations, { readOnlyHint: false });
  const { calls, next } = fakeNext({
    search: { content: [text(JSON.stringify({ items: [{ id: "item-9" }] }))] },
    delete_item: { content: [text("deleted")] },
  });
  const r = await layer.callTool!({ name: "search_then_delete", arguments: { query: "x" } }, next, ctx);
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls[1], { name: "delete_item", arguments: { id: "item-9" } });
});

test("refuses composites whose tools are missing or whose required args are unmapped", async () => {
  const missingTool = { ...searchThenGet, name: "a", steps: [searchThenGet.steps[0]!, { tool: "gone", args: {} }] };
  const unmapped = { ...searchThenGet, name: "b", steps: [searchThenGet.steps[0]!, { tool: "get_item", args: {} }] };
  const layer = createLayer({ composites: [missingTool, unmapped] });
  assert.equal((await layer.listTools!(tools, ctx)).length, 3);
});

test("passes other calls through untouched", async () => {
  const layer = createLayer({ composites: [searchThenGet] });
  await layer.listTools!(tools, ctx);
  const answer = { content: [text("raw")] };
  const { calls, next } = fakeNext({ get_item: answer });
  const params = { name: "get_item", arguments: { id: "z" } };
  assert.equal(await layer.callTool!(params, next, ctx), answer);
  assert.equal(calls[0], params);
});

test("rejects bad approved files", () => {
  assert.throws(() => createLayer({ composites: [{ ...searchThenGet, name: "bad name" }] }), /valid MCP tool name/);
  const forward = { ...searchThenGet, steps: [{ tool: "get_item", args: { id: { fromStep: 1, in: "text", path: [] } } }, searchThenGet.steps[0]] };
  assert.throws(() => createLayer({ composites: [forward] }), /has not run yet/);
  assert.throws(() => createLayer({ composites: [searchThenGet, searchThenGet] }), /defined twice/);
  assert.throws(() => createLayer({}), /bad options/);
});
