// Reads Claude Code session transcripts (~/.claude/projects/<slug>/**/*.jsonl).
// Each .jsonl file is one session. Subagent runs live in their own files under
// <slug>/<session>/subagents/ and count as their own sessions.
//
// Format facts (checked on real files, Claude Code late 2026):
// - Tool calls are `tool_use` items in `message.content` of lines with `type: "assistant"`.
// - Results are `tool_result` items in later lines with `type: "user"`, linked by `tool_use_id`.
//   `content` is a string or an array of `{type: "text" | "image", ...}`. `is_error` is set on failure.
// - MCP structured output, when present, is in the user line at `mcpMeta.structuredContent`.
// - Lines with other types (for example `api-request-blob`) repeat the same items. We skip them,
//   or every call would be counted twice.
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ToolCall {
  /** Path of the transcript file. One file is one session. */
  session: string;
  /** Full tool name, for example `mcp__github__search_issues`. */
  name: string;
  input: unknown;
  /** ISO time of the call. */
  timestamp?: string;
  /** Missing when the session ended before the result came back. */
  result?: {
    content: unknown[];
    structuredContent?: unknown;
    isError: boolean;
  };
}

/** Yields every tool call in every transcript under `dir`, in file order. */
export async function* readToolCalls(dir: string): AsyncGenerator<ToolCall> {
  const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".jsonl")).sort();
  for (const file of files) yield* readFile(join(dir, file));
}

async function* readFile(path: string): AsyncGenerator<ToolCall> {
  // ponytail: keeps one session in memory to attach results in call order, stream per call if sessions get huge.
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn last line or junk, not our problem
    }
    const items = row?.message?.content;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (row.type === "assistant" && item?.type === "tool_use" && typeof item.name === "string") {
        if (byId.has(item.id)) continue;
        const call: ToolCall = { session: path, name: item.name, input: item.input, timestamp: row.timestamp };
        calls.push(call);
        byId.set(item.id, call);
      } else if (row.type === "user" && item?.type === "tool_result") {
        const call = byId.get(item.tool_use_id);
        if (!call || call.result) continue;
        const content = typeof item.content === "string" ? [{ type: "text", text: item.content }] : item.content;
        call.result = {
          content: Array.isArray(content) ? content : [],
          structuredContent: row.mcpMeta?.structuredContent,
          isError: item.is_error === true,
        };
      }
    }
  }
  yield* calls;
}
