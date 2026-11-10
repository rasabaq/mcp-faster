// A fake issue tracker exposed as a real MCP server, in process.
// The tools follow the vendor API shape on purpose: many small endpoints, paged lists,
// and verbose objects. All data comes from a fixed seed, so every run is the same.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface User { id: string; name: string; email: string; team: string }
export interface Project { key: string; name: string; lead_id: string }
export interface Milestone { id: string; project_key: string; title: string; due_on: string }
export interface Comment { id: string; issue_id: string; author_id: string; body: string; created_at: string }
export interface Event { issue_id: string; actor_id: string; kind: string; detail: string; at: string }
export interface Issue {
  id: string;
  project_key: string;
  title: string;
  description: string;
  status: "open" | "closed";
  priority: "P1" | "P2" | "P3";
  assignee_id: string | null;
  reporter_id: string;
  labels: string[];
  milestone_id: string | null;
  links: { type: string; issue_id: string }[];
  created_at: string;
  updated_at: string;
  resolution: string | null;
}
export interface Store {
  users: User[];
  projects: Project[];
  milestones: Milestone[];
  issues: Issue[];
  comments: Comment[];
  events: Event[];
}

export const ISSUES_PER_PROJECT = 60;
const LABELS = ["bug", "feature", "docs", "duplicate", "perf", "security"];
const BASE = Date.parse("2026-01-05T09:00:00Z");
const DAY = 86_400_000;

// Simulated server time per call. Writes and searches cost more than reads, like most real APIs.
// ponytail: the clock is a plain sum, so parallel calls count as serial. Track start and end per call
// on a virtual clock if a script or a runner starts making parallel calls.
const LATENCY_MS: Record<string, number> = { list_issues: 220, search_issues: 260, search_users: 140, list_comments: 120 };
const READ_MS = 90;
const WRITE_MS = 180;

// mulberry32: a tiny seeded PRNG, so the data never changes between runs.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedStore(): Store {
  const r = rng(4);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const names = ["Ana Ruiz", "Ben Okafor", "Chen Wei", "Dana Reyes", "Eli Novak", "Fatima Zahra", "Gus Lund", "Priya Shah"];
  const users = names.map((name, i) => ({
    id: `u${i + 1}`,
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}@example.com`,
    team: i % 2 ? "platform" : "product",
  }));
  const projects = [
    { key: "CORE", name: "Core Engine", lead_id: "u1" },
    { key: "WEB", name: "Web App", lead_id: "u4" },
    { key: "API", name: "Public API", lead_id: "u6" },
  ];
  const milestones = projects.flatMap((p, i) => [
    { id: `m${i * 2 + 1}`, project_key: p.key, title: "v1.0", due_on: "2026-03-31" },
    { id: `m${i * 2 + 2}`, project_key: p.key, title: "v2.0", due_on: "2026-09-30" },
  ]);
  const verbs = ["Crash", "Slow response", "Wrong total", "Missing field", "Timeout", "Broken link", "Typo", "Memory leak"];
  const places = ["login page", "export job", "search index", "billing report", "webhook retry", "settings panel", "CSV import"];
  const sentences = [
    "Steps to reproduce are in the attached log.",
    "This started after the last deploy.",
    "Customers on the enterprise plan see it most.",
    "It happens about one time in ten.",
    "We need a fix before the next release.",
    "A workaround exists but it is manual.",
  ];
  const issues: Issue[] = [];
  const comments: Comment[] = [];
  const events: Event[] = [];
  for (const p of projects) {
    for (let n = 1; n <= ISSUES_PER_PROJECT; n++) {
      const id = `${p.key}-${n}`;
      const created = BASE + Math.floor(r() * 120) * DAY + Math.floor(r() * DAY);
      const status = r() < 0.6 ? "open" : "closed";
      const labels = LABELS.filter(() => r() < 0.2);
      const issue: Issue = {
        id,
        project_key: p.key,
        title: `${pick(verbs)} in ${pick(places)}`,
        description: `${pick(sentences)} ${pick(sentences)}`,
        status,
        priority: pick(["P1", "P2", "P3"] as const),
        assignee_id: r() < 0.25 ? null : pick(users).id,
        reporter_id: pick(users).id,
        labels,
        milestone_id: r() < 0.6 ? pick(milestones.filter((m) => m.project_key === p.key)).id : null,
        links: [],
        created_at: new Date(created).toISOString(),
        updated_at: new Date(created + Math.floor(r() * 20) * DAY).toISOString(),
        resolution: status === "closed" ? pick(["fixed", "wontfix", "duplicate"]) : null,
      };
      issues.push(issue);
      events.push({ issue_id: id, actor_id: issue.reporter_id, kind: "created", detail: "", at: issue.created_at });
      const count = Math.floor(r() * 6);
      for (let c = 0; c < count; c++) {
        comments.push({
          id: `c${comments.length + 1}`,
          issue_id: id,
          author_id: pick(users).id,
          body: pick(sentences),
          created_at: new Date(created + (c + 1) * 3600_000).toISOString(),
        });
      }
    }
  }
  return { users, projects, milestones, issues, comments, events };
}

export interface Fixture {
  client: Client;
  store: Store;
  /** Simulated server time and number of calls the server has served so far. */
  clock: { ms: number; calls: number };
  close(): Promise<void>;
}

/** Start a fresh server with fresh seeded data, and a client connected to it in memory. */
export async function startFixture(): Promise<Fixture> {
  const store = seedStore();
  const clock = { ms: 0, calls: 0 };
  const now = () => new Date(Date.parse("2026-06-01T00:00:00Z") + clock.ms).toISOString();
  const server = new McpServer({ name: "tracker", version: "1.0.0" });

  const userOut = (id: string | null) => {
    const u = store.users.find((x) => x.id === id);
    return u ? { ...u, avatar_url: `https://tracker.example.com/avatars/${u.id}.png`, url: `https://tracker.example.com/users/${u.id}` } : null;
  };
  const issueOut = (i: Issue) => ({
    id: i.id,
    url: `https://tracker.example.com/issues/${i.id}`,
    project: { key: i.project_key, name: store.projects.find((p) => p.key === i.project_key)!.name },
    title: i.title,
    description: i.description,
    status: i.status,
    priority: i.priority,
    assignee: userOut(i.assignee_id),
    reporter: userOut(i.reporter_id),
    labels: i.labels,
    milestone: store.milestones.find((m) => m.id === i.milestone_id) ?? null,
    links: i.links,
    created_at: i.created_at,
    updated_at: i.updated_at,
    resolution: i.resolution,
  });
  const commentOut = (c: Comment) => ({ ...c, author: userOut(c.author_id), url: `https://tracker.example.com/issues/${c.issue_id}#${c.id}` });
  const issue = (id: string) => {
    const i = store.issues.find((x) => x.id === id);
    if (!i) throw new Error(`issue ${id} not found`);
    return i;
  };
  const touch = (i: Issue, kind: string, detail: string) => {
    i.updated_at = now();
    store.events.push({ issue_id: i.id, actor_id: "u1", kind, detail, at: i.updated_at });
    return issueOut(i);
  };
  const page = <T>(items: T[], p = 1, per = 20) => ({
    items: items.slice((p - 1) * per, p * per),
    page: p,
    per_page: per,
    total: items.length,
    next_page: p * per < items.length ? p + 1 : null,
  });

  // Registers a tool and charges simulated time for each call.
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, readOnly: boolean, fn: (a: z.infer<z.ZodObject<S>>) => unknown) => {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, (async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      clock.calls++;
      clock.ms += LATENCY_MS[name] ?? (readOnly ? READ_MS : WRITE_MS);
      try {
        return { content: [{ type: "text", text: JSON.stringify(fn(args)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
      }
    }) as never);
  };

  const issueId = z.string().describe("Issue id, for example CORE-12.");
  const projectKey = z.string().describe("Project key, for example CORE.");

  tool("list_projects", "List all projects you can see.", {}, true, () => store.projects.map((p) => ({ ...p, lead: userOut(p.lead_id) })));
  tool("get_project", "Get one project by key.", { project_key: projectKey }, true, (a) => {
    const p = store.projects.find((x) => x.key === a.project_key);
    if (!p) throw new Error(`project ${a.project_key} not found`);
    return { ...p, lead: userOut(p.lead_id), issue_count: store.issues.filter((i) => i.project_key === p.key).length };
  });
  tool("list_users", "List all users in the workspace.", {}, true, () => store.users.map((u) => userOut(u.id)));
  tool("get_user", "Get one user by id.", { user_id: z.string() }, true, (a) => userOut(a.user_id) ?? (() => { throw new Error("user not found"); })());
  tool("search_users", "Find users whose name or email contains the query text.", { query: z.string() }, true, (a) =>
    store.users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(a.query.toLowerCase())).map((u) => userOut(u.id)));
  tool(
    "list_issues",
    "List issues in one project, newest first. Filters are combined with AND. Results are paged.",
    {
      project_key: projectKey,
      status: z.enum(["open", "closed"]).optional(),
      priority: z.enum(["P1", "P2", "P3"]).optional(),
      assignee_id: z.string().optional().describe("Only issues assigned to this user id."),
      label: z.string().optional(),
      milestone_id: z.string().optional(),
      page: z.number().int().min(1).optional().describe("Page number, starts at 1."),
      per_page: z.number().int().min(1).max(50).optional().describe("Items per page. Default 20, max 50."),
    },
    true,
    (a) => {
      const hits = store.issues
        .filter((i) =>
          i.project_key === a.project_key &&
          (!a.status || i.status === a.status) &&
          (!a.priority || i.priority === a.priority) &&
          (!a.assignee_id || i.assignee_id === a.assignee_id) &&
          (!a.label || i.labels.includes(a.label)) &&
          (!a.milestone_id || i.milestone_id === a.milestone_id))
        .toSorted((x, y) => y.created_at.localeCompare(x.created_at));
      const { items, ...rest } = page(hits, a.page, a.per_page);
      return { issues: items.map(issueOut), ...rest };
    },
  );
  tool("get_issue", "Get one issue with all its fields.", { issue_id: issueId }, true, (a) => issueOut(issue(a.issue_id)));
  tool("search_issues", "Full text search over issue titles and descriptions. Returns at most 20 issues.", { query: z.string(), project_key: projectKey.optional() }, true, (a) =>
    store.issues
      .filter((i) => (!a.project_key || i.project_key === a.project_key) && `${i.title} ${i.description}`.toLowerCase().includes(a.query.toLowerCase()))
      .slice(0, 20)
      .map(issueOut));
  tool("list_comments", "List all comments on an issue, oldest first.", { issue_id: issueId }, true, (a) =>
    store.comments.filter((c) => c.issue_id === issue(a.issue_id).id).map(commentOut));
  tool("get_comment", "Get one comment by id.", { comment_id: z.string() }, true, (a) => {
    const c = store.comments.find((x) => x.id === a.comment_id);
    if (!c) throw new Error("comment not found");
    return commentOut(c);
  });
  tool("list_labels", "List the labels used in a project.", { project_key: projectKey }, true, (a) =>
    LABELS.map((name) => ({ name, issue_count: store.issues.filter((i) => i.project_key === a.project_key && i.labels.includes(name)).length })));
  tool("list_milestones", "List the milestones of a project.", { project_key: projectKey }, true, (a) =>
    store.milestones.filter((m) => m.project_key === a.project_key));
  tool("get_milestone", "Get one milestone by id.", { milestone_id: z.string() }, true, (a) => {
    const m = store.milestones.find((x) => x.id === a.milestone_id);
    if (!m) throw new Error("milestone not found");
    return m;
  });
  tool("list_issue_history", "List every change made to an issue, oldest first.", { issue_id: issueId }, true, (a) =>
    store.events.filter((e) => e.issue_id === issue(a.issue_id).id).map((e) => ({ ...e, actor: userOut(e.actor_id) })));

  tool(
    "create_issue",
    "Create a new open issue in a project.",
    { project_key: projectKey, title: z.string(), description: z.string().optional(), priority: z.enum(["P1", "P2", "P3"]).optional(), assignee_id: z.string().optional() },
    false,
    (a) => {
      const n = Math.max(...store.issues.filter((i) => i.project_key === a.project_key).map((i) => Number(i.id.split("-")[1]))) + 1;
      const i: Issue = {
        id: `${a.project_key}-${n}`, project_key: a.project_key, title: a.title, description: a.description ?? "", status: "open",
        priority: a.priority ?? "P3", assignee_id: a.assignee_id ?? null, reporter_id: "u1", labels: [], milestone_id: null,
        links: [], created_at: now(), updated_at: now(), resolution: null,
      };
      store.issues.push(i);
      return touch(i, "created", "");
    },
  );
  tool("update_issue", "Change the title, description or priority of an issue.", { issue_id: issueId, title: z.string().optional(), description: z.string().optional(), priority: z.enum(["P1", "P2", "P3"]).optional() }, false, (a) => {
    const i = issue(a.issue_id);
    if (a.title !== undefined) i.title = a.title;
    if (a.description !== undefined) i.description = a.description;
    if (a.priority !== undefined) i.priority = a.priority;
    return touch(i, "updated", JSON.stringify(a));
  });
  tool("assign_issue", "Set the assignee of an issue. Pass null to unassign.", { issue_id: issueId, assignee_id: z.string().nullable() }, false, (a) => {
    const i = issue(a.issue_id);
    if (a.assignee_id && !store.users.some((u) => u.id === a.assignee_id)) throw new Error("user not found");
    i.assignee_id = a.assignee_id;
    return touch(i, "assigned", String(a.assignee_id));
  });
  tool("add_label", "Add a label to an issue.", { issue_id: issueId, label: z.string() }, false, (a) => {
    const i = issue(a.issue_id);
    if (!i.labels.includes(a.label)) i.labels.push(a.label);
    return touch(i, "labeled", a.label);
  });
  tool("remove_label", "Remove a label from an issue.", { issue_id: issueId, label: z.string() }, false, (a) => {
    const i = issue(a.issue_id);
    i.labels = i.labels.filter((l) => l !== a.label);
    return touch(i, "unlabeled", a.label);
  });
  tool("add_comment", "Add a comment to an issue.", { issue_id: issueId, body: z.string() }, false, (a) => {
    const i = issue(a.issue_id);
    const c = { id: `c${store.comments.length + 1}`, issue_id: i.id, author_id: "u1", body: a.body, created_at: now() };
    store.comments.push(c);
    touch(i, "commented", c.id);
    return commentOut(c);
  });
  tool("close_issue", "Close an issue with a resolution.", { issue_id: issueId, resolution: z.enum(["fixed", "wontfix", "duplicate"]) }, false, (a) => {
    const i = issue(a.issue_id);
    i.status = "closed";
    i.resolution = a.resolution;
    return touch(i, "closed", a.resolution);
  });
  tool("reopen_issue", "Reopen a closed issue.", { issue_id: issueId }, false, (a) => {
    const i = issue(a.issue_id);
    i.status = "open";
    i.resolution = null;
    return touch(i, "reopened", "");
  });
  tool("link_issues", "Link two issues.", { from_id: issueId, to_id: issueId, link_type: z.enum(["blocks", "relates", "duplicates"]) }, false, (a) => {
    const from = issue(a.from_id);
    issue(a.to_id);
    from.links.push({ type: a.link_type, issue_id: a.to_id });
    return touch(from, "linked", `${a.link_type} ${a.to_id}`);
  });
  tool("set_milestone", "Set the milestone of an issue. Pass null to clear it.", { issue_id: issueId, milestone_id: z.string().nullable() }, false, (a) => {
    const i = issue(a.issue_id);
    i.milestone_id = a.milestone_id;
    return touch(i, "milestoned", String(a.milestone_id));
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bench", version: "1.0.0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, store, clock, close: () => client.close() };
}
