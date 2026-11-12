// Builds the data behind the web page (site/data.js) from a stats report and a bench results file.
// Pure logic: no file access here. The command in ./cli.ts reads and writes the files.

export interface PageData {
  /** Day the data was built, "YYYY-MM-DD". */
  asOf: string;
  stats: Stats;
  bench: Bench;
}

export interface Stats {
  logFiles: number;
  transcriptFiles: number;
  totals: {
    servers: number;
    sessions: number;
    idle: number;
    /** Failed connects. */
    failed: number;
    drops: number;
    calls: number;
    /** Result tokens. */
    tokens: number;
    totalMs: number;
    /** sessions / (sessions + failed) */
    connect: number;
    /** 1 - drops / sessions */
    stay: number;
    /** 1 - idle / sessions */
    active: number;
    /** Weighted by calls. A server with no rate counts as 0. */
    errorRate: number;
  };
  /** Same order as `mcp-faster stats`: totalMs high to low, then tokens high to low. */
  servers: Server[];
}

export interface Server {
  /** Public name, or "Custom server N". */
  name: string;
  /** true: the real name and the tool names are hidden. */
  custom: boolean;
  sessions: number;
  idle: number;
  connectP50: number | null;
  connectP90: number | null;
  failed: number;
  drops: number;
  calls: number;
  /** 0..1, null when there are no calls with a result. */
  errorRate: number | null;
  totalMs: number;
  tokens: number;
  /** How many different tools were called. */
  toolsUsed: number;
  /** Top 3 tools by calls. Always [] for a custom server. */
  tools: { name: string; calls: number; p50Ms: number | null }[];
  connect: number;
  stay: number;
  used: number;
  clean: number;
  /** 0..1 */
  heat: number;
  state: "healthy" | "errors" | "idle" | "drops" | "fails";
}

export interface Bench {
  model: string;
  modelName: string;
  /** Distinct tasks. */
  tasks: number;
  runsPerTask: number;
  runs: number;
  costUsd: number;
  /** Id of the way with most right answers. Ties go to the lowest cost. */
  best: string;
  /** In order of first appearance in the results file. */
  ways: Way[];
}

export interface Way {
  id: string;
  /** Runs with the right answer. */
  ok: number;
  runs: number;
  defTokens: number;
  resultTokens: number;
  seconds: number;
  calls: number;
  costUsd: number;
}

/** The parts of a stats report (`mcp-faster stats --json`) that the page uses. */
export interface StatsInput {
  logs: { files: number };
  transcripts: { files: number };
  servers: {
    server: string;
    sessions: number;
    idleSessions: number;
    connectMs: { p50?: number | null; p90?: number | null };
    connectFailures: number;
    drops: number;
    calls: number;
    errorRate?: number | null;
    totalMs: number;
    totalTokens: number;
    tools: { tool: string; calls: number; durationMs: { p50?: number | null } }[];
  }[];
}

/** The parts of a bench results file that the page uses. */
export interface BenchInput {
  model: string;
  runsPerCell: number;
  plannedRuns: number;
  completedRuns: number;
  stoppedByBudget?: boolean;
  stoppedByRejectedKey?: boolean;
  spentUsd: number;
  rows: {
    task: string;
    strategy: string;
    ok: boolean;
    calls: number;
    defTokens: number;
    resultTokens: number;
    wallMs: number;
    usage: { costUsd: number };
  }[];
}

const same = (names: string[]) => names.map((n) => [n, n] as const);

/**
 * Servers that keep their name on the page: raw name from the logs -> public name.
 * Every other server is shown as "Custom server N". Add a name here only if it may be public.
 */
export const PUBLIC_SERVERS: ReadonlyMap<string, string> = new Map([
  ["claude-ai-Notion", "Notion"],
  ["claude-ai-Slack", "Slack"],
  ["claude-ai-Claude-Docs", "Claude Docs"],
  ["claude-ai-Spaceship", "Spaceship"],
  ["claude-ai-Cloudflare-Developer-Platform", "Cloudflare"],
  ["claude-ai-Google-Docs", "Google Docs"],
  ["Claude-Browser", "Claude Browser"],
  ["claude-ai-PuroChile", "PuroChile"],
  ["claude-ai-Google-Sheets", "Google Sheets"],
  ["claude-ai-Gmail", "Gmail"],
  ["claude-ai-Google-Drive", "Google Drive"],
  ["claude-ai-Google-Calendar", "Google Calendar"],
  ...same([
    "openbot", "tokens", "t3-code", "parque", "claude-artifacts", "claude-in-chrome", "github",
    "code-review-graph", "warehouse", "reason-network", "slack-tickets", "purochile", "tickets-v2",
    "ccd-directory", "easel", "tickets-fast2", "tickets-fast", "tickets-plain", "ccd-turn",
    "ccd-session", "ccd-pr",
  ]),
]);

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const cents = (v: number) => Math.round(v * 100) / 100;
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

/** Median. For an even count: the mean of the two middle values. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The heat score of one server: how well it connects, stays up, gets used and answers without errors. */
export function heatScore(s: { sessions: number; idle: number; failed: number; drops: number; calls: number; errorRate: number | null }) {
  const tries = s.sessions + s.failed;
  const connect = tries ? s.sessions / tries : 1;
  const stay = s.sessions ? 1 - Math.min(1, s.drops / s.sessions) : 1;
  const idleShare = s.sessions ? s.idle / s.sessions : 0;
  const callPart = Math.min(1, Math.log10(1 + s.calls) / 3); // 1,000 calls counts as full
  const used = 0.12 + 0.88 * (0.5 * callPart + 0.5 * (1 - idleShare));
  const err = s.errorRate ?? 0;
  const clean = 1 - err;
  const state: Server["state"] =
    connect < 0.8 ? "fails"
    : stay < 0.8 ? "drops"
    : s.calls === 0 || (idleShare > 0.9 && s.calls < 500) ? "idle"
    : err > 0.1 ? "errors"
    : "healthy";
  return { connect: round4(connect), stay: round4(stay), used: round4(used), clean: round4(clean), heat: round4(connect * stay * used * clean), state };
}

/**
 * Turns a stats report into the public part of the page data. Only the fields listed here are
 * copied, so paths and project names in the report cannot leak. `hidden` holds the raw names
 * of the servers that were renamed; it is for the person running the script, not for the page.
 */
export function buildStats(report: StatsInput): { stats: Stats; hidden: string[] } {
  // An empty report would show "NaN%" and empty sections, so refuse it.
  if (!report.servers.length) throw new Error("the stats report has no MCP servers");
  if (!report.logs.files) throw new Error("the stats report read no MCP log files, so it has no sessions");
  const hidden: string[] = [];
  const servers = report.servers.map((s): Server => {
    const publicName = PUBLIC_SERVERS.get(s.server);
    if (publicName === undefined) hidden.push(s.server);
    const base = {
      sessions: s.sessions,
      idle: s.idleSessions,
      failed: s.connectFailures,
      drops: s.drops,
      calls: s.calls,
      errorRate: s.errorRate == null ? null : round4(s.errorRate),
    };
    return {
      name: publicName ?? `Custom server ${hidden.length}`,
      custom: publicName === undefined,
      sessions: base.sessions,
      idle: base.idle,
      connectP50: s.connectMs.p50 ?? null,
      connectP90: s.connectMs.p90 ?? null,
      failed: base.failed,
      drops: base.drops,
      calls: base.calls,
      errorRate: base.errorRate,
      totalMs: s.totalMs,
      tokens: s.totalTokens,
      toolsUsed: s.tools.length,
      tools:
        publicName === undefined
          ? []
          : [...s.tools] // sort is stable, so ties keep the stats order
              .sort((a, b) => b.calls - a.calls)
              .slice(0, 3)
              .map((t) => ({ name: t.tool, calls: t.calls, p50Ms: t.durationMs.p50 ?? null })),
      // The score uses the exact error rate, not the rounded one.
      ...heatScore({ ...base, errorRate: s.errorRate ?? null }),
    };
  });

  const total = (f: (s: Server) => number) => sum(servers.map(f));
  const sessions = total((s) => s.sessions);
  const idle = total((s) => s.idle);
  const failed = total((s) => s.failed);
  const drops = total((s) => s.drops);
  const calls = total((s) => s.calls);
  const errors = sum(report.servers.map((s) => (s.errorRate ?? 0) * s.calls));
  return {
    hidden,
    stats: {
      logFiles: report.logs.files,
      transcriptFiles: report.transcripts.files,
      totals: {
        servers: servers.length,
        sessions,
        idle,
        failed,
        drops,
        calls,
        tokens: total((s) => s.tokens),
        totalMs: total((s) => s.totalMs),
        connect: round4(sessions + failed ? sessions / (sessions + failed) : 1),
        stay: round4(sessions ? 1 - drops / sessions : 1),
        active: round4(sessions ? 1 - idle / sessions : 1),
        errorRate: round4(calls ? errors / calls : 0),
      },
      servers,
    },
  };
}

/** "claude-sonnet-5-5" -> "Claude Sonnet 5.5". A date at the end ("-20251001") is dropped. */
export function modelName(id: string): string {
  const words: string[] = [];
  const version: string[] = [];
  for (const part of id.split("-")) {
    if (/^\d{8}$/.test(part)) continue;
    if (/^\d+$/.test(part)) version.push(part);
    else words.push(part[0]!.toUpperCase() + part.slice(1));
  }
  return [...words, ...(version.length ? [version.join(".")] : [])].join(" ");
}

/** The page has a place for each of these ways, and for no others. */
export const WAYS = ["upfront", "search", "code", "mirror"];

/**
 * Turns a bench results file into the bench part of the page data.
 * Throws for a run the page cannot show truthfully: a stopped run, other ways than the four,
 * or ways with different run counts (their costs would not be comparable).
 */
export function buildBench(result: BenchInput): Bench {
  if (result.stoppedByBudget || result.stoppedByRejectedKey || result.completedRuns !== result.plannedRuns) {
    throw new Error(`the bench run did not finish (${result.completedRuns} of ${result.plannedRuns} runs)`);
  }
  const byWay = Map.groupBy(result.rows, (r) => r.strategy); // keeps the order of first appearance
  const ids = [...byWay.keys()];
  if (ids.length !== WAYS.length || !WAYS.every((w) => byWay.has(w))) {
    throw new Error(`the bench run must have exactly the ways ${WAYS.join(", ")}; it has ${ids.join(", ")}`);
  }
  const counts = new Set([...byWay.values()].map((rows) => rows.length));
  if (counts.size !== 1) throw new Error("the ways in the bench run have different numbers of runs");
  const exactCost = new Map<string, number>();
  const ways = [...byWay].map(([id, rows]): Way => {
    exactCost.set(id, sum(rows.map((r) => r.usage.costUsd)));
    return {
      id,
      ok: rows.filter((r) => r.ok).length,
      runs: rows.length,
      defTokens: Math.round(median(rows.map((r) => r.defTokens))),
      resultTokens: Math.round(median(rows.map((r) => r.resultTokens))),
      seconds: Math.round(median(rows.map((r) => r.wallMs)) / 100) / 10,
      calls: median(rows.map((r) => r.calls)),
      costUsd: cents(exactCost.get(id)!),
    };
  });
  const best = [...ways].sort((a, b) => b.ok - a.ok || exactCost.get(a.id)! - exactCost.get(b.id)!)[0]!;
  return {
    model: result.model,
    modelName: modelName(result.model),
    tasks: new Set(result.rows.map((r) => r.task)).size,
    runsPerTask: result.runsPerCell,
    runs: result.completedRuns,
    costUsd: cents(result.spentUsd),
    best: best.id,
    ways,
  };
}

/**
 * The page's words say the local mirror wins: it is right every time, and faster, cheaper and
 * smaller than all upfront, and code mode comes second on cost. Returns one line for each claim
 * the new data breaks, so the person refreshing the page knows which words to reread.
 */
export function benchWarnings(bench: Bench): string[] {
  const way = (id: string) => bench.ways.find((w) => w.id === id)!;
  const [mirror, upfront] = [way("mirror"), way("upfront")];
  const byCost = [...bench.ways].sort((a, b) => a.costUsd - b.costUsd).map((w) => w.id);
  const out: string[] = [];
  if (bench.best !== "mirror") out.push(`the best way is "${bench.best}", not the local mirror`);
  if (mirror.ok < mirror.runs) out.push(`the local mirror got ${mirror.ok} of ${mirror.runs} right, not every answer`);
  if (mirror.seconds >= upfront.seconds) out.push("the local mirror is not faster than all upfront");
  if (mirror.costUsd >= upfront.costUsd) out.push("the local mirror is not cheaper than all upfront");
  if (mirror.resultTokens >= upfront.resultTokens) out.push("the local mirror's results are not smaller than all upfront");
  if (byCost[0] !== "mirror" || byCost[1] !== "code") out.push(`the order by cost is ${byCost.join(", ")}, not mirror then code`);
  return out;
}

/** The text of site/data.js: an ES module with one default export. */
export function render(data: PageData): string {
  return `// Generated by \`npm run site:data\`. Do not edit by hand.\nexport default ${JSON.stringify(data, null, 2)};\n`;
}
