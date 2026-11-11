// mcp-faster bench [--json]
// mcp-faster bench --runner model [--runs N] [--model ID] [--budget USD] [--tasks a,b] [--strategies a,b] [--json]
// Runs every task under every strategy with a runner, and prints one table.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startFixture } from "./fixture.ts";
import { DEFAULT_SETTINGS, PRICES, RETRY, RunCrash, createModelRunner } from "./model.ts";
import { SCRIPT_TIMEOUT_MS } from "./sandbox.ts";
import { STRATEGIES, createStrategy, resultText, type StrategyName } from "./strategies.ts";
import { TASKS, oracle, type ModelUsage, type Runner, type Task } from "./tasks.ts";

export interface Row {
  task: string;
  strategy: StrategyName;
  ok: boolean;
  /** Set when the run crashed. A crash is not the same as a wrong answer. */
  error?: string;
  /** Tool calls the model makes. Each one is a model round trip. */
  calls: number;
  /** Calls that reach the server. Code mode and the mirror can make many per model call. */
  upstream: number;
  /** Tool definitions sent on turn one. */
  defTokens: number;
  /** All tool results the model reads, including tool definitions that tool search returns. */
  resultTokens: number;
  /** Text the model writes: tool arguments and scripts. */
  inputTokens: number;
  simMs: number;
  /** Real-model runs only: the run number in its cell (from 1), the final answer, real wall time, and API usage. */
  run?: number;
  answer?: string;
  wallMs?: number;
  usage?: ModelUsage;
}

/** chars / 4. Good enough to compare strategies, not to predict a bill. */
export const tokens = (s: string) => Math.ceil(s.length / 4);

export interface BenchOptions {
  runs?: number;
  tasks?: readonly Task[];
  strategies?: readonly StrategyName[];
  /** Asked before each run. Return false to stop starting new runs (the budget). */
  canStart?: () => boolean;
  onRow?: (row: Row, done: number, planned: number) => void;
}

/** Runs are ordered run by run, so a run stopped by the budget leaves every cell with about the same count. */
export async function runBench(runner: Runner = oracle, opts: BenchOptions = {}) {
  const { runs = 1, tasks = TASKS, strategies = STRATEGIES, canStart = () => true } = opts;
  const rows: Row[] = [];
  const setup: Partial<Record<StrategyName, { upstreamCalls: number; ms: number }>> = {};
  const planned = runs * tasks.length * strategies.length;
  let complete = true;
  outer: for (let run = 1; run <= runs; run++) {
    for (const task of tasks) {
      for (const name of strategies) {
        if (!canStart()) {
          complete = false;
          break outer;
        }
        const fx = await startFixture();
        try {
          const strategy = await createStrategy(name, fx);
          setup[name] = strategy.setup;
          let answer = "";
          let error: string | undefined;
          let usage: ModelUsage | undefined;
          const start = performance.now();
          try {
            ({ answer, usage } = await runner(strategy, task));
          } catch (e) {
            error = (e as Error).message;
            if (e instanceof RunCrash) usage = e.usage;
          }
          const wallMs = Math.round(performance.now() - start);
          const steps = strategy.steps;
          const row: Row = {
            task: task.id,
            strategy: name,
            ok: !error && !usage?.hitTurnCap && task.check(answer, fx.store),
            ...(error ? { error } : {}),
            calls: steps.length,
            upstream: steps.reduce((n, s) => n + s.upstreamCalls, 0),
            defTokens: tokens(JSON.stringify(strategy.tools)),
            resultTokens: steps.reduce((n, s) => n + tokens(resultText(s.result)), 0),
            inputTokens: steps.reduce((n, s) => n + tokens(JSON.stringify(s.args)), 0),
            simMs: steps.reduce((n, s) => n + s.ms, 0),
            // Wall time is only kept for model runs, so oracle rows stay the same from run to run.
            ...(usage ? { run, answer, wallMs, usage } : {}),
          };
          rows.push(row);
          opts.onRow?.(row, rows.length, planned);
        } finally {
          await fx.close();
        }
      }
    }
  }
  return { rows, setup, complete, planned };
}

const COLUMNS: [keyof Row, string][] = [
  ["task", "task"], ["strategy", "strategy"], ["ok", "ok"], ["calls", "calls"], ["upstream", "upstream"],
  ["defTokens", "def tok"], ["resultTokens", "result tok"], ["inputTokens", "input tok"], ["simMs", "sim ms"],
];

export function formatTable(rows: Row[], setup: Awaited<ReturnType<typeof runBench>>["setup"]): string {
  const totals = STRATEGIES.map((strategy) => {
    const mine = rows.filter((r) => r.strategy === strategy);
    const sum = (k: "calls" | "upstream" | "defTokens" | "resultTokens" | "inputTokens" | "simMs") => mine.reduce((n, r) => n + r[k], 0);
    return {
      task: "TOTAL", strategy, ok: `${mine.filter((r) => r.ok).length}/${mine.length}`,
      calls: sum("calls"), upstream: sum("upstream"), defTokens: sum("defTokens"),
      resultTokens: sum("resultTokens"), inputTokens: sum("inputTokens"), simMs: sum("simMs"),
    };
  });
  const cell = (r: Record<string, unknown>, k: string) => {
    const v = r[k];
    if (v === true) return "yes";
    if (v === false) return r.error ? "crash" : "no";
    return String(v);
  };
  const body = [...rows, ...totals] as Record<string, unknown>[];
  const widths = COLUMNS.map(([k, h]) => Math.max(h.length, ...body.map((r) => cell(r, k).length)));
  const line = (vals: string[]) => vals.map((v, i) => (i < 3 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  const out = [
    "ORACLE RUN: scripted best-case trajectories. These are not model results.",
    "A real model makes more calls, wrong calls, and retries. Use these numbers as a lower bound per strategy.",
    "",
    line(COLUMNS.map(([, h]) => h)),
    rule,
    ...rows.map((r) => line(COLUMNS.map(([k]) => cell(r as unknown as Record<string, unknown>, k)))),
    rule,
    ...totals.map((r) => line(COLUMNS.map(([k]) => cell(r, k)))),
    "",
    "calls: tool calls the model makes (model round trips). upstream: calls that reach the server.",
    "def tok: tool definitions sent on turn one. result tok: tool results read. input tok: arguments and scripts written.",
    "Tokens are estimated as characters / 4. Model think time and context re-sent on later turns are not counted.",
    "sim ms: simulated server time, plus 2 ms per local step. No real network.",
  ];
  if (setup.mirror) {
    out.push(`mirror: each task starts with a full backfill of ${setup.mirror.upstreamCalls} upstream calls and ${setup.mirror.ms} sim ms. That cost is not in the rows.`);
  }
  return out.join("\n");
}

// --- real-model runs ---

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** All input the model read: uncached, cache reads and cache writes. */
const allInput = (u: ModelUsage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** One line per task and strategy, then one TOTAL line per strategy. */
export function formatModelTable(rows: Row[]): string {
  const head = ["task", "strategy", "k", "ok", "pass^k", "crash", "cap", "turns", "calls", "in tok", "out tok", "$", "wall s"];
  const stats = (rs: Row[]) => {
    const u = rs.map((r) => r.usage!);
    return {
      crash: String(rs.filter((r) => r.error).length),
      cap: String(u.filter((x) => x.hitTurnCap).length),
      turns: String(median(u.map((x) => x.turns))),
      calls: String(median(rs.map((r) => r.calls))),
      in: String(Math.round(median(u.map(allInput)))),
      out: String(Math.round(median(u.map((x) => x.outputTokens)))),
      wall: (median(rs.map((r) => r.wallMs ?? 0)) / 1000).toFixed(1),
    };
  };
  const body: string[][] = [];
  const totals: string[][] = [];
  const tasks = [...new Set(rows.map((r) => r.task))];
  const strategies = STRATEGIES.filter((s) => rows.some((r) => r.strategy === s));
  for (const task of tasks) {
    for (const strategy of strategies) {
      const rs = rows.filter((r) => r.task === task && r.strategy === strategy);
      if (!rs.length) continue;
      const s = stats(rs);
      const ok = rs.filter((r) => r.ok).length;
      body.push([task, strategy, String(rs.length), `${ok}/${rs.length}`, ok === rs.length ? "yes" : "no", s.crash, s.cap,
        s.turns, s.calls, s.in, s.out, median(rs.map((r) => r.usage!.costUsd)).toFixed(4), s.wall]);
    }
  }
  for (const strategy of strategies) {
    const rs = rows.filter((r) => r.strategy === strategy);
    const s = stats(rs);
    const ok = rs.filter((r) => r.ok).length;
    const cells = tasks.filter((t) => rs.some((r) => r.task === t));
    const passK = cells.filter((t) => rs.filter((r) => r.task === t).every((r) => r.ok)).length;
    const cost = rs.reduce((n, r) => n + r.usage!.costUsd, 0);
    totals.push(["TOTAL", strategy, String(rs.length), `${ok}/${rs.length} (${Math.round((100 * ok) / rs.length)}%)`,
      `${passK}/${cells.length} tasks`, s.crash, s.cap, s.turns, s.calls, s.in, s.out, cost.toFixed(4), s.wall]);
  }
  const all = [head, ...body, ...totals];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const line = (vals: string[]) => vals.map((v, i) => (i < 2 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [
    line(head), rule, ...body.map(line), rule, ...totals.map(line), "",
    "k: runs. ok: runs that passed the checker. pass^k: every run passed. crash: the run threw (API failure), kept apart from wrong answers.",
    "cap: the run hit the turn cap (counted as a failure, not a crash).",
    "turns, calls, in tok, out tok, $, wall s: medians per run. In TOTAL rows, $ is the sum over all runs and the rest are medians.",
    "in tok: all input tokens the API billed, summed over every model call (uncached + cache read + cache write).",
  ].join("\n");
}

export interface ModelBenchOptions {
  runs: number;
  model: string;
  budgetUsd: number;
  tasks: readonly Task[];
  strategies: readonly StrategyName[];
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  outDir?: string;
}

/** Runs the benchmark with a real model, keeps to the budget, and writes the raw results to a JSON file. */
export async function runModelBench(o: ModelBenchOptions) {
  const redact = (s: string) => s.split(o.apiKey).join("[redacted]");
  const log = (line: string) => (o.log ?? ((l: string) => console.error(l)))(redact(line));
  const runner = createModelRunner({ apiKey: o.apiKey, settings: { model: o.model }, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.sleep ? { sleep: o.sleep } : {}), log });
  const started = new Date();
  const { rows, setup, complete, planned } = await runBench(runner.run, {
    runs: o.runs,
    tasks: o.tasks,
    strategies: o.strategies,
    // Stop starting runs once the next one could take the total past the budget. The guess is the costliest run so far.
    // A rejected key stops the bench too.
    canStart: () => !runner.keyRejected && runner.spentUsd + runner.maxRunUsd <= o.budgetUsd,
    onRow: (r, done, total) =>
      log(`[${done}/${total}] ${r.task} ${r.strategy} run ${r.run}: ${r.error ? `crash: ${r.error}` : r.ok ? "ok" : "wrong"}, ` +
        `${r.usage!.turns} turns, $${r.usage!.costUsd.toFixed(4)}, total $${runner.spentUsd.toFixed(4)}`),
  });
  if (runner.keyRejected) log("Stopped: the API rejected the key (401 or 403). Check ANTHROPIC_API_KEY.");
  else if (!complete) log(`Budget: stopped after ${rows.length} of ${planned} runs. Spent $${runner.spentUsd.toFixed(4)} of $${o.budgetUsd}.`);
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unknown";
    }
  };
  const raw = {
    date: started.toISOString(),
    model: runner.settings.model,
    commit: git("rev-parse", "HEAD"),
    uncommittedChanges: git("status", "--porcelain", "--", "src") !== "",
    settings: { ...runner.settings, retry: RETRY, scriptTimeoutMs: SCRIPT_TIMEOUT_MS, pricesUsdPerMTok: PRICES[runner.settings.model] },
    budgetUsd: o.budgetUsd,
    spentUsd: runner.spentUsd,
    runsPerCell: o.runs,
    plannedRuns: planned,
    completedRuns: rows.length,
    stoppedByBudget: !complete && !runner.keyRejected,
    stoppedByRejectedKey: runner.keyRejected,
    mirrorBackfill: setup.mirror,
    rows,
  };
  // A model answer or an API error body could echo the key. Redact once here, so no output can carry it.
  const result: typeof raw = JSON.parse(redact(JSON.stringify(raw)));
  const dir = o.outDir ?? "bench-results";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${started.toISOString().replace(/[:.]/g, "-")}-${runner.settings.model}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return { result, file };
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      runner: { type: "string", default: "oracle" },
      runs: { type: "string", default: "1" },
      model: { type: "string", default: DEFAULT_SETTINGS.model },
      budget: { type: "string", default: "5" },
      tasks: { type: "string" },
      strategies: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (values.runner === "model") {
    const pick = <T,>(all: readonly T[], list: string | undefined, key: (x: T) => string) => {
      if (!list) return all;
      const names = list.split(",");
      const bad = names.filter((n) => !all.some((x) => key(x) === n));
      if (bad.length) throw new Error(`Unknown: ${bad.join(", ")}. Known: ${all.map(key).join(", ")}.`);
      return all.filter((x) => names.includes(key(x)));
    };
    const runs = Number(values.runs);
    const budgetUsd = Number(values.budget);
    if (!(runs >= 1) || !(budgetUsd > 0)) throw new Error("--runs must be 1 or more and --budget more than 0.");
    const { result, file } = await runModelBench({
      runs,
      budgetUsd,
      model: values.model,
      tasks: pick(TASKS, values.tasks, (t) => t.id),
      strategies: pick(STRATEGIES, values.strategies, (s) => s),
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`MODEL RUN: ${result.model}, ${result.completedRuns}/${result.plannedRuns} runs, spent $${result.spentUsd.toFixed(4)} of $${result.budgetUsd}.`);
      console.log("");
      console.log(formatModelTable(result.rows));
    }
    console.error(`Raw results: ${file}`);
    return;
  }
  if (values.runner !== "oracle") throw new Error(`Unknown runner ${values.runner}. Use oracle or model.`);

  const { rows, setup } = await runBench();
  if (values.json) {
    console.log(JSON.stringify({
      runner: "oracle",
      note: "Scripted best-case trajectories, not model results. Tokens are characters / 4.",
      mirrorBackfill: setup.mirror,
      rows,
    }, null, 2));
  } else {
    console.log(formatTable(rows, setup));
  }
  if (rows.some((r) => !r.ok)) process.exitCode = 1;
}
