import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readToolCalls, splitName, type ToolCall } from "./transcripts.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function use(id: string, name: string, ms: number, sessionId = "s1") {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: at(ms),
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  });
}

function result(blocks: object[], ms: number) {
  return JSON.stringify({ type: "user", sessionId: "s1", timestamp: at(ms), message: { role: "user", content: blocks } });
}

async function collect(dir: string, since?: number) {
  const counts = { files: 0, badLines: 0 };
  const calls: ToolCall[] = [];
  for await (const c of readToolCalls(dir, { since, counts })) calls.push(c);
  return { calls: calls.sort((a, b) => a.id.localeCompare(b.id)), counts };
}

test("splitName splits on the first __", () => {
  assert.deepEqual(splitName("mcp__github__get_issue"), { server: "github", tool: "get_issue" });
  assert.deepEqual(splitName("mcp__a-b__c__d"), { server: "a-b", tool: "c__d" });
});

test("pairs tool_use with tool_result and measures size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-tr-"));
  mkdirSync(join(dir, "proj", "sess", "subagents"), { recursive: true });
  writeFileSync(
    join(dir, "proj", "a.jsonl"),
    [
      use("u1", "mcp__github__get_issue", 0),
      use("u2", "mcp__github__search", 100),
      use("b1", "Bash", 150), // not MCP: ignored
      use("u4", "mcp__github__search", 120).slice(0, -10), // cut-off line: bad
      // Two results in one line, out of order.
      result(
        [
          { type: "tool_result", tool_use_id: "u2", content: "abcd", is_error: true },
          { type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "12345678" }, { type: "image", source: {} }] },
        ],
        2000,
      ),
      // A copy of an old request: no timestamp, other type. Must not count twice.
      JSON.stringify({ type: "api-request-blob", hash: "h", message: { content: [{ type: "tool_use", id: "u9", name: "mcp__x__y" }] } }),
      use("u3", "mcp__github__search", 3000), // never gets a result
    ].join("\n") + "\n",
  );
  // Same call copied into a second file (resumed session): counted once.
  writeFileSync(join(dir, "proj", "sess", "subagents", "b.jsonl"), use("u1", "mcp__github__get_issue", 0) + "\n");

  const { calls, counts } = await collect(dir);
  assert.equal(counts.files, 2);
  assert.equal(counts.badLines, 1);
  assert.deepEqual(
    calls.map((c) => [c.id, c.server, c.tool, c.end === undefined ? null : c.end - c.start, c.isError, c.chars, c.images]),
    [
      ["u1", "github", "get_issue", 2000, false, 8, 1],
      ["u2", "github", "search", 1900, true, 4, 0],
      ["u3", "github", "search", null, false, 0, 0],
    ],
  );
});

test("since skips older calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-tr-"));
  writeFileSync(
    join(dir, "a.jsonl"),
    [use("old", "mcp__s__t", 0), result([{ type: "tool_result", tool_use_id: "old", content: "x" }], 10),
     use("new", "mcp__s__t", 60_000), result([{ type: "tool_result", tool_use_id: "new", content: "x" }], 60_010)].join("\n"),
  );
  const { calls } = await collect(dir, T0 + 30_000);
  assert.deepEqual(calls.map((c) => c.id), ["new"]);
});
