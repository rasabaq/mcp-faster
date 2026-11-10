// Reads Claude Code MCP logs: <dir>/<project-slug>/mcp-logs-<server>/<start-time>.jsonl
// Each line is {debug|error, timestamp, sessionId, cwd}. The messages we use:
//   "Successfully connected (transport: stdio) in 812ms"   -> connect time
//   "Connection failed after 3001ms (CODE): ..."            -> connect failure
//   "Authentication required for claude.ai proxy server"    -> connect failure (no time)
//   "HTTP connection dropped after 6838s uptime"            -> drop
//   "Calling MCP tool: send_message"                        -> the session used this server
//   "Tool 'send_message' completed successfully in 2s"      -> real call duration
//   "Tool 'send_message' failed after 0s: ..."              -> real call duration
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { jsonlFiles, type ReadCounts } from "../transcripts.ts";

export interface Completion {
  /** Epoch ms of the log line. */
  ts: number;
  ms: number;
}

export interface ServerLog {
  connectMs: number[];
  /** Time spent on failed connects, where the log says it. */
  failedMs: number;
  failures: number;
  drops: number;
  connectedSessions: Set<string>;
  calledSessions: Set<string>;
  /** Key: `${sessionId}|${tool}`. Sorted by ts once reading is done. */
  completions: Map<string, Completion[]>;
}

/** Where Claude Code keeps MCP logs: the env-paths cache folder for "claude-cli" (suffix "nodejs"). */
export function defaultLogsDir(): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Caches", "claude-cli-nodejs");
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "claude-cli-nodejs", "Cache");
  }
  return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "claude-cli-nodejs");
}

/**
 * Server names in log folders and in tool names differ ("claude-ai-Gmail" vs "claude_ai_Gmail").
 * Claude Code names the log folder with every non-alphanumeric character turned into "-".
 * ponytail: it also cuts very long names and adds a hash; those servers will not join with
 * their tool calls. Port that hash if it shows up in real logs.
 */
export function serverKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-");
}

/** "10ms" | "4s" | "1m 5s" -> ms. Undefined if the text has another shape. */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)m )?(\d+)(ms|s)$/.exec(text);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 60_000 + Number(m[2]) * (m[3] === "ms" ? 1 : 1000);
}

const CONNECTED = /^Successfully connected \(transport: [^)]*\) in (\d+)ms/;
const FAILED = /^Connection failed after (\d+)ms/;
// ponytail: durations above 1s come rounded to whole seconds in the log text.
// For ms precision, pair "Calling MCP tool" and "Tool ... completed" timestamps instead.
const TOOL_DONE = /^Tool '(.+?)' (?:completed successfully in|failed after) ((?:\d+m )?\d+m?s)(?::|$)/;

function emptyServer(): ServerLog {
  return {
    connectMs: [],
    failedMs: 0,
    failures: 0,
    drops: 0,
    connectedSessions: new Set(),
    calledSessions: new Set(),
    completions: new Map(),
  };
}

/** Reads every MCP log under `dir`. Keys of the result are serverKey() names. */
export async function readLogs(
  dir: string,
  opts: { since?: number; counts?: ReadCounts } = {},
): Promise<Map<string, ServerLog>> {
  const since = opts.since ?? 0;
  const counts = opts.counts ?? { files: 0, badLines: 0 };
  const servers = new Map<string, ServerLog>();
  let projects: string[];
  try {
    projects = await readdir(dir);
  } catch {
    return servers;
  }
  for (const project of projects.sort()) {
    let folders: string[];
    try {
      folders = await readdir(join(dir, project));
    } catch {
      continue; // not a folder
    }
    for (const folder of folders.sort()) {
      if (!folder.startsWith("mcp-logs-")) continue;
      const key = serverKey(folder.slice("mcp-logs-".length));
      const s = servers.get(key) ?? emptyServer();
      servers.set(key, s);
      for (const file of await jsonlFiles(join(dir, project, folder), since)) {
        counts.files++;
        for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
          if (!line.trim()) continue;
          let entry: any;
          try {
            entry = JSON.parse(line);
          } catch {
            counts.badLines++;
            continue;
          }
          const ts = Date.parse(entry?.timestamp);
          if (Number.isNaN(ts)) {
            counts.badLines++;
            continue;
          }
          if (ts < since || typeof entry.debug !== "string") continue;
          const text: string = entry.debug;
          const session = String(entry.sessionId ?? "");
          let m: RegExpExecArray | null;
          if ((m = CONNECTED.exec(text))) {
            s.connectMs.push(Number(m[1]));
            s.connectedSessions.add(session);
          } else if ((m = FAILED.exec(text))) {
            s.failures++;
            s.failedMs += Number(m[1]);
          } else if (text.startsWith("Authentication required")) {
            s.failures++;
          } else if (/connection dropped after/i.test(text)) {
            s.drops++;
          } else if (text.startsWith("Calling MCP tool: ")) {
            s.calledSessions.add(session);
          } else if ((m = TOOL_DONE.exec(text))) {
            const ms = parseDuration(m[2]!);
            if (ms === undefined) continue;
            const k = `${session}|${m[1]}`;
            const list = s.completions.get(k) ?? [];
            list.push({ ts, ms });
            s.completions.set(k, list);
          }
        }
      }
    }
  }
  for (const s of servers.values()) for (const list of s.completions.values()) list.sort((a, b) => a.ts - b.ts);
  return servers;
}
