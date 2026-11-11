// Four ways to expose the same fixture server to a model.
// Each strategy gives the tool list the model sees on turn one, and runs the model's tool calls.
// Every call is recorded as a Step, so metrics come from the same place for all four.
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { Fixture } from "./fixture.ts";
import { SHIPPED_SCRIPTS } from "./tasks.ts";

export const STRATEGIES = ["upfront", "search", "code", "mirror"] as const;
export type StrategyName = (typeof STRATEGIES)[number];

/** What the model would see for a tool: the fields a client forwards to a model API. */
export type ToolDef = Pick<Tool, "name" | "description" | "inputSchema">;
type Args = Record<string, unknown>;

export interface Step {
  tool: string;
  args: Args;
  result: CallToolResult;
  /** Calls that reached the fixture server during this step. */
  upstreamCalls: number;
  /** Simulated time of this step: server time plus local work. */
  ms: number;
}

export interface Strategy {
  name: StrategyName;
  tools: ToolDef[];
  call(tool: string, args: Args): Promise<CallToolResult>;
  steps: Step[];
  /** One-time cost paid before the first task (only the mirror has one). */
  setup: { upstreamCalls: number; ms: number };
}

/** Simulated time for work done on the client side: tool search, the script runner, a local SQL query. */
export const LOCAL_MS = 2;

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
export const resultText = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

export async function createStrategy(name: StrategyName, fx: Fixture): Promise<Strategy> {
  const all = (await fx.client.listTools()).tools;
  const defs: ToolDef[] = all.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const upstream = async (tool: string, args: Args) => (await fx.client.callTool({ name: tool, arguments: args })) as CallToolResult;

  let tools: ToolDef[] = defs;
  let exec = upstream;

  if (name === "search") {
    tools = [SEARCH_TOOL];
    const loaded = new Set<string>();
    exec = async (tool, args) => {
      if (tool === "search_tools") {
        const found = searchTools(defs, String(args.query ?? ""));
        for (const d of found) loaded.add(d.name);
        return text(found);
      }
      if (!loaded.has(tool)) return fail(`Tool ${tool} is not loaded. Call search_tools first.`);
      return upstream(tool, args);
    };
  }

  if (name === "code") {
    tools = [codeTool(defs)];
    exec = async (tool, args) => {
      if (tool !== "execute") return fail(`Unknown tool ${tool}.`);
      const script = String(args.script ?? "");
      // node:vm is not a security boundary. A script can escape the context and reach the host.
      // That is fine here only because we run nothing but the scripts shipped in tasks.ts.
      // ponytail: allow-list of shipped scripts, run model-written scripts in a separate process or container first.
      if (!SHIPPED_SCRIPTS.has(script)) return fail("Code mode only runs scripts shipped in src/bench/tasks.ts.");
      const api = Object.fromEntries(
        defs.map((d) => [d.name, async (a: Args) => {
          const r = await upstream(d.name, a);
          if (r.isError) throw new Error(resultText(r));
          return JSON.parse(resultText(r));
        }]),
      );
      try {
        const value = await vm.runInContext(`(async () => {\n${script}\n})()`, vm.createContext({ tools: api }), { timeout: 1000 });
        return text(value);
      } catch (e) {
        return fail(`Script failed: ${(e as Error).message}`);
      }
    };
  }

  let setup = { upstreamCalls: 0, ms: 0 };
  if (name === "mirror") {
    const writes = defs.filter((d) => all.find((t) => t.name === d.name)?.annotations?.readOnlyHint !== true);
    tools = [QUERY_TOOL, ...writes];
    const before = { ...fx.clock };
    const mirror = await backfill(upstream);
    setup = { upstreamCalls: fx.clock.calls - before.calls, ms: fx.clock.ms - before.ms };
    exec = async (tool, args) => {
      if (tool === "query") {
        try {
          mirror.db.exec("PRAGMA query_only = ON");
          return text(mirror.db.prepare(String(args.sql ?? "")).all());
        } catch (e) {
          return fail(`SQL error: ${(e as Error).message}`);
        } finally {
          mirror.db.exec("PRAGMA query_only = OFF");
        }
      }
      if (!writes.some((w) => w.name === tool)) return fail(`Unknown tool ${tool}.`);
      const r = await upstream(tool, args);
      // Write-through: read the changed issues back so the next query sees the change.
      if (!r.isError) {
        const ids = [args.issue_id, args.from_id, args.to_id, tool === "create_issue" ? JSON.parse(resultText(r)).id : undefined];
        for (const id of ids) if (typeof id === "string") await mirror.syncIssue(id);
      }
      return r;
    };
  }

  const steps: Step[] = [];
  return {
    name,
    tools,
    steps,
    setup,
    async call(tool, args) {
      const before = { ...fx.clock };
      const result = await exec(tool, args);
      const upstreamCalls = fx.clock.calls - before.calls;
      const local = upstreamCalls === 0 || name === "code" ? LOCAL_MS : 0;
      steps.push({ tool, args, result, upstreamCalls, ms: fx.clock.ms - before.ms + local });
      return result;
    },
  };
}

const SEARCH_TOOL: ToolDef = {
  name: "search_tools",
  description:
    "Search the available tools by keywords. Returns the full definition of up to 3 matching tools. " +
    "After a tool is returned here you can call it directly by name.",
  inputSchema: { type: "object", properties: { query: { type: "string", description: "Keywords, for example: list issues" } }, required: ["query"] },
};

/** Keyword match over tool name and description. Name hits count double. Ties go to the name in A-Z order. */
export function searchTools(defs: ToolDef[], query: string): ToolDef[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // ponytail: plain keyword scoring, swap in BM25 or embeddings if a real model cannot find tools with it.
  return defs
    .map((d) => {
      const name = d.name.replaceAll("_", " ");
      const desc = (d.description ?? "").toLowerCase();
      const score = words.reduce((s, w) => s + (name.includes(w) ? 2 : 0) + (desc.includes(w) ? 1 : 0), 0);
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.d.name.localeCompare(b.d.name))
    .slice(0, 3)
    .map((x) => x.d);
}

/** One tool that runs a script. Its description carries a short signature for every server tool. */
function codeTool(defs: ToolDef[]): ToolDef {
  const sig = (d: ToolDef) => {
    const props = (d.inputSchema.properties ?? {}) as Record<string, { type?: string; enum?: string[] }>;
    const required = new Set(d.inputSchema.required ?? []);
    const fields = Object.entries(props).map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${v.enum ? v.enum.map((e) => `"${e}"`).join("|") : (v.type ?? "any")}`);
    return `tools.${d.name}({${fields.join(", ")}}) - ${d.description}`;
  };
  return {
    name: "execute",
    description:
      "Run an async JavaScript function body. Call the tracker with `await tools.<name>(args)`; each call returns parsed JSON. " +
      "Use `return` to send a value back. Only the returned value is shown to you.\n" + defs.map(sig).join("\n"),
    inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
  };
}

const QUERY_TOOL: ToolDef = {
  name: "query",
  description:
    "Run one read-only SQLite SELECT over a local copy of the tracker. Tables:\n" +
    "users(id, name, email, team)\n" +
    "projects(key, name, lead_id)\n" +
    "milestones(id, project_key, title, due_on)\n" +
    "issues(id, project_key, title, description, status, priority, assignee_id, reporter_id, milestone_id, created_at, updated_at, resolution)\n" +
    "issue_labels(issue_id, label)\n" +
    "comments(id, issue_id, author_id, body, created_at)",
  inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
};

/** Copy the whole tracker into an in-memory SQLite database, through the public tools only. */
async function backfill(upstream: (tool: string, args: Args) => Promise<CallToolResult>) {
  const get = async (tool: string, args: Args = {}) => JSON.parse(resultText(await upstream(tool, args)));
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT, email TEXT, team TEXT);
    CREATE TABLE projects(key TEXT PRIMARY KEY, name TEXT, lead_id TEXT);
    CREATE TABLE milestones(id TEXT PRIMARY KEY, project_key TEXT, title TEXT, due_on TEXT);
    CREATE TABLE issues(id TEXT PRIMARY KEY, project_key TEXT, title TEXT, description TEXT, status TEXT, priority TEXT,
      assignee_id TEXT, reporter_id TEXT, milestone_id TEXT, created_at TEXT, updated_at TEXT, resolution TEXT);
    CREATE TABLE issue_labels(issue_id TEXT, label TEXT);
    CREATE TABLE comments(id TEXT PRIMARY KEY, issue_id TEXT, author_id TEXT, body TEXT, created_at TEXT);
  `);
  const putIssue = (i: any) => {
    db.prepare("INSERT OR REPLACE INTO issues VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      i.id, i.project.key, i.title, i.description, i.status, i.priority, i.assignee?.id ?? null, i.reporter.id,
      i.milestone?.id ?? null, i.created_at, i.updated_at, i.resolution);
    db.prepare("DELETE FROM issue_labels WHERE issue_id = ?").run(i.id);
    for (const l of i.labels) db.prepare("INSERT INTO issue_labels VALUES (?,?)").run(i.id, l);
  };
  const putComments = (id: string, comments: any[]) => {
    db.prepare("DELETE FROM comments WHERE issue_id = ?").run(id);
    for (const c of comments) db.prepare("INSERT INTO comments VALUES (?,?,?,?,?)").run(c.id, c.issue_id, c.author_id, c.body, c.created_at);
  };

  for (const u of await get("list_users")) db.prepare("INSERT INTO users VALUES (?,?,?,?)").run(u.id, u.name, u.email, u.team);
  for (const p of await get("list_projects")) {
    db.prepare("INSERT INTO projects VALUES (?,?,?)").run(p.key, p.name, p.lead_id);
    for (const m of await get("list_milestones", { project_key: p.key })) db.prepare("INSERT INTO milestones VALUES (?,?,?,?)").run(m.id, m.project_key, m.title, m.due_on);
    for (let page: number | null = 1; page; ) {
      const res = await get("list_issues", { project_key: p.key, page, per_page: 50 });
      for (const i of res.issues) {
        putIssue(i);
        putComments(i.id, await get("list_comments", { issue_id: i.id }));
      }
      page = res.next_page;
    }
  }
  // ponytail: full backfill per session and write-through on our own writes only, add incremental sync
  // (updated_since cursor) when the source can change outside the session.
  return {
    db,
    async syncIssue(id: string) {
      putIssue(await get("get_issue", { issue_id: id }));
      putComments(id, await get("list_comments", { issue_id: id }));
    },
  };
}
