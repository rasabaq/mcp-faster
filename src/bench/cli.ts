// mcp-faster bench [--json]
// Runs every task under every strategy with a runner, and prints one table.
import { startFixture } from "./fixture.ts";
import { STRATEGIES, createStrategy, resultText, type StrategyName } from "./strategies.ts";
import { TASKS, oracle, type Runner } from "./tasks.ts";

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
}

/** chars / 4. Good enough to compare strategies, not to predict a bill. */
export const tokens = (s: string) => Math.ceil(s.length / 4);

export async function runBench(runner: Runner = oracle) {
  const rows: Row[] = [];
  const setup: Partial<Record<StrategyName, { upstreamCalls: number; ms: number }>> = {};
  for (const task of TASKS) {
    for (const name of STRATEGIES) {
      const fx = await startFixture();
      try {
        const strategy = await createStrategy(name, fx);
        setup[name] = strategy.setup;
        let answer = "";
        let error: string | undefined;
        try {
          answer = (await runner(strategy, task)).answer;
        } catch (e) {
          error = (e as Error).message;
        }
        const steps = strategy.steps;
        rows.push({
          task: task.id,
          strategy: name,
          ok: !error && task.check(answer, fx.store),
          ...(error ? { error } : {}),
          calls: steps.length,
          upstream: steps.reduce((n, s) => n + s.upstreamCalls, 0),
          defTokens: tokens(JSON.stringify(strategy.tools)),
          resultTokens: steps.reduce((n, s) => n + tokens(resultText(s.result)), 0),
          inputTokens: steps.reduce((n, s) => n + tokens(JSON.stringify(s.args)), 0),
          simMs: steps.reduce((n, s) => n + s.ms, 0),
        });
      } finally {
        await fx.close();
      }
    }
  }
  return { rows, setup };
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

export async function main(argv: string[]): Promise<void> {
  const { rows, setup } = await runBench();
  if (argv.includes("--json")) {
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
