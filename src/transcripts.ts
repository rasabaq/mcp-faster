// Reads Claude Code session transcripts (~/.claude/projects/<slug>/**/*.jsonl)
// and yields one record per MCP tool call. Used by `stats` and `mine`.
//
// Each .jsonl file is one run. Subagent runs live in their own files under <slug>/<session>/subagents/.
// An assistant line holds a tool_use block (id, name "mcp__<server>__<tool>").
// A later user line in the same file holds the tool_result with the same tool_use_id.
// Transcripts carry no duration field. The only time we get here is the gap between
// the two line timestamps, and that gap also holds any time the user spent on a
// permission prompt. The line's permissionDecision does not tell that reliably:
// "user_temporary" calls often have a gap only a few ms longer than the real call.
// MCP structured output, when present, is in the user line at `mcpMeta.structuredContent`.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ToolCall {
  id: string;
  /** Path of the transcript file the call was found in. */
  file: string;
  sessionId: string;
  /** Full tool name, e.g. "mcp__github__get_issue". */
  name: string;
  /** Split on the first "__". Wrong when the server name itself holds "__"; the stats CLI fixes that with log folder names. */
  server: string;
  tool: string;
  input: unknown;
  /** Epoch ms of the tool_use line. */
  start: number;
  /** Epoch ms of the tool_result line. Undefined when no result was found (interrupted call). */
  end?: number;
  isError: boolean;
  /** Characters of text in the result. Image blocks are not counted here. */
  chars: number;
  images: number;
  /** Result content blocks. Empty when there is no result. */
  content: unknown[];
  structuredContent?: unknown;
}

export interface ReadCounts {
  files: number;
  badLines: number;
}

/** Splits "mcp__<server>__<tool>" on the first "__" after the prefix. */
export function splitName(name: string): { server: string; tool: string } {
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  return i < 0 ? { server: rest, tool: "" } : { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** All *.jsonl files under dir, skipping files not touched since `since` (epoch ms). */
export async function jsonlFiles(dir: string, since = 0): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(dir, n);
    // A file's lines are never newer than its mtime, so old files can be skipped whole.
    if (since && (await stat(p)).mtimeMs < since) continue;
    out.push(p);
  }
  return out;
}

const RESULT_ID = /"tool_use_id":"([^"]+)"/g;

/**
 * Yields every MCP tool call found under `dir`, deduplicated by tool_use id, file by file, in call order.
 * Calls whose tool_use line is older than `since` (epoch ms) are skipped.
 */
export async function* readToolCalls(
  dir: string,
  opts: { since?: number; counts?: ReadCounts } = {},
): AsyncGenerator<ToolCall> {
  const since = opts.since ?? 0;
  const counts = opts.counts ?? { files: 0, badLines: 0 };
  const seen = new Set<string>();
  for (const file of await jsonlFiles(dir, since)) {
    counts.files++;
    // ponytail: keeps one file's MCP calls in memory to yield them in call order. Stream per call if files get huge.
    const calls: ToolCall[] = [];
    const pending = new Map<string, ToolCall>();
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      // ponytail: we only JSON.parse lines that can hold an MCP call or a result we wait for.
      // That keeps 10 GB of transcripts fast, but a broken line elsewhere is not counted as bad.
      const maybeUse = line.includes('"mcp__');
      const maybeResult = pending.size > 0 && [...line.matchAll(RESULT_ID)].some((m) => pending.has(m[1]!));
      if (!maybeUse && !maybeResult) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        counts.badLines++;
        continue;
      }
      // Other line types (for example "api-request-blob") repeat old messages without a timestamp.
      if (entry?.type !== "assistant" && entry?.type !== "user") continue;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      const ts = Date.parse(entry.timestamp);
      if (Number.isNaN(ts)) {
        counts.badLines++;
        continue;
      }
      for (const block of content) {
        if (block?.type === "tool_use" && typeof block.name === "string" && block.name.startsWith("mcp__")) {
          if (typeof block.id !== "string" || seen.has(block.id) || ts < since) continue;
          seen.add(block.id);
          const call: ToolCall = {
            id: block.id,
            file,
            sessionId: String(entry.sessionId ?? ""),
            name: block.name,
            ...splitName(block.name),
            input: block.input,
            start: ts,
            isError: false,
            chars: 0,
            images: 0,
            content: [],
          };
          calls.push(call);
          pending.set(block.id, call);
        } else if (block?.type === "tool_result" && pending.has(block.tool_use_id)) {
          const call = pending.get(block.tool_use_id)!;
          pending.delete(block.tool_use_id);
          call.end = ts;
          call.isError = block.is_error === true;
          const parts = typeof block.content === "string" ? [{ type: "text", text: block.content }] : block.content;
          call.content = Array.isArray(parts) ? parts : [];
          call.structuredContent = entry.mcpMeta?.structuredContent;
          for (const p of call.content as any[]) {
            if (p?.type === "text" && typeof p.text === "string") call.chars += p.text.length;
            else if (p?.type === "image") call.images++;
          }
        }
      }
    }
    // A call with no `end` has no result: the session was stopped or the call was interrupted.
    yield* calls;
  }
}
