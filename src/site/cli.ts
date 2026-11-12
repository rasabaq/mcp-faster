// npm run site:data: writes site/data.js, the numbers the web page shows.
// Not part of the npm package. It reads your own Claude Code logs and a bench results file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildReport } from "../stats/cli.ts";
import { defaultLogsDir } from "../stats/logs.ts";
import { benchWarnings, buildBench, buildStats, render, type BenchInput, type StatsInput } from "./data.ts";

// Defaults are found from the repo, so the command works from any folder.
const ROOT = resolve(import.meta.dirname, "../..");

const USAGE = `usage: node src/site/cli.ts [--stats <file.json>] [--bench <file.json>] [--out <file>]

  --stats <file>  a file saved from "mcp-faster stats --json" (default: read the live logs)
  --bench <file>  a bench results file (default: the newest *.json in bench-results/)
  --out <file>    where to write (default: site/data.js)`;

function readJson(file: string, what: string): unknown {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`cannot read the ${what} file ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the ${what} file ${file} is not JSON`);
  }
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

function checkStats(v: unknown, file: string): StatsInput {
  const ok =
    isObject(v) && isNum(v.logs?.files) && isNum(v.transcripts?.files) && Array.isArray(v.servers) &&
    v.servers.every(
      (s) =>
        isObject(s) && typeof s.server === "string" && isObject(s.connectMs) && Array.isArray(s.tools) &&
        [s.sessions, s.idleSessions, s.connectFailures, s.drops, s.calls, s.totalMs, s.totalTokens].every(isNum) &&
        s.tools.every((t: unknown) => isObject(t) && typeof t.tool === "string" && isNum(t.calls) && isObject(t.durationMs)),
    );
  if (!ok) throw new Error(`${file} does not look like the output of "mcp-faster stats --json"`);
  return v as StatsInput;
}

function checkBench(v: unknown, file: string): BenchInput {
  const ok =
    isObject(v) && typeof v.model === "string" && [v.runsPerCell, v.plannedRuns, v.completedRuns, v.spentUsd].every(isNum) &&
    Array.isArray(v.rows) && v.rows.length > 0 &&
    v.rows.every(
      (r) =>
        isObject(r) && typeof r.task === "string" && typeof r.strategy === "string" && typeof r.ok === "boolean" &&
        [r.calls, r.defTokens, r.resultTokens, r.wallMs, r.usage?.costUsd].every(isNum),
    );
  if (!ok) throw new Error(`${file} does not look like a bench results file with model runs`);
  return v as BenchInput;
}

function newestBench(): string {
  const dir = join(ROOT, "bench-results");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    // no folder: same error as an empty folder
  }
  // The names start with an ISO date, so the last one by name is the newest.
  const last = names.at(-1);
  if (!last) throw new Error(`no bench results in ${dir}/. Pass --bench <file.json>`);
  return join(dir, last);
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      stats: { type: "string" },
      bench: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const benchFile = values.bench ?? newestBench();
  const bench = buildBench(checkBench(readJson(benchFile, "bench"), benchFile));

  let report: StatsInput;
  if (values.stats) {
    report = checkStats(readJson(values.stats, "stats"), values.stats);
  } else {
    // Same folders as `mcp-faster stats`.
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    report = await buildReport({ logsDir: defaultLogsDir(), transcriptsDir: join(configDir, "projects") });
  }
  const { stats, hidden } = buildStats(report);

  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const asOf = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;

  const out = values.out ?? join(ROOT, "site/data.js");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, render({ asOf, stats, bench }));

  const t = stats.totals;
  const best = bench.ways.find((w) => w.id === bench.best)!;
  console.log(`Wrote ${out} (as of ${asOf})`);
  console.log(`Servers: ${t.servers - hidden.length} shown by name, ${hidden.length} hidden as "Custom server N"`);
  console.log(
    `Totals: ${t.sessions} sessions, ${t.idle} idle, ${t.failed} failed connects (connect ${pct(t.connect)}), ` +
      `${t.drops} drops, ${t.calls} calls (errors ${pct(t.errorRate)}), ${t.tokens} tokens`,
  );
  console.log(`Read ${stats.logFiles} log files and ${stats.transcriptFiles} transcript files`);
  console.log(`Bench: ${bench.modelName}, ${bench.runs} runs, $${bench.costUsd.toFixed(2)}. Best: ${best.id} (${best.ok}/${best.runs} right)`);
  // These names go on the page, so show them: a new tool name could name a client or a project.
  const published = stats.servers.flatMap((s) => s.tools.map((t) => `${s.name}/${t.name}`));
  console.log(`Tool names on the page (${published.length}): ${published.join(", ")}`);
  if (hidden.length) {
    console.error(`Hidden servers (not on the allowlist in src/site/data.ts): ${hidden.join(", ")}`);
  }
  for (const w of benchWarnings(bench)) {
    console.error(`warning: ${w}. Reread the page text about the local mirror in site/index.html.`);
  }
}

try {
  await run(process.argv.slice(2));
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
}
