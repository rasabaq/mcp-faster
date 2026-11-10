import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mine } from "./cli.ts";
import { readToolCalls } from "../transcripts.ts";

// All data here is synthetic. It follows the shape of Claude Code transcripts.
let n = 0;
function session(calls: { name: string; input: object; text?: string; structured?: object }[]): string {
  const lines: object[] = [];
  for (const c of calls) {
    const id = `toolu_${++n}`;
    const use = { type: "tool_use", id, name: c.name, input: c.input };
    lines.push({ type: "assistant", timestamp: "2026-11-01T10:00:00Z", message: { role: "assistant", content: [use] } });
    // Claude Code also logs request blobs that repeat items. They must not be counted.
    lines.push({ type: "api-request-blob", message: { content: [use] } });
    lines.push({
      type: "user",
      timestamp: "2026-11-01T10:00:01Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: c.text ?? "ok" }] }] },
      ...(c.structured ? { mcpMeta: { structuredContent: c.structured } } : {}),
    });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n{torn line";
}

const search = (q: string, id: string) => ({
  name: "mcp__acme__search",
  input: { query: q },
  text: JSON.stringify({ items: [{ id, title: "x" }] }),
});
const get = (id: string) => ({ name: "mcp__acme__get_item", input: { id } });
const noise = (tool: string) => ({ name: `mcp__acme__${tool}`, input: { flag: true } });
const other = { name: "mcp__other__ping", input: {} };
const bash = { name: "Bash", input: { command: "ls" } };

const dir = await mkdtemp(join(tmpdir(), "mine-test-"));
after(() => rm(dir, { recursive: true }));
await mkdir(join(dir, "proj-a", "s1", "subagents"), { recursive: true });
await mkdir(join(dir, "proj-b"));
await writeFile(join(dir, "proj-a", "s1.jsonl"), session([search("alpha", "item-101"), bash, get("item-101"), noise("status")]));
await writeFile(join(dir, "proj-a", "s1", "subagents", "agent-1.jsonl"), session([noise("list"), search("beta", "item-202"), other, get("item-202")]));
await writeFile(join(dir, "proj-b", "s2.jsonl"), session([search("gamma", "item-303"), get("item-303"), noise("whoami"), noise("list")]));
await writeFile(join(dir, "proj-b", "s3.jsonl"), session([noise("status"), noise("whoami")]));
// The same tool in a row, in two sessions: a loop, not a chain.
await writeFile(join(dir, "proj-b", "s4.jsonl"), session([noise("post"), noise("post"), noise("post")]));
await writeFile(join(dir, "proj-b", "s5.jsonl"), session([noise("post"), noise("post")]));

test("reader yields each call once, with its result", async () => {
  const calls = [];
  for await (const c of readToolCalls(dir)) calls.push(c);
  assert.equal(calls.length, 18); // 19 calls were written. The one Bash call is not an MCP call.
  const first = calls.find((c) => c.name === "mcp__acme__search")!;
  assert.match(String((first.content[0] as { text: string }).text), /item-/);
  assert.equal(first.isError, false);
});

test("finds the planted chain, ignores noise, maps the data flow", async () => {
  const out = await mine(readToolCalls(dir), { server: "acme", top: 3 });
  assert.equal(out.sessions, 6);
  assert.equal(out.calls, 17);
  const [best] = out.composites;
  assert.ok(best);
  assert.deepEqual(best.steps.map((s) => s.tool), ["search", "get_item"]);
  assert.equal(best.name, "search_then_get_item");
  assert.equal(best.approved, false);
  assert.deepEqual(best.steps[0]!.args, { query: { input: "query" } });
  assert.deepEqual(best.steps[1]!.args, { id: { fromStep: 0, in: "text", path: ["items", 0, "id"] } });
  assert.deepEqual(best.steps[1]!.evidence.id, { present: 3, fromPath: 3, inPlainText: 0, echoOfInput: 0 });
  assert.deepEqual(best.support, { count: 3, sessions: 3, sessionShare: 0.5, dataFlowShare: 1 });
  // Every other pair shows up in one session only, or is one tool repeated. Nothing else is proposed.
  assert.equal(out.composites.length, 1);
});

test("structuredContent is preferred and --since filters old calls", async () => {
  const d = await mkdtemp(join(tmpdir(), "mine-test-"));
  try {
    const s = (id: string) => [{ ...search("q", id), text: "plain words " + id, structured: { hit: { id } } }, get(id)];
    await writeFile(join(d, "a.jsonl"), session(s("item-1")));
    await writeFile(join(d, "b.jsonl"), session(s("item-2")));
    const out = await mine(readToolCalls(d), { server: "acme", top: 1 });
    assert.deepEqual(out.composites[0]!.steps[1]!.args.id, { fromStep: 0, in: "structuredContent", path: ["hit", "id"] });
    const recent = await mine(readToolCalls(d), { server: "acme", top: 1, since: new Date("2026-11-05T00:00:00Z") });
    assert.equal(recent.calls, 0);
    assert.equal(recent.composites.length, 0);
  } finally {
    await rm(d, { recursive: true });
  }
});

test("a value seen only in plain text is reported but not mapped", async () => {
  const d = await mkdtemp(join(tmpdir(), "mine-test-"));
  try {
    const s = (id: string) => [{ ...search("q", id), text: `Found ${id} in the index` }, get(id)];
    await writeFile(join(d, "a.jsonl"), session(s("item-1")));
    await writeFile(join(d, "b.jsonl"), session(s("item-2")));
    const out = await mine(readToolCalls(d), { server: "acme", top: 1 });
    const step = out.composites[0]!.steps[1]!;
    assert.deepEqual(step.args.id, { input: "id" });
    assert.deepEqual(step.evidence.id, { present: 2, fromPath: 0, inPlainText: 2, echoOfInput: 0 });
    assert.equal(out.composites[0]!.support.dataFlowShare, 1);
  } finally {
    await rm(d, { recursive: true });
  }
});

test("a result that only echoes an earlier input is not data flow", async () => {
  const d = await mkdtemp(join(tmpdir(), "mine-test-"));
  try {
    // describe(names) returns the same name, then call(name) uses it. The caller already knew it.
    const s = (tool: string) => [
      { name: "mcp__acme__describe", input: { names: [tool] }, text: JSON.stringify({ tools: [{ name: tool }] }) },
      { name: "mcp__acme__call", input: { name: tool } },
    ];
    await writeFile(join(d, "a.jsonl"), session(s("tool-one")));
    await writeFile(join(d, "b.jsonl"), session(s("tool-two")));
    const out = await mine(readToolCalls(d), { server: "acme", top: 1 });
    const step = out.composites[0]!.steps[1]!;
    assert.deepEqual(step.args.name, { input: "name" });
    assert.deepEqual(step.evidence.name, { present: 2, fromPath: 0, inPlainText: 0, echoOfInput: 2 });
    assert.equal(out.composites[0]!.support.dataFlowShare, 0);
  } finally {
    await rm(d, { recursive: true });
  }
});
