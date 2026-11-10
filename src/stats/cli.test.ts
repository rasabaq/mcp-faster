import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReport, main, percentile, renderTable, splitTool } from "./cli.ts";
import { parseDuration } from "./logs.ts";

test("percentile uses nearest rank", () => {
  const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
  assert.equal(percentile(ten, 50), 5);
  assert.equal(percentile(ten, 90), 9);
  assert.equal(percentile(ten, 100), 10);
  assert.equal(percentile([42], 90), 42);
  assert.equal(percentile([], 50), undefined);
});

test("parseDuration reads the log formats", () => {
  assert.equal(parseDuration("10ms"), 10);
  assert.equal(parseDuration("4s"), 4000);
  assert.equal(parseDuration("1m 5s"), 65_000);
  assert.equal(parseDuration("soon"), undefined);
});

test("splitTool uses known server names that hold __", () => {
  // Server "Shop (EU)": log folder "Shop--EU-", tool names "mcp__Shop__EU___get".
  assert.deepEqual(splitTool("mcp__Shop__EU___get_order", ["Shop--EU-", "Shop"]), { server: "Shop__EU_", tool: "get_order" });
  assert.deepEqual(splitTool("mcp__other__x", ["Shop--EU-"]), { server: "other", tool: "x" });
});

// Synthetic data, relative to now so --since can be tested through main().
const NOW = Date.now();
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), "stats-cli-"));
  const logs = join(root, "logs");
  const transcripts = join(root, "projects");
  const log = (session: string, ms: number, debug: string) => JSON.stringify({ debug, timestamp: at(ms), sessionId: session, cwd: "/tmp/x" });
  const t = NOW - DAY; // yesterday
  const old = NOW - 10 * DAY;

  mkdirSync(join(logs, "-tmp-x", "mcp-logs-my-shop"), { recursive: true });
  writeFileSync(
    join(logs, "-tmp-x", "mcp-logs-my-shop", "a.jsonl"),
    [
      log("s1", t, "Starting connection with timeout of 30000ms"),
      log("s1", t + 1, "Successfully connected (transport: stdio) in 100ms"),
      log("s2", t, "Successfully connected (transport: stdio) in 300ms"), // s2 never calls
      log("s3", t, "Connection failed after 5000ms (CONNECTION_CLOSED): Connection closed"),
      log("s3", t, "Authentication required for claude.ai proxy server"),
      log("s1", t + 50, "HTTP connection dropped after 60s uptime"),
      log("s1", t + 1000, "Calling MCP tool: get_order"),
      log("s1", t + 1250, "Tool 'get_order' completed successfully in 250ms"),
      log("old", old, "Successfully connected (transport: stdio) in 9000ms"),
      "{oops", // bad line
    ].join("\n"),
  );

  mkdirSync(join(transcripts, "-tmp-x"), { recursive: true });
  const use = (id: string, tool: string, ms: number) =>
    JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name: `mcp__my_shop__${tool}`, input: {} }] } });
  const res = (id: string, ms: number, text: string, isError = false) =>
    JSON.stringify({ type: "user", sessionId: "s1", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
  writeFileSync(
    join(transcripts, "-tmp-x", "s1.jsonl"),
    [
      // Logged call: real time 250ms, but the user sat on a prompt for 30s.
      use("c1", "get_order", t + 900), res("c1", t + 31_000, "x".repeat(400)),
      // Not in the logs: time comes from the gap (2s).
      use("c2", "list_orders", t + 40_000), res("c2", t + 42_000, "y".repeat(40), true),
      use("c3", "list_orders", old), res("c3", old + 5000, "z"),
    ].join("\n"),
  );
  return { logs, transcripts };
}

test("buildReport joins logs and transcripts", async () => {
  const { logs, transcripts } = fixtures();
  const r = await buildReport({ logsDir: logs, transcriptsDir: transcripts });
  assert.equal(r.logs.files, 1);
  assert.equal(r.logs.badLines, 1);
  assert.equal(r.transcripts.files, 1);
  assert.equal(r.servers.length, 1);
  const s = r.servers[0]!;
  assert.equal(s.server, "my-shop");
  assert.equal(s.sessions, 3); // s1, s2, old
  assert.equal(s.idleSessions, 2); // s2, old
  assert.deepEqual(s.connectMs, { p50: 300, p90: 9000 });
  assert.equal(s.connectFailures, 2);
  assert.equal(s.drops, 1);
  assert.equal(s.calls, 3);
  assert.equal(s.totalMs, 100 + 300 + 9000 + 5000 + 250 + 2000 + 5000);

  const byName = Object.fromEntries(s.tools.map((x) => [x.tool, x]));
  assert.equal(byName.get_order!.durationSource, "log");
  assert.deepEqual(byName.get_order!.durationMs, { p50: 250, p90: 250 });
  assert.deepEqual(byName.get_order!.resultTokens, { p50: 100, p90: 100 });
  assert.equal(byName.list_orders!.durationSource, "gap");
  assert.deepEqual(byName.list_orders!.durationMs, { p50: 2000, p90: 5000 });
  assert.equal(byName.list_orders!.errorRate, 0.5);
  assert.equal(r.gapTimed, 2);
  assert.match(renderTable(r), /my-shop/);
});

test("--since drops old events, --json prints the report", async () => {
  const { logs, transcripts } = fixtures();
  const out: string[] = [];
  const log = console.log;
  console.log = (s: string) => out.push(s);
  try {
    await main(["--since", "2", "--logs", logs, "--transcripts", transcripts, "--json"]);
  } finally {
    console.log = log;
  }
  const s = JSON.parse(out.join("\n")).servers[0];
  assert.equal(s.sessions, 2); // "old" is gone
  assert.deepEqual(s.connectMs, { p50: 100, p90: 300 });
  assert.equal(s.calls, 2); // c3 is gone
});

test("--since must be a positive number", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    for (const bad of ["0", "-1", "abc", ""]) {
      process.exitCode = 0;
      await main(["--since", bad]);
      assert.equal(process.exitCode, 1, bad);
    }
  } finally {
    console.error = err;
    process.exitCode = 0;
  }
});

test("two calls of one tool at the same time each get their own log line", async () => {
  const root = mkdtempSync(join(tmpdir(), "stats-overlap-"));
  const t = NOW - DAY;
  const line = (o: object) => JSON.stringify({ sessionId: "s1", ...o });
  mkdirSync(join(root, "logs", "-tmp-x", "mcp-logs-shop"), { recursive: true });
  writeFileSync(
    join(root, "logs", "-tmp-x", "mcp-logs-shop", "a.jsonl"),
    [
      line({ timestamp: at(t + 3000), debug: "Tool 'sync' completed successfully in 2s" }),
      line({ timestamp: at(t + 10_000), debug: "Tool 'sync' completed successfully in 9s" }),
    ].join("\n"),
  );
  const use = (id: string, ms: number) => line({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name: "mcp__shop__sync", input: {} }] } });
  const res = (id: string, ms: number) => line({ type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  mkdirSync(join(root, "projects", "-tmp-x"), { recursive: true });
  // The long call starts first and ends last. The short call's log line also falls inside its window.
  writeFileSync(join(root, "projects", "-tmp-x", "s1.jsonl"), [use("long", t), use("short", t + 100), res("short", t + 3000), res("long", t + 10_000)].join("\n"));

  const r = await buildReport({ logsDir: join(root, "logs"), transcriptsDir: join(root, "projects") });
  assert.equal(r.gapTimed, 0);
  assert.deepEqual(r.servers[0]!.tools[0]!.durationMs, { p50: 2000, p90: 9000 });
});
