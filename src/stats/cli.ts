// mcp-faster stats: one table of what each MCP server and tool costs you,
// built from Claude Code's MCP logs and session transcripts.
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { defaultLogsDir, readLogs, serverKey, type ServerLog } from "./logs.ts";
import { readToolCalls, splitName, type ReadCounts } from "../transcripts.ts";

const USAGE = `usage: mcp-faster stats [--since <days>] [--logs <dir>] [--transcripts <dir>] [--json]

  --since <days>       only count events from the last <days> days
  --logs <dir>         Claude Code MCP logs (default: ${defaultLogsDir()})
  --transcripts <dir>  Claude Code session transcripts (default: ~/.claude/projects)
  --json               print JSON instead of a table`;

/** Nearest-rank percentile. Undefined for an empty list. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const p5090 = (v: number[]) => ({ p50: percentile(v, 50), p90: percentile(v, 90) });
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
/** Rough token estimate: 4 characters per token. */
const tokens = (chars: number) => Math.round(chars / 4);

/**
 * Splits "mcp__<server>__<tool>". A server named "Shop (EU)" shows up as "Shop__EU_",
 * so the first "__" is not enough. We pick the longest server name the logs know.
 */
export function splitTool(name: string, knownKeys: string[]): { server: string; tool: string } {
  const rest = name.slice("mcp__".length);
  const norm = serverKey(rest); // same length as rest, so indexes line up
  let best = "";
  for (const k of knownKeys) if (k.length > best.length && norm.startsWith(k + "--")) best = k;
  return best ? { server: rest.slice(0, best.length), tool: rest.slice(best.length + 2) } : splitName(name);
}

interface ToolAcc {
  calls: number;
  noResult: number;
  errors: number;
  durations: number[];
  fromLog: number;
  fromGap: number;
  chars: number[];
  images: number;
}

export interface Report {
  logsDir: string;
  transcriptsDir: string;
  since?: string;
  logs: ReadCounts;
  transcripts: ReadCounts;
  /** Calls whose time came from the transcript gap, because no MCP log line matched. */
  gapTimed: number;
  timed: number;
  noResult: number;
  images: number;
  servers: ReturnType<typeof serverRow>[];
}

function serverRow(name: string, log: ServerLog | undefined, tools: Map<string, ToolAcc>, calledSessions: Set<string>, usedIn: Set<string>) {
  const toolRows = [...tools].map(([tool, t]) => {
    const withResult = t.calls - t.noResult;
    return {
      tool,
      calls: t.calls,
      noResult: t.noResult,
      errorRate: withResult ? t.errors / withResult : undefined,
      durationMs: p5090(t.durations),
      // "log": real duration from the MCP log. "gap": time between tool_use and tool_result
      // in the transcript, which can include a permission prompt. "mix": some of each.
      durationSource: t.fromGap === 0 ? "log" : t.fromLog === 0 ? "gap" : "mix",
      resultChars: p5090(t.chars),
      resultTokens: p5090(t.chars.map(tokens)),
      totalMs: sum(t.durations),
      totalTokens: tokens(sum(t.chars)),
    };
  });
  toolRows.sort((a, b) => b.totalMs - a.totalMs || b.totalTokens - a.totalTokens || b.calls - a.calls);
  const connected = log?.connectedSessions ?? new Set<string>();
  const called = new Set([...calledSessions, ...(log?.calledSessions ?? [])]);
  const calls = sum(toolRows.map((t) => t.calls));
  const withResult = calls - sum(toolRows.map((t) => t.noResult));
  const errors = sum([...tools.values()].map((t) => t.errors));
  const connectMs = log?.connectMs ?? [];
  return {
    server: name,
    sessions: connected.size,
    idleSessions: [...connected].filter((s) => !called.has(s)).length,
    /** Project folders where it connected, and the ones where it was called at least once. */
    projects: log?.connectedIn.size ?? 0,
    usedIn: [...new Set([...usedIn, ...(log?.usedIn ?? [])])].sort(),
    connectMs: p5090(connectMs),
    connectFailures: log?.failures ?? 0,
    drops: log?.drops ?? 0,
    calls,
    errorRate: withResult ? errors / withResult : undefined,
    // Connect time (good and failed) plus call time. Servers connect in parallel at start,
    // so this is the cost you pay, not the time you wait.
    totalMs: sum(connectMs) + (log?.failedMs ?? 0) + sum(toolRows.map((t) => t.totalMs)),
    totalTokens: sum(toolRows.map((t) => t.totalTokens)),
    tools: toolRows,
  };
}

export async function buildReport(opts: { logsDir: string; transcriptsDir: string; since?: number }): Promise<Report> {
  const logCounts: ReadCounts = { files: 0, badLines: 0 };
  const trCounts: ReadCounts = { files: 0, badLines: 0 };
  const logs = await readLogs(opts.logsDir, { since: opts.since, counts: logCounts });
  const known = [...logs.keys()];
  const tools = new Map<string, Map<string, ToolAcc>>();
  const calledSessions = new Map<string, Set<string>>();
  const usedIn = new Map<string, Set<string>>();
  let gapTimed = 0;
  let noResult = 0;
  let images = 0;

  for await (const call of readToolCalls(opts.transcriptsDir, { since: opts.since, counts: trCounts })) {
    const raw = splitTool(call.name, known);
    const server = serverKey(raw.server);
    const perServer = tools.get(server) ?? new Map<string, ToolAcc>();
    tools.set(server, perServer);
    const t = perServer.get(raw.tool) ?? {
      calls: 0, noResult: 0, errors: 0, durations: [], fromLog: 0, fromGap: 0, chars: [], images: 0,
    };
    perServer.set(raw.tool, t);
    const sessions = calledSessions.get(server) ?? new Set<string>();
    calledSessions.set(server, sessions);
    sessions.add(call.sessionId);
    // The first folder under the transcripts folder is the project.
    const project = relative(opts.transcriptsDir, call.file).split(sep)[0]!;
    usedIn.set(server, (usedIn.get(server) ?? new Set()).add(project));
    t.calls++;
    if (call.end === undefined) {
      t.noResult++;
      noResult++;
      continue;
    }
    if (call.isError) t.errors++;
    t.chars.push(call.chars);
    t.images += call.images;
    images += call.images;
    // Prefer the real duration from the MCP log: same session and tool, logged between use and result.
    const list = logs.get(server)?.completions.get(`${call.sessionId}|${raw.tool}`);
    // Take the log line closest to the result. With two calls of one tool running at once,
    // "first line in the window" can hand the short call's line to the long call.
    const end = call.end;
    let i = -1;
    list?.forEach((c, j) => {
      if (c.ts < call.start - 1000 || c.ts > end + 1000) return;
      if (i < 0 || Math.abs(c.ts - end) < Math.abs(list[i]!.ts - end)) i = j;
    });
    if (list && i >= 0) {
      t.durations.push(list[i]!.ms);
      list.splice(i, 1); // one log line pays for one call
      t.fromLog++;
    } else {
      t.durations.push(call.end - call.start);
      t.fromGap++;
      gapTimed++;
    }
  }

  const names = new Set([...logs.keys(), ...tools.keys()]);
  const servers = [...names]
    .map((n) => serverRow(n, logs.get(n), tools.get(n) ?? new Map(), calledSessions.get(n) ?? new Set(), usedIn.get(n) ?? new Set()))
    .filter((s) => s.sessions || s.connectFailures || s.drops || s.calls)
    .sort((a, b) => b.totalMs - a.totalMs || b.totalTokens - a.totalTokens);
  return {
    logsDir: opts.logsDir,
    transcriptsDir: opts.transcriptsDir,
    since: opts.since === undefined ? undefined : new Date(opts.since).toISOString(),
    logs: logCounts,
    transcripts: trCounts,
    gapTimed,
    timed: sum(servers.map((s) => s.calls)) - noResult,
    noResult,
    images,
    servers,
  };
}

function ms(v: number | undefined): string {
  if (v === undefined) return "-";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) return `${(v / 60_000).toFixed(1)}m`;
  return `${(v / 3_600_000).toFixed(1)}h`;
}

function num(v: number | undefined): string {
  if (v === undefined) return "-";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

const pct = (v: number | undefined) => (v === undefined ? "-" : `${Math.round(v * 100)}%`);
const pair = (p: { p50?: number; p90?: number }, f: (v: number | undefined) => string) =>
  p.p50 === undefined ? "-" : `${f(p.p50)} / ${f(p.p90)}`;

/**
 * Servers that connect in many sessions and are called in almost none of them.
 * Each one costs a connect in every session. Turning it off per project is the cheapest speed-up.
 */
export function turnOff(servers: Pick<Report["servers"][number], "server" | "sessions" | "idleSessions" | "usedIn">[]): string[] {
  // ponytail: fixed cut-offs (5 sessions, 95% idle). Make them flags if people ask.
  const idle = servers.filter((s) => s.sessions >= 5 && s.idleSessions / s.sessions >= 0.95);
  if (!idle.length) return [];
  const lines = ["", "WHAT TO TURN OFF"];
  for (const s of idle) {
    const used = s.sessions - s.idleSessions;
    const where = s.usedIn.length ? ` Called only in: ${s.usedIn.slice(0, 3).join(", ")}${s.usedIn.length > 3 ? ` and ${s.usedIn.length - 3} more` : ""}.` : "";
    lines.push(`  ${s.server}: connected in ${s.sessions} sessions, ${used ? `called in ${used}` : "never called"}.${where}`);
  }
  lines.push(
    "How: start a session in a project where you do not need the server, run /mcp, and switch it off. Claude Code saves that per project.",
    'For claude.ai connectors (names that start with claude-ai-) you can switch all of them off for one project:',
    '  put "disableClaudeAiConnectors": true in <project>/.claude/settings.local.json.',
  );
  return lines;
}

export function renderTable(r: Report): string {
  const head = ["SERVER / TOOL", "SESS", "IDLE", "CONNECT p50/p90", "FAIL", "DROP", "CALLS", "ERR", "TIME p50/p90", "SRC", "RESULT chars p50/p90", "~TOKENS p50/p90", "TOTAL TIME", "TOTAL ~TOK"];
  const rows: string[][] = [head];
  for (const s of r.servers) {
    rows.push([s.server, String(s.sessions), String(s.idleSessions), pair(s.connectMs, ms), String(s.connectFailures), String(s.drops), String(s.calls), pct(s.errorRate), "", "", "", "", ms(s.totalMs), num(s.totalTokens)]);
    for (const t of s.tools) {
      rows.push([`  ${t.tool}`, "", "", "", "", "", String(t.calls), pct(t.errorRate), pair(t.durationMs, ms), t.durationSource, pair(t.resultChars, num), pair(t.resultTokens, num), ms(t.totalMs), num(t.totalTokens)]);
    }
  }
  const widths = head.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  const lines = rows.map((row) =>
    row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  ").trimEnd(),
  );
  const notes = [
    "",
    `Read ${r.logs.files} log files (${r.logs.badLines} bad lines skipped) and ${r.transcripts.files} transcript files (${r.transcripts.badLines} bad lines skipped).`,
    r.since ? `Only events since ${r.since}.` : "",
    "SESS: sessions that connected. IDLE: of those, sessions that never called the server. FAIL: failed connects. DROP: dropped connections.",
    "SRC log: call time measured by Claude Code (MCP log). SRC gap: time between call and result in the transcript.",
    `${r.gapTimed} of ${r.timed} calls are gap-timed. A gap can include time you spent on a permission prompt.`,
    "Tokens are estimated as characters / 4. Only text counts; " + `${r.images} image blocks are not in the sizes.`,
    `TOTAL TIME is connect time plus call time. Servers connect in parallel, so this is cost, not wait.`,
    r.noResult ? `${r.noResult} calls had no result (interrupted). They count as calls, not in time, size or errors.` : "",
  ];
  return [...lines, ...notes.filter((n, i) => i === 0 || n), ...turnOff(r.servers)].join("\n");
}

export async function main(argv: string[]): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        since: { type: "string" },
        logs: { type: "string" },
        transcripts: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  let since: number | undefined;
  if (values.since !== undefined) {
    const days = Number(values.since);
    if (!values.since.trim() || !Number.isFinite(days) || days <= 0) {
      console.error(`--since needs a positive number of days, got "${values.since}"`);
      process.exitCode = 1;
      return;
    }
    since = Date.now() - days * 86_400_000;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const report = await buildReport({
    logsDir: values.logs ?? defaultLogsDir(),
    transcriptsDir: values.transcripts ?? join(configDir, "projects"),
    since,
  });
  if (report.logs.files === 0) console.error(`warning: no MCP log files found in ${report.logsDir}`);
  if (report.transcripts.files === 0) console.error(`warning: no transcript files found in ${report.transcriptsDir}`);
  // Keep empty numbers as null in JSON, so every key is always there.
  console.log(values.json ? JSON.stringify(report, (_, v) => v ?? null, 2) : renderTable(report));
}
