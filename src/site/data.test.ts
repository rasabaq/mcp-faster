import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { benchWarnings, buildBench, buildStats, heatScore, median, modelName, render, type BenchInput, type StatsInput } from "./data.ts";

const BENCH_FILE = "bench-results/2026-11-11T14-00-12-155Z-claude-sonnet-5-5.json";

// A server row like `mcp-faster stats --json` gives, with the private fields the page must drop.
function row(server: string, over: Partial<StatsInput["servers"][number]> = {}) {
  return {
    server,
    sessions: 10,
    idleSessions: 0,
    projects: 3,
    usedIn: ["-Users-someone-secret-project"],
    connectMs: { p50: 100, p90: 200 },
    connectFailures: 0,
    drops: 0,
    calls: 0,
    errorRate: null,
    totalMs: 0,
    totalTokens: 0,
    tools: [],
    ...over,
  };
}

const tool = (name: string, calls: number, p50: number | null = 50) => ({ tool: name, calls, durationMs: { p50, p90: 90 } });

function report(servers: StatsInput["servers"]) {
  return {
    logsDir: "/Users/someone/.claude/logs",
    transcriptsDir: "/Users/someone/.claude/projects",
    logs: { files: 12, badLines: 0 },
    transcripts: { files: 7, badLines: 0 },
    servers,
  };
}

test("median takes the mean of the two middle values", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("heat score follows the formula", () => {
  // tries 100, connect 0.8; stay 0.9; idleShare 0.5; callPart log10(100)/3; err 0.1
  const h = heatScore({ sessions: 80, idle: 40, failed: 20, drops: 8, calls: 99, errorRate: 0.1 });
  const used = 0.12 + 0.88 * (0.5 * (2 / 3) + 0.5 * 0.5);
  assert.equal(h.connect, 0.8);
  assert.equal(h.stay, 0.9);
  assert.equal(h.used, Math.round(used * 1e4) / 1e4);
  assert.equal(h.clean, 0.9);
  assert.equal(h.heat, Math.round(0.8 * 0.9 * used * 0.9 * 1e4) / 1e4);
  assert.equal(h.state, "healthy");
});

test("heat score handles a server with no sessions and caps the parts", () => {
  // Only failed connects: connect 0, so heat 0.
  assert.deepEqual(heatScore({ sessions: 0, idle: 0, failed: 3, drops: 0, calls: 0, errorRate: null }), {
    connect: 0, stay: 1, used: 0.56, clean: 1, heat: 0, state: "fails",
  });
  // Calls from transcripts only: nothing to divide by. 1,000 calls or more counts as full use.
  assert.deepEqual(heatScore({ sessions: 0, idle: 0, failed: 0, drops: 0, calls: 5000, errorRate: 0 }), {
    connect: 1, stay: 1, used: 1, clean: 1, heat: 1, state: "healthy",
  });
  // More drops than sessions: stay stops at 0.
  assert.equal(heatScore({ sessions: 2, idle: 0, failed: 0, drops: 5, calls: 1, errorRate: 0 }).stay, 0);
});

test("each of the 5 states, in order of priority", () => {
  const base = { sessions: 100, idle: 0, failed: 0, drops: 0, calls: 50, errorRate: 0 };
  const state = (over: Partial<typeof base>) => heatScore({ ...base, ...over }).state;
  assert.equal(state({}), "healthy");
  assert.equal(state({ errorRate: 0.11 }), "errors");
  assert.equal(state({ errorRate: 0.1 }), "healthy"); // the limit itself is fine
  assert.equal(state({ calls: 0 }), "idle");
  assert.equal(state({ idle: 95 }), "idle");
  assert.equal(state({ idle: 95, calls: 500 }), "healthy"); // mostly idle, but heavily used
  assert.equal(state({ idle: 90 }), "healthy"); // 0.9 is not above 0.9
  assert.equal(state({ drops: 21 }), "drops");
  assert.equal(state({ drops: 20 }), "healthy");
  assert.equal(state({ failed: 26 }), "fails");
  assert.equal(state({ failed: 25 }), "healthy"); // 100 / 125 = 0.8
  // The first match wins: fails, then drops, then idle, then errors.
  assert.equal(state({ failed: 50, drops: 50, calls: 0, errorRate: 1 }), "fails");
  assert.equal(state({ drops: 50, calls: 0, errorRate: 1 }), "drops");
  assert.equal(state({ calls: 0, errorRate: 1 }), "idle");
});

test("totals add up, with a call-weighted error rate", () => {
  const { stats } = buildStats(
    report([
      row("github", { sessions: 60, idleSessions: 30, connectFailures: 20, drops: 6, calls: 30, errorRate: 0.1, totalMs: 900, totalTokens: 400 }),
      row("easel", { sessions: 20, idleSessions: 10, connectFailures: 0, drops: 2, calls: 10, errorRate: 0.5, totalMs: 100, totalTokens: 50 }),
      row("tokens", { sessions: 20, idleSessions: 20, connectFailures: 5, drops: 0, calls: 0, errorRate: null, totalMs: 10 }),
    ]),
  );
  assert.equal(stats.logFiles, 12);
  assert.equal(stats.transcriptFiles, 7);
  assert.deepEqual(stats.totals, {
    servers: 3,
    sessions: 100,
    idle: 60,
    failed: 25,
    drops: 8,
    calls: 40,
    tokens: 450,
    totalMs: 1010,
    connect: 0.8, // 100 / 125
    stay: 0.92,
    active: 0.4,
    errorRate: 0.2, // (0.1 * 30 + 0.5 * 10 + 0) / 40
  });
});

test("totals do not divide by zero when no server has a session", () => {
  const { totals } = buildStats(report([row("github", { sessions: 0, calls: 0 })])).stats;
  assert.deepEqual([totals.connect, totals.stay, totals.active, totals.errorRate], [1, 1, 1, 0]);
});

test("an empty report is refused, so the page never shows NaN", () => {
  assert.throws(() => buildStats(report([])), /no MCP servers/);
  assert.throws(() => buildStats({ ...report([row("github")]), logs: { files: 0 } }), /no MCP log files/);
});

test("a server row keeps the numbers and rounds the rates to 4 decimals", () => {
  const { stats } = buildStats(
    report([
      row("claude-ai-Slack", {
        sessions: 9, idleSessions: 3, connectMs: { p50: 982, p90: 1396 }, connectFailures: 1, drops: 2, calls: 7,
        errorRate: 1 / 3, totalMs: 1234, totalTokens: 567, tools: [tool("read", 7, 437)],
      }),
      row("tokens", { connectMs: { p50: null, p90: null } }),
    ]),
  );
  const s = stats.servers[0]!;
  assert.deepEqual(
    { ...s, used: 0, heat: 0 },
    {
      name: "Slack", custom: false, sessions: 9, idle: 3, connectP50: 982, connectP90: 1396, failed: 1, drops: 2, calls: 7,
      errorRate: 0.3333, totalMs: 1234, tokens: 567, toolsUsed: 1, tools: [{ name: "read", calls: 7, p50Ms: 437 }],
      connect: 0.9, stay: 0.7778, used: 0, clean: 0.6667, heat: 0, state: "drops",
    },
  );
  assert.equal(stats.servers[1]!.connectP50, null);
  assert.equal(stats.servers[1]!.errorRate, null);
});

test("top 3 tools by calls, ties keep the stats order", () => {
  const { stats } = buildStats(
    report([row("github", { calls: 20, tools: [tool("slow", 2), tool("a", 5, null), tool("b", 5), tool("most", 8), tool("c", 5)] })]),
  );
  const s = stats.servers[0]!;
  assert.equal(s.toolsUsed, 5);
  assert.deepEqual(s.tools, [
    { name: "most", calls: 8, p50Ms: 50 },
    { name: "a", calls: 5, p50Ms: null },
    { name: "b", calls: 5, p50Ms: 50 },
  ]);
});

test("privacy: unknown servers lose their name and tools, and nothing private is rendered", () => {
  const input = report([
    row("acme-internal", { calls: 4, tools: [tool("fetch_payroll", 4)] }),
    row("claude-ai-Notion", { calls: 2, tools: [tool("notion-search", 2)] }),
    row("zeta-billing", { calls: 1, tools: [tool("list_invoices", 1)] }),
    row("Github", {}), // the allowlist is exact: another spelling is hidden
  ]);
  const { stats, hidden } = buildStats(input);
  // Numbered from 1 in output order.
  assert.deepEqual(stats.servers.map((s) => s.name), ["Custom server 1", "Notion", "Custom server 2", "Custom server 3"]);
  assert.deepEqual(stats.servers.map((s) => s.custom), [true, false, true, true]);
  assert.deepEqual(hidden, ["acme-internal", "zeta-billing", "Github"]);
  assert.deepEqual(stats.servers[0]!.tools, []);
  assert.equal(stats.servers[0]!.toolsUsed, 1); // the count stays, the names go
  assert.equal(stats.servers[0]!.calls, 4);

  const text = render({ asOf: "2026-01-02", stats, bench: buildBench(benchFixture()) });
  for (const secret of [
    "acme-internal", "zeta-billing", "Github", "fetch_payroll", "list_invoices", "claude-ai-Notion",
    "usedIn", "projects", "logsDir", "transcriptsDir", "secret-project", "someone", "/Users", ".claude",
  ]) {
    assert.ok(!text.includes(secret), `"${secret}" must not be in the output`);
  }
  assert.ok(text.includes("notion-search")); // a public server keeps its tool names
});

test("modelName reads the model id", () => {
  assert.equal(modelName("claude-sonnet-5-5"), "Claude Sonnet 5.5");
  assert.equal(modelName("claude-opus-5"), "Claude Opus 5");
  assert.equal(modelName("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
});

function benchFixture(): BenchInput {
  const r = (strategy: string, task: string, ok: boolean, costUsd: number) => ({
    task, strategy, ok, calls: 2, defTokens: 10, resultTokens: 20, wallMs: 1000, usage: { costUsd },
  });
  return {
    model: "claude-opus-5",
    runsPerCell: 1,
    plannedRuns: 8,
    completedRuns: 8,
    spentUsd: 1.308,
    rows: [
      r("search", "t1", true, 0.3), r("upfront", "t1", true, 0.004), r("mirror", "t1", true, 0.1), r("code", "t1", true, 0.2),
      r("search", "t2", true, 0.3), r("upfront", "t2", false, 0.004), r("mirror", "t2", true, 0.2), r("code", "t2", true, 0.2),
    ],
  };
}

test("bench: ways keep file order, best is most right answers, then lowest cost", () => {
  const b = buildBench(benchFixture());
  assert.deepEqual(b.ways.map((w) => w.id), ["search", "upfront", "mirror", "code"]);
  assert.equal(b.best, "mirror"); // search, mirror and code all have 2 right; mirror cost least
  assert.equal(b.tasks, 2);
  assert.equal(b.costUsd, 1.31);
  assert.deepEqual(b.ways[1], { id: "upfront", ok: 1, runs: 2, defTokens: 10, resultTokens: 20, seconds: 1, calls: 2, costUsd: 0.01 });
});

test("bench: a run the page cannot show truthfully is refused", () => {
  const f = benchFixture();
  assert.throws(() => buildBench({ ...f, completedRuns: 6 }), /did not finish \(6 of 8 runs\)/);
  assert.throws(() => buildBench({ ...f, stoppedByBudget: true }), /did not finish/);
  assert.throws(() => buildBench({ ...f, stoppedByRejectedKey: true }), /did not finish/);
  const without = (id: string) => f.rows.filter((r) => r.strategy !== id);
  assert.throws(() => buildBench({ ...f, rows: without("search") }), /exactly the ways upfront, search, code, mirror; it has upfront, mirror, code/);
  assert.throws(() => buildBench({ ...f, rows: [...f.rows, { ...f.rows[0]!, strategy: "other" }] }), /exactly the ways/);
  assert.throws(() => buildBench({ ...f, rows: f.rows.slice(0, -1) }), /different numbers of runs/);
  assert.throws(() => buildBench({ ...f, rows: [] }), /exactly the ways/);
});

test("bench warnings name each claim in the page text that the data breaks", () => {
  assert.deepEqual(benchWarnings(buildBench(JSON.parse(readFileSync(BENCH_FILE, "utf8")))), []);
  assert.deepEqual(benchWarnings(buildBench(benchFixture())), [
    "the local mirror is not faster than all upfront",
    "the local mirror is not cheaper than all upfront",
    "the local mirror's results are not smaller than all upfront",
    "the order by cost is upfront, mirror, code, search, not mirror then code",
  ]);
  const f = benchFixture();
  const wrong = { ...f, rows: f.rows.map((r) => (r.strategy === "mirror" && r.task === "t2" ? { ...r, ok: false } : r)) };
  const w = benchWarnings(buildBench(wrong));
  assert.ok(w.includes('the best way is "code", not the local mirror'));
  assert.ok(w.includes("the local mirror got 1 of 2 right, not every answer"));
});

test("bench: the committed Sonnet 5.5 results give the numbers on the page", () => {
  const b = buildBench(JSON.parse(readFileSync(BENCH_FILE, "utf8")));
  assert.deepEqual(b, {
    model: "claude-sonnet-5-5",
    modelName: "Claude Sonnet 5.5",
    tasks: 10,
    runsPerTask: 5,
    runs: 200,
    costUsd: 2.78,
    best: "mirror",
    ways: [
      { id: "upfront", ok: 46, runs: 50, defTokens: 1912, resultTokens: 2318, seconds: 4.6, calls: 3, costUsd: 0.85 },
      { id: "search", ok: 47, runs: 50, defTokens: 87, resultTokens: 2875, seconds: 6.8, calls: 5, costUsd: 1.4 },
      { id: "code", ok: 47, runs: 50, defTokens: 702, resultTokens: 247, seconds: 6.5, calls: 2, costUsd: 0.35 },
      { id: "mirror", ok: 50, runs: 50, defTokens: 1011, resultTokens: 91, seconds: 3.5, calls: 1, costUsd: 0.18 },
    ],
  });
});

test("the rendered file is an ES module with one default export", async () => {
  const data = {
    asOf: "2026-01-02",
    stats: buildStats(report([row("github", { calls: 3, tools: [tool("get_issue", 3)] })])).stats,
    bench: buildBench(benchFixture()),
  };
  const text = render(data);
  assert.ok(text.startsWith("// Generated by `npm run site:data`. Do not edit by hand.\nexport default {\n  \"asOf\""));
  const file = join(mkdtempSync(join(tmpdir(), "site-data-")), "data.js");
  writeFileSync(file, text);
  const mod = await import(pathToFileURL(file).href);
  assert.deepEqual(Object.keys(mod), ["default"]);
  assert.deepEqual(mod.default, data);
});
