// The real-model runner, tested offline with a fake fetch. No network call is made here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "./fixture.ts";
import { DEFAULT_SETTINGS, createModelRunner } from "./model.ts";
import { STRATEGIES, createStrategy } from "./strategies.ts";
import { TASKS } from "./tasks.ts";
import { formatModelTable, main, runModelBench } from "./cli.ts";

test("without --runner model, bench makes no network call", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no network in tests"); }) as typeof fetch;
  console.log = () => {};
  try {
    await main(["--json"]);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(calls, 0);
  assert.notEqual(process.exitCode, 1);
});

const KEY = "sk-ant-test-DO-NOT-LEAK-1234";
const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const toolUse = (name: string, input: unknown, id = "t1") =>
  ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage });
const answer = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string>; throws?: string };
/** A fake fetch. `reply` gets the parsed request body and the call number, and says what to send back. */
function fakeFetch(reply: (body: any, n: number) => Reply) {
  const bodies: any[] = [];
  const headers: Record<string, string>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    headers.push(init.headers as Record<string, string>);
    const r = reply(body, bodies.length);
    if (r.throws) throw new Error(r.throws);
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  return { f, bodies, headers };
}
const noSleep = async () => {};

async function withStrategy<T>(name: (typeof STRATEGIES)[number], fn: (s: Awaited<ReturnType<typeof createStrategy>>) => Promise<T>) {
  const fx = await startFixture();
  try {
    return await fn(await createStrategy(name, fx));
  } finally {
    await fx.close();
  }
}

test("tool calls go through strategy.call, and results go back to the model", async () => {
  const { f, bodies, headers } = fakeFetch((_b, n) => ({ json: n === 1 ? toolUse("list_projects", {}) : answer("3") }));
  const runner = createModelRunner({ apiKey: KEY, fetch: f, sleep: noSleep, log: () => {} });
  const t = await withStrategy("upfront", (s) => runner.run(s, TASKS[0]!));
  assert.equal(t.answer, "3");
  assert.deepEqual(t.steps.map((s) => s.tool), ["list_projects"]);
  assert.equal(t.usage!.turns, 2);
  const result = bodies[1].messages.at(-1).content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, "t1");
  assert.match(result.content, /CORE/);
  assert.equal(result.is_error, undefined);
  // Fixed settings on every request.
  for (const b of bodies) {
    assert.equal(b.model, DEFAULT_SETTINGS.model);
    assert.equal(b.system, DEFAULT_SETTINGS.system);
    assert.equal(b.max_tokens, DEFAULT_SETTINGS.maxTokens);
    assert.deepEqual(b.output_config, { effort: DEFAULT_SETTINGS.effort });
    assert.equal(b.temperature, undefined);
  }
  assert.equal(headers[0]!["x-api-key"], KEY);
  assert.equal(headers[0]!["anthropic-version"], DEFAULT_SETTINGS.apiVersion);
  // Cost from the published price: 2 calls x (1000 in x $2 + 100 out x $10) / 1M.
  assert.equal(t.usage!.costUsd.toFixed(6), (2 * (1000 * 2 + 100 * 10) / 1e6).toFixed(6));
});

test("tool errors go back to the model as is_error results, and tool search shows loaded tools without changing the tool list", async () => {
  const { f, bodies } = fakeFetch((_b, n) => ({
    json: [toolUse("list_projects", {}), toolUse("search_tools", { query: "list projects" }), toolUse("list_projects", {}), answer("3")][n - 1],
  }));
  const runner = createModelRunner({ apiKey: KEY, fetch: f, sleep: noSleep, log: () => {} });
  const t = await withStrategy("search", (s) => runner.run(s, TASKS[0]!));
  const first = bodies[1].messages.at(-1).content[0];
  assert.equal(first.is_error, true);
  assert.match(first.content, /not loaded/);
  assert.equal(t.steps.length, 3);
  assert.notEqual(t.steps[2]!.result.isError, true);
  // Every request sends the same tools list: search_tools, then every server tool hidden.
  for (const b of bodies) assert.deepEqual(b.tools, bodies[0].tools);
  assert.equal(bodies[0].tools[0].name, "search_tools");
  assert.ok(bodies[0].tools.slice(1).every((x: any) => x.defer_loading === true));
  // After the search, a system message shows the loaded tools. The history is append-only.
  const shown = bodies[2].messages.at(-1);
  assert.equal(shown.role, "system");
  assert.ok(shown.content.some((c: any) => c.type === "tool_addition" && c.tool.name === "list_projects"));
  assert.deepEqual(bodies[3].messages.slice(0, bodies[2].messages.length), bodies[2].messages);
});

test("429, 5xx and transport errors are retried with backoff, logged, and not counted as turns", async () => {
  const waits: number[] = [];
  const logs: string[] = [];
  const { f } = fakeFetch((_b, n) =>
    [
      { status: 429, text: "{}", headers: { "retry-after": "7" } },
      { status: 529, text: "{}" },
      { throws: "socket hang up" },
      { json: answer("3") },
    ][n - 1]!);
  const runner = createModelRunner({ apiKey: KEY, fetch: f, sleep: async (ms) => void waits.push(ms), log: (l) => logs.push(l) });
  const t = await withStrategy("upfront", (s) => runner.run(s, TASKS[0]!));
  assert.equal(t.answer, "3");
  assert.equal(t.usage!.turns, 1);
  assert.equal(t.usage!.retries, 3);
  assert.deepEqual(waits, [7000, 2000, 4000]);
  assert.equal(logs.length, 3);
  assert.match(logs[0]!, /HTTP 429/);
});

test("a 400 is not retried: the run crashes, kept apart from a wrong answer", async () => {
  const { f, bodies } = fakeFetch(() => ({ status: 400, text: '{"error":"bad"}' }));
  const runner = createModelRunner({ apiKey: KEY, fetch: f, sleep: noSleep, log: () => {} });
  await assert.rejects(withStrategy("upfront", (s) => runner.run(s, TASKS[0]!)), /API error 400/);
  assert.equal(bodies.length, 1);
});

test("the turn cap is one setting, the same for every strategy, and hitting it is a failure, not a crash", async () => {
  const fx = fakeFetch((b) => ({ json: toolUse(b.tools[0].name, {}) }));
  const runner = createModelRunner({ apiKey: KEY, fetch: fx.f, sleep: noSleep, log: () => {}, settings: { maxTurns: 3 } });
  for (const name of STRATEGIES) {
    const t = await withStrategy(name, (s) => runner.run(s, TASKS[0]!));
    assert.equal(t.usage!.turns, 3, name);
    assert.equal(t.usage!.hitTurnCap, true, name);
  }
  assert.equal(typeof DEFAULT_SETTINGS.maxTurns, "number");
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const capped = fakeFetch((b) => ({ json: toolUse(b.tools[0].name, {}) }));
  const { result } = await runModelBench({
    runs: 1, model: DEFAULT_SETTINGS.model, budgetUsd: 100, tasks: [TASKS[7]!], strategies: ["upfront"],
    apiKey: KEY, fetch: capped.f, log: () => {}, outDir: dir,
  });
  assert.equal(result.rows[0]!.usage!.turns, DEFAULT_SETTINGS.maxTurns);
  assert.equal(result.rows[0]!.ok, false);
  assert.equal(result.rows[0]!.error, undefined);
});

test("the budget stops new runs, and the run in progress finishes", async () => {
  // Each model call costs $1: 500,000 input tokens at $2 per million.
  const dollar = { ...answer("0"), usage: { ...usage, input_tokens: 500_000, output_tokens: 0 } };
  const { f, bodies } = fakeFetch(() => ({ json: dollar }));
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const { result } = await runModelBench({
    runs: 5, model: DEFAULT_SETTINGS.model, budgetUsd: 2.5, tasks: [TASKS[0]!], strategies: ["upfront"],
    apiKey: KEY, fetch: f, log: (l) => logs.push(l), outDir: dir,
  });
  assert.equal(result.completedRuns, 2);
  assert.equal(result.plannedRuns, 5);
  assert.equal(result.stoppedByBudget, true);
  assert.equal(result.spentUsd, 2);
  assert.equal(bodies.length, 2);
  assert.ok(logs.some((l) => /stopped after 2 of 5 runs/.test(l)));
});

test("the API key never shows up in logs, errors, the table or the results file", async () => {
  // The fake API echoes the key back in error bodies and in a transport error, the worst case.
  let n = 0;
  const { f } = fakeFetch((b) => {
    n++;
    if (n === 1) return { throws: `connect failed for ${KEY}` };
    if (n === 2) return { status: 503, text: `overloaded ${KEY}` };
    if (b.messages.length === 1 && n % 2 === 0) return { status: 401, text: `invalid x-api-key ${KEY}` };
    return { json: answer(`3 ${KEY}`) };
  });
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const { result, file } = await runModelBench({
    runs: 1, model: DEFAULT_SETTINGS.model, budgetUsd: 100, tasks: TASKS.slice(0, 2), strategies: ["upfront", "mirror"],
    apiKey: KEY, fetch: f, sleep: noSleep, log: (l) => logs.push(l), outDir: dir,
  });
  assert.ok(result.rows.some((r) => r.error), "expected at least one crash");
  const outputs = [logs.join("\n"), readFileSync(file, "utf8"), formatModelTable(result.rows), JSON.stringify(result)];
  for (const out of outputs) assert.ok(!out.includes(KEY), `key leaked into: ${out.slice(0, 200)}`);
  assert.ok(outputs[1]!.includes("[redacted]"));
});

test("a rejected key (401) stops the bench after the first run", async () => {
  const { f, bodies } = fakeFetch(() => ({ status: 401, text: '{"error":"invalid x-api-key"}' }));
  const logs: string[] = [];
  const { result } = await runModelBench({
    runs: 2, model: DEFAULT_SETTINGS.model, budgetUsd: 10, tasks: TASKS.slice(0, 2), strategies: STRATEGIES,
    apiKey: KEY, fetch: f, sleep: noSleep, log: (l) => logs.push(l), outDir: mkdtempSync(join(tmpdir(), "bench-")),
  });
  assert.equal(bodies.length, 1);
  assert.equal(result.completedRuns, 1);
  assert.equal(result.stoppedByRejectedKey, true);
  assert.equal(result.stoppedByBudget, false);
  assert.ok(logs.some((l) => /rejected the key/.test(l)));
});
