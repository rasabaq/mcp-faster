// The tasks, their checkers, and the oracle runner.
// A checker decides success from the final answer text, or from the server state for write tasks.
// Checkers read the fixture store directly. Oracles never do: they only see what the tools return.
import { seedStore, type Issue, type Store } from "./fixture.ts";
import type { Step, Strategy } from "./strategies.ts";

export interface Trajectory {
  steps: Step[];
  answer: string;
}

/**
 * The seam between the harness and whatever drives the tools.
 * A runner gets a fresh strategy (fresh server, fresh data) and one task, and returns what happened.
 * The only runner shipped is `oracle`. A real-model runner plugs in here, see README.md.
 */
export type Runner = (strategy: Strategy, task: Task) => Promise<Trajectory>;

/** Call a tool and get its parsed JSON result. Throws if the tool returns an error. */
type Call = (tool: string, args?: Record<string, unknown>) => Promise<any>;

export interface Task {
  id: string;
  prompt: string;
  check(answer: string, store: Store): boolean;
  /** The scripted best case for each strategy. */
  oracle: {
    /** Calls made with all tools upfront. Tool search makes the same calls after its searches. */
    direct(call: Call): Promise<string>;
    /** Queries sent to search_tools before `direct` runs. */
    searches: string[];
    /** Body of the one code-mode script. It returns the final answer. */
    script: string;
    /** Reads through `query`, writes through the passed-through write tools. */
    mirror(call: Call): Promise<string>;
  };
}

// --- helpers for checkers ---

const ids = (s: string) => new Set(s.match(/\b[A-Z]+-\d+\b/g) ?? []);
const sameSet = (a: Set<string>, b: Iterable<string>) => {
  const bs = new Set(b);
  return a.size === bs.size && [...a].every((x) => bs.has(x));
};
const isNumber = (answer: string, n: number) => answer.trim() === String(n);
const openIn = (s: Store, project: string) => s.issues.filter((i) => i.project_key === project && i.status === "open");
const userId = (s: Store, name: string) => s.users.find((u) => u.name === name)!.id;

/** True if every issue outside `changed` is exactly as it was in the seed data. */
function othersUnchanged(s: Store, changed: Set<string>) {
  const before = new Map(seedStore().issues.map((i) => [i.id, JSON.stringify(i)]));
  return s.issues.length === before.size && s.issues.every((i) => changed.has(i.id) || before.get(i.id) === JSON.stringify(i));
}

// --- helpers for oracles. The code-mode scripts carry their own copy, because the model would have to write it. ---

async function allIssues(call: Call, args: Record<string, unknown>): Promise<any[]> {
  const out = [];
  for (let page = 1; page; ) {
    const r = await call("list_issues", { ...args, page, per_page: 50 });
    out.push(...r.issues);
    page = r.next_page;
  }
  return out;
}
const PAGER = `async function all(args) {
  const out = [];
  for (let page = 1; page; ) { const r = await tools.list_issues({ ...args, page, per_page: 50 }); out.push(...r.issues); page = r.next_page; }
  return out;
}
`;

// --- the tasks ---

const CORE_P1_OPEN: Task = {
  id: "count-open-p1",
  prompt: "How many open P1 issues are in project CORE? Answer with just the number.",
  check: (a, s) => isNumber(a, openIn(s, "CORE").filter((i) => i.priority === "P1").length),
  oracle: {
    searches: ["list issues"],
    direct: async (call) => String((await call("list_issues", { project_key: "CORE", status: "open", priority: "P1", per_page: 1 })).total),
    script: `return String((await tools.list_issues({ project_key: "CORE", status: "open", priority: "P1", per_page: 1 })).total);`,
    mirror: async (call) => String((await call("query", { sql: "SELECT COUNT(*) AS n FROM issues WHERE project_key = 'CORE' AND status = 'open' AND priority = 'P1'" }))[0].n),
  },
};

const DANA_OPEN: Task = {
  id: "user-open-issues",
  prompt: "List the ids of all open issues assigned to Dana Reyes, in every project. Answer with the ids, comma separated.",
  check: (a, s) => sameSet(ids(a), s.issues.filter((i) => i.status === "open" && i.assignee_id === userId(s, "Dana Reyes")).map((i) => i.id)),
  oracle: {
    searches: ["search users", "list projects", "list issues"],
    direct: async (call) => {
      const [dana] = await call("search_users", { query: "Dana Reyes" });
      const out = [];
      for (const p of await call("list_projects")) out.push(...(await allIssues(call, { project_key: p.key, status: "open", assignee_id: dana.id })));
      return out.map((i) => i.id).join(", ");
    },
    script: PAGER + `const [dana] = await tools.search_users({ query: "Dana Reyes" });
const out = [];
for (const p of await tools.list_projects({})) out.push(...(await all({ project_key: p.key, status: "open", assignee_id: dana.id })));
return out.map((i) => i.id).join(", ");`,
    mirror: async (call) =>
      (await call("query", { sql: "SELECT i.id FROM issues i JOIN users u ON u.id = i.assignee_id WHERE u.name = 'Dana Reyes' AND i.status = 'open'" }))
        .map((r: any) => r.id).join(", "),
  },
};

const OLDEST_BUG: Task = {
  id: "oldest-open-bug",
  prompt: "Which open issue in project WEB with the label bug was created first? Answer with its id.",
  check: (a, s) => {
    const first = openIn(s, "WEB").filter((i) => i.labels.includes("bug")).toSorted((x, y) => x.created_at.localeCompare(y.created_at))[0];
    return !!first && sameSet(ids(a), [first.id]);
  },
  oracle: {
    searches: ["list issues"],
    direct: async (call) => {
      const bugs = await allIssues(call, { project_key: "WEB", status: "open", label: "bug" });
      return bugs.toSorted((x, y) => x.created_at.localeCompare(y.created_at))[0].id;
    },
    script: PAGER + `const bugs = await all({ project_key: "WEB", status: "open", label: "bug" });
return bugs.sort((x, y) => x.created_at.localeCompare(y.created_at))[0].id;`,
    mirror: async (call) =>
      (await call("query", { sql: "SELECT i.id FROM issues i JOIN issue_labels l ON l.issue_id = i.id WHERE i.project_key = 'WEB' AND i.status = 'open' AND l.label = 'bug' ORDER BY i.created_at LIMIT 1" }))[0].id,
  },
};

const LAST_COMMENTER: Task = {
  id: "last-commenter",
  prompt: "Who wrote the most recent comment on CORE-9? Answer with their full name.",
  check: (a, s) => {
    const last = s.comments.filter((c) => c.issue_id === "CORE-9").toSorted((x, y) => y.created_at.localeCompare(x.created_at))[0];
    const named = s.users.filter((u) => a.includes(u.name));
    return !!last && named.length === 1 && named[0]!.id === last.author_id;
  },
  oracle: {
    searches: ["list comments"],
    direct: async (call) => (await call("list_comments", { issue_id: "CORE-9" })).at(-1).author.name,
    script: `return (await tools.list_comments({ issue_id: "CORE-9" })).at(-1).author.name;`,
    mirror: async (call) =>
      (await call("query", { sql: "SELECT u.name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.issue_id = 'CORE-9' ORDER BY c.created_at DESC LIMIT 1" }))[0].name,
  },
};

const MILESTONE: Task = {
  id: "milestone-progress",
  prompt: "In project CORE, how many issues in milestone v2.0 are open and how many are closed? Answer as: open N, closed M",
  check: (a, s) => {
    const m = s.milestones.find((x) => x.project_key === "CORE" && x.title === "v2.0")!;
    const inM = s.issues.filter((i) => i.milestone_id === m.id);
    const open = inM.filter((i) => i.status === "open").length;
    return a.trim() === `open ${open}, closed ${inM.length - open}`;
  },
  oracle: {
    searches: ["list milestones", "list issues"],
    direct: async (call) => {
      const m = (await call("list_milestones", { project_key: "CORE" })).find((x: any) => x.title === "v2.0");
      const count = async (status: string) => (await call("list_issues", { project_key: "CORE", milestone_id: m.id, status, per_page: 1 })).total;
      return `open ${await count("open")}, closed ${await count("closed")}`;
    },
    script: `const m = (await tools.list_milestones({ project_key: "CORE" })).find((x) => x.title === "v2.0");
const count = async (status) => (await tools.list_issues({ project_key: "CORE", milestone_id: m.id, status, per_page: 1 })).total;
return \`open \${await count("open")}, closed \${await count("closed")}\`;`,
    mirror: async (call) => {
      const [r] = await call("query", {
        sql: "SELECT SUM(i.status = 'open') AS open, SUM(i.status = 'closed') AS closed FROM issues i JOIN milestones m ON m.id = i.milestone_id WHERE m.project_key = 'CORE' AND m.title = 'v2.0'",
      });
      return `open ${r.open}, closed ${r.closed}`;
    },
  },
};

const UNASSIGNED: Task = {
  id: "unassigned-open",
  prompt: "How many open issues have no assignee, across all projects? Answer with just the number.",
  check: (a, s) => isNumber(a, s.issues.filter((i) => i.status === "open" && !i.assignee_id).length),
  oracle: {
    searches: ["list projects", "list issues"],
    direct: async (call) => {
      let n = 0;
      for (const p of await call("list_projects")) n += (await allIssues(call, { project_key: p.key, status: "open" })).filter((i) => !i.assignee).length;
      return String(n);
    },
    script: PAGER + `let n = 0;
for (const p of await tools.list_projects({})) n += (await all({ project_key: p.key, status: "open" })).filter((i) => !i.assignee).length;
return String(n);`,
    mirror: async (call) => String((await call("query", { sql: "SELECT COUNT(*) AS n FROM issues WHERE status = 'open' AND assignee_id IS NULL" }))[0].n),
  },
};

const MOST_COMMENTED: Task = {
  id: "most-commented",
  prompt: "Which issue in project API has the most comments? If several are tied, give any one of them. Answer with its id.",
  check: (a, s) => {
    const count = (i: Issue) => s.comments.filter((c) => c.issue_id === i.id).length;
    const api = s.issues.filter((i) => i.project_key === "API");
    const max = Math.max(...api.map(count));
    const got = [...ids(a)];
    return got.length === 1 && api.some((i) => i.id === got[0] && count(i) === max);
  },
  oracle: {
    searches: ["list issues", "list comments"],
    direct: async (call) => {
      let best = { id: "", n: -1 };
      for (const i of await allIssues(call, { project_key: "API" })) {
        const n = (await call("list_comments", { issue_id: i.id })).length;
        if (n > best.n) best = { id: i.id, n };
      }
      return best.id;
    },
    script: PAGER + `let best = { id: "", n: -1 };
for (const i of await all({ project_key: "API" })) {
  const n = (await tools.list_comments({ issue_id: i.id })).length;
  if (n > best.n) best = { id: i.id, n };
}
return best.id;`,
    mirror: async (call) =>
      (await call("query", { sql: "SELECT issue_id, COUNT(*) AS n FROM comments WHERE issue_id LIKE 'API-%' GROUP BY issue_id ORDER BY n DESC LIMIT 1" }))[0].issue_id,
  },
};

const ASSIGN: Task = {
  id: "assign-and-comment",
  prompt: "Assign CORE-15 to Priya Shah and add the comment 'Taking this one.' to it.",
  check: (_a, s) => {
    const i = s.issues.find((x) => x.id === "CORE-15")!;
    return i.assignee_id === userId(s, "Priya Shah") &&
      s.comments.filter((c) => c.issue_id === "CORE-15" && c.body === "Taking this one.").length === 1 &&
      othersUnchanged(s, new Set(["CORE-15"]));
  },
  oracle: {
    searches: ["search users", "assign issue", "add comment"],
    direct: async (call) => {
      const [priya] = await call("search_users", { query: "Priya Shah" });
      await call("assign_issue", { issue_id: "CORE-15", assignee_id: priya.id });
      await call("add_comment", { issue_id: "CORE-15", body: "Taking this one." });
      return "Done.";
    },
    script: `const [priya] = await tools.search_users({ query: "Priya Shah" });
await tools.assign_issue({ issue_id: "CORE-15", assignee_id: priya.id });
await tools.add_comment({ issue_id: "CORE-15", body: "Taking this one." });
return "Done.";`,
    mirror: async (call) => {
      const [priya] = await call("query", { sql: "SELECT id FROM users WHERE name = 'Priya Shah'" });
      await call("assign_issue", { issue_id: "CORE-15", assignee_id: priya.id });
      await call("add_comment", { issue_id: "CORE-15", body: "Taking this one." });
      return "Done.";
    },
  },
};

const CLOSE_DUPES: Task = {
  id: "close-duplicates",
  prompt: "Close every open issue in project WEB that has the label duplicate. Use the resolution duplicate.",
  check: (_a, s) => {
    const targets = new Set(openIn(seedStore(), "WEB").filter((i) => i.labels.includes("duplicate")).map((i) => i.id));
    return targets.size > 0 &&
      s.issues.filter((i) => targets.has(i.id)).every((i) => i.status === "closed" && i.resolution === "duplicate") &&
      othersUnchanged(s, targets);
  },
  oracle: {
    searches: ["list issues", "close issue"],
    direct: async (call) => {
      const dupes = await allIssues(call, { project_key: "WEB", status: "open", label: "duplicate" });
      for (const i of dupes) await call("close_issue", { issue_id: i.id, resolution: "duplicate" });
      return `Closed ${dupes.map((i) => i.id).join(", ")}.`;
    },
    script: PAGER + `const dupes = await all({ project_key: "WEB", status: "open", label: "duplicate" });
for (const i of dupes) await tools.close_issue({ issue_id: i.id, resolution: "duplicate" });
return \`Closed \${dupes.map((i) => i.id).join(", ")}.\`;`,
    mirror: async (call) => {
      const dupes = await call("query", { sql: "SELECT i.id FROM issues i JOIN issue_labels l ON l.issue_id = i.id WHERE i.project_key = 'WEB' AND i.status = 'open' AND l.label = 'duplicate'" });
      for (const i of dupes) await call("close_issue", { issue_id: i.id, resolution: "duplicate" });
      return `Closed ${dupes.map((i: any) => i.id).join(", ")}.`;
    },
  },
};

const TRIAGE: Task = {
  id: "triage-unlabeled",
  prompt: "Add the label needs-triage to every open P1 issue in project API that has no labels.",
  check: (_a, s) => {
    const targets = new Set(openIn(seedStore(), "API").filter((i) => i.priority === "P1" && i.labels.length === 0).map((i) => i.id));
    return targets.size > 0 &&
      s.issues.filter((i) => targets.has(i.id)).every((i) => i.labels.length === 1 && i.labels[0] === "needs-triage") &&
      othersUnchanged(s, targets);
  },
  oracle: {
    searches: ["list issues", "add label"],
    direct: async (call) => {
      const bare = (await allIssues(call, { project_key: "API", status: "open", priority: "P1" })).filter((i) => i.labels.length === 0);
      for (const i of bare) await call("add_label", { issue_id: i.id, label: "needs-triage" });
      return `Labeled ${bare.map((i) => i.id).join(", ")}.`;
    },
    script: PAGER + `const bare = (await all({ project_key: "API", status: "open", priority: "P1" })).filter((i) => i.labels.length === 0);
for (const i of bare) await tools.add_label({ issue_id: i.id, label: "needs-triage" });
return \`Labeled \${bare.map((i) => i.id).join(", ")}.\`;`,
    mirror: async (call) => {
      const bare = await call("query", {
        sql: "SELECT id FROM issues WHERE project_key = 'API' AND status = 'open' AND priority = 'P1' AND id NOT IN (SELECT issue_id FROM issue_labels)",
      });
      for (const i of bare) await call("add_label", { issue_id: i.id, label: "needs-triage" });
      return `Labeled ${bare.map((i: any) => i.id).join(", ")}.`;
    },
  },
};

export const TASKS: Task[] = [CORE_P1_OPEN, DANA_OPEN, OLDEST_BUG, LAST_COMMENTER, MILESTONE, UNASSIGNED, MOST_COMMENTED, ASSIGN, CLOSE_DUPES, TRIAGE];

/** Code mode runs only these. See the note on node:vm in strategies.ts. */
export const SHIPPED_SCRIPTS = new Set(TASKS.map((t) => t.oracle.script));

/** The scripted best case: the shortest correct trajectory we know for each task and strategy. */
export const oracle: Runner = async (strategy, task) => {
  const call: Call = async (tool, args = {}) => {
    const r = await strategy.call(tool, args);
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    if (r.isError) throw new Error(`${strategy.name}/${task.id}: ${tool} failed: ${text}`);
    return JSON.parse(text);
  };
  let answer: string;
  if (strategy.name === "upfront") answer = await task.oracle.direct(call);
  else if (strategy.name === "search") {
    for (const query of task.oracle.searches) await call("search_tools", { query });
    answer = await task.oracle.direct(call);
  } else if (strategy.name === "code") answer = await call("execute", { script: task.oracle.script });
  else answer = await task.oracle.mirror(call);
  return { steps: strategy.steps, answer };
};
