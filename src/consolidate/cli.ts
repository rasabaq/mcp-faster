// mcp-faster mine: find chains of MCP calls that recur across sessions and propose composites.
// The output is a proposals file for a human to review. Nothing runs until a composite has "approved": true.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { validateToolName } from "@modelcontextprotocol/sdk/shared/toolNameValidation.js";
import { jsonText, type ArgSource, type Composite } from "./index.ts";
import { readToolCalls, type ToolCall } from "../transcripts.ts";

const MIN_LEN = 2;
const MAX_LEN = 4;
// A chain seen in one session only is a habit of that session, not a workflow.
const MIN_SESSIONS = 2;

const usage = "usage: mcp-faster mine --server <name> [--transcripts <dir>] [--since <days>] [--top 3] [--out proposals.json]";

export async function main(argv: string[]): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        server: { type: "string" },
        transcripts: { type: "string", default: join(homedir(), ".claude", "projects") },
        since: { type: "string" },
        top: { type: "string", default: "3" },
        out: { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${usage}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(values.transcripts)) {
    console.error(`No transcripts folder at ${values.transcripts}`);
    process.exitCode = 1;
    return;
  }
  const top = Number(values.top);
  const since = values.since === undefined ? undefined : Number(values.since);
  if (!values.server || !Number.isInteger(top) || top < 1 || (since !== undefined && !(since > 0))) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const result = await mine(readToolCalls(values.transcripts), {
    server: values.server,
    since: since === undefined ? undefined : new Date(Date.now() - since * 86_400_000),
    top,
  });
  const json = JSON.stringify(result, null, 2) + "\n";
  if (values.out) await writeFile(values.out, json);
  else process.stdout.write(json);

  console.error(`${result.calls} calls to "${result.server}" in ${result.sessions} sessions.`);
  if (result.composites.length === 0) console.error(`No chain seen in ${MIN_SESSIONS} or more sessions.`);
  for (const c of result.composites) {
    const s = c.support;
    console.error(`- ${c.steps.map((x) => x.tool).join(" -> ")}: ${s.count} times, ${s.sessions} sessions (${pct(s.sessionShare)}), data flow in ${pct(s.dataFlowShare)}`);
  }
  if (values.out) console.error(`Wrote ${values.out}. Review it and set "approved": true on the composites you want.`);
}

interface Call {
  tool: string;
  input: Record<string, unknown>;
  /** Missing when the session ended before the result came back. */
  result?: Pick<ToolCall, "content" | "structuredContent" | "isError">;
}

interface ArgEvidence {
  /** Times the argument was passed at this step. */
  present: number;
  /** Times it equalled the value at the proposed path in an earlier result. */
  fromPath: number;
  /** Times it was found only inside plain (non-JSON) result text, so no path can be proposed. */
  inPlainText: number;
  /** Times it was already in an earlier step's input. The caller had it, so it is not data flow. */
  echoOfInput: number;
}

export interface Proposal extends Composite {
  steps: (Composite["steps"][number] & { evidence: Record<string, ArgEvidence> })[];
  support: { count: number; sessions: number; sessionShare: number; dataFlowShare: number };
}

export interface Proposals {
  server: string;
  generatedAt: string;
  since?: string;
  sessions: number;
  calls: number;
  composites: Proposal[];
}

export async function mine(
  toolCalls: AsyncIterable<ToolCall>,
  opts: { server: string; since?: Date; top: number },
): Promise<Proposals> {
  const prefix = `mcp__${opts.server}__`;
  const sessions = new Map<string, Call[]>();
  let calls = 0;
  for await (const c of toolCalls) {
    if (!c.name.startsWith(prefix)) continue;
    if (opts.since && c.start < opts.since.getTime()) continue;
    const input = c.input && typeof c.input === "object" && !Array.isArray(c.input) ? (c.input as Record<string, unknown>) : {};
    // One transcript file is one session. A subagent file counts as its own session.
    let list = sessions.get(c.file);
    if (!list) sessions.set(c.file, (list = []));
    list.push({ tool: c.name.slice(prefix.length), input, result: c.end === undefined ? undefined : c });
    calls++;
  }

  // Every contiguous run of 2 to 4 calls, keyed by its tool names.
  // ponytail: O(calls * MAX_LEN) in memory, fine for months of logs; use a suffix tree if that grows.
  const chains = new Map<string, { tools: string[]; occurrences: Call[][]; sessions: Set<string> }>();
  for (const [session, list] of sessions) {
    for (let len = MIN_LEN; len <= MAX_LEN; len++) {
      for (let i = 0; i + len <= list.length; i++) {
        const run = list.slice(i, i + len);
        const tools = run.map((c) => c.tool);
        const key = tools.join("\n");
        let chain = chains.get(key);
        if (!chain) chains.set(key, (chain = { tools, occurrences: [], sessions: new Set() }));
        chain.occurrences.push(run);
        chain.sessions.add(session);
      }
    }
  }

  // One tool called again and again is a loop, not a chain. A fixed-length composite does not fit it;
  // the tool needs a batch argument instead. So we skip runs made of a single tool.
  const candidates = [...chains.values()].filter(
    (c) => c.sessions.size >= MIN_SESSIONS && new Set(c.tools).size > 1,
  );
  // Drop a chain when a longer chain contains it and happens just as often: the longer one says more.
  const closed = candidates.filter(
    (c) => !candidates.some((d) => d.tools.length > c.tools.length && d.occurrences.length >= c.occurrences.length && contains(d.tools, c.tools)),
  );

  const proposals = closed.map((c) => propose(c.tools, c.occurrences, c.sessions.size, sessions.size));
  // Rank: sessions first (how general), then data flow (how real the link is), then raw count.
  proposals.sort(
    (a, b) =>
      b.support.sessions - a.support.sessions ||
      b.support.dataFlowShare - a.support.dataFlowShare ||
      b.support.count - a.support.count,
  );

  return {
    server: opts.server,
    generatedAt: new Date().toISOString(),
    since: opts.since?.toISOString(),
    sessions: sessions.size,
    calls,
    composites: proposals.slice(0, opts.top),
  };
}

function propose(tools: string[], occurrences: Call[][], sessions: number, totalSessions: number): Proposal {
  const usedInputs = new Set<string>();
  const flowSeen = new Set<Call[]>();

  const steps = tools.map((tool, j) => {
    const args: Record<string, ArgSource> = {};
    const evidence: Record<string, ArgEvidence> = {};
    const argNames = new Set(occurrences.flatMap((run) => Object.keys(run[j]!.input)));
    for (const arg of argNames) {
      const e: ArgEvidence = { present: 0, fromPath: 0, inPlainText: 0, echoOfInput: 0 };
      const paths = new Map<string, { source: ArgSource; n: number }>();
      for (const run of occurrences) {
        const value = run[j]!.input[arg];
        if (value === undefined) continue;
        e.present++;
        const hit = findInEarlierResults(value, run, j);
        if (hit === "echo") {
          e.echoOfInput++;
          continue;
        }
        if (hit === "plain") e.inPlainText++;
        else if (hit) {
          const key = JSON.stringify(hit);
          const p = paths.get(key) ?? { source: hit, n: 0 };
          p.n++;
          paths.set(key, p);
        }
        if (hit) flowSeen.add(run);
      }
      const best = [...paths.values()].sort((a, b) => b.n - a.n)[0];
      e.fromPath = best?.n ?? 0;
      evidence[arg] = e;
      // Propose a mapping only when the same path explains at least half of the uses.
      if (best && best.n * 2 >= e.present) {
        args[arg] = best.source;
      } else {
        const name = usedInputs.has(arg) ? `${arg}_${j + 1}` : arg;
        usedInputs.add(name);
        args[arg] = { input: name };
      }
    }
    return { tool, args, evidence };
  });

  const joined = tools.join("_then_");
  const name = validateToolName(joined).isValid ? joined : `chain_${tools.length}_${Math.abs(hash(joined))}`;
  return {
    name,
    description: `Seen ${occurrences.length} times in ${sessions} sessions.`,
    approved: false,
    allowNonReadOnly: false,
    steps,
    support: {
      count: occurrences.length,
      sessions,
      sessionShare: round(sessions / totalSessions),
      dataFlowShare: round(flowSeen.size / occurrences.length),
    },
  };
}

/**
 * Looks for `value` in the results of steps before `j`, nearest first.
 * Returns a path source, "plain" when it only shows up inside non-JSON text, "echo" when an earlier
 * step's input already held it (results often repeat their input), or undefined.
 */
function findInEarlierResults(value: unknown, run: Call[], j: number): ArgSource | "plain" | "echo" | undefined {
  if (!distinctive(value)) return undefined;
  if (run.slice(0, j).some((c) => findPath(c.input, value))) return "echo";
  let plain = false;
  for (let k = j - 1; k >= 0; k--) {
    const r = run[k]!.result;
    if (!r || r.isError) continue;
    for (const from of ["structuredContent", "text"] as const) {
      const root = from === "structuredContent" ? r.structuredContent : jsonText(r.content);
      const path = findPath(root, value);
      if (path) return { fromStep: k, in: from, path };
    }
    if (typeof value === "string" && r.content.some((c) => (c as { text?: unknown })?.text?.toString().includes(value))) plain = true;
  }
  return plain ? "plain" : undefined;
}

// ponytail: exact match of whole scalar values only, so ids built into a URL or nested arg fields are missed;
// add substring templates and nested arg paths if real data shows them.
function distinctive(value: unknown): boolean {
  if (typeof value === "string") return value.length >= 3;
  if (typeof value === "number") return Math.abs(value) >= 10;
  return false;
}

function findPath(node: unknown, value: unknown, path: (string | number)[] = []): (string | number)[] | undefined {
  if (node === value) return path;
  if (node === null || typeof node !== "object") return undefined;
  const entries: [string | number, unknown][] = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  for (const [k, v] of entries) {
    const found = findPath(v, value, [...path, k]);
    if (found) return found;
  }
  return undefined;
}

function contains(long: string[], short: string[]): boolean {
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, k) => long[i + k] === t)) return true;
  }
  return false;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

const round = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 100)}%`;
