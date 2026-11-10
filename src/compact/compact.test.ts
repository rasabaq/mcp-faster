// Tests for the compact layer on three synthetic result shapes:
// a chat message list, an issue tracker search, and a document fetch. All data is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallParams, LayerContext } from "../layer.ts";
import { MARKER, META_KEY, MORE_TOOL, createLayer, isManifest, resultTokens, type Manifest, type Piece } from "./index.ts";

const ctx: LayerContext = { server: "synthetic", principal: "user-a" };

// ---------- synthetic shapes ----------

const chatManifest: Manifest = {
  fields: {
    "/ok": "keep",
    "/channel": "keep",
    "/has_more": "keep",
    "/response_metadata/next_cursor": "keep",
    "/messages/*/ts": "keep",
    "/messages/*/thread_ts": "keep",
    "/messages/*/user": "keep",
    "/messages/*/text": "summarize",
    "/messages/*/reactions": "summarize",
    "/messages/*/blocks": "drop",
    "/messages/*/client_msg_id": "drop",
    "/messages/*/team": "drop",
    "/messages/*/files": "drop",
    "/messages/*/files/*/id": "keep",
  },
};

function chatResult(): CallToolResult {
  const messages = Array.from({ length: 40 }, (_, i) => {
    const text = `Message ${i}: ` + "we can ship the release once the smoke tests pass on staging. ".repeat(1 + (i % 6));
    return {
      type: "message",
      user: `U0${100 + (i % 5)}`,
      text,
      ts: `1762790000.${String(i).padStart(6, "0")}`,
      ...(i % 4 === 0 ? { thread_ts: `1762790000.${String(i).padStart(6, "0")}`, reply_count: 3 } : {}),
      client_msg_id: `0000${i}-aaaa-bbbb-cccc-dddddddddddd`,
      team: "T0001",
      blocks: [{ type: "rich_text", block_id: `b${i}`, elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }] }],
      reactions: [
        { name: "eyes", users: ["U0101", "U0102"], count: 2 },
        { name: "white_check_mark", users: ["U0103"], count: 1 },
      ],
      ...(i % 10 === 0
        ? { files: [{ id: `F0${i}`, name: "notes.txt", mimetype: "text/plain", size: 1200, url_private: `https://files.example.com/F0${i}/notes.txt` }] }
        : {}),
    };
  });
  const sc = { ok: true, channel: "C0123", messages, has_more: true, response_metadata: { next_cursor: "bmV4dF9jdXJzb3I=" } };
  return { content: [{ type: "text", text: JSON.stringify(sc) }], structuredContent: sc };
}

// Allowlist style: the root is `drop`, so only listed fields stay.
const issueManifest: Manifest = {
  fields: {
    "": "drop",
    "/total": "keep",
    "/issues/*/id": "keep",
    "/issues/*/key": "keep",
    "/issues/*/title": "keep",
    "/issues/*/state": "keep",
    "/issues/*/url": "keep",
    "/issues/*/body": "summarize",
    "/issues/*/labels": "summarize",
  },
};

function issueResult(): CallToolResult {
  const issues = Array.from({ length: 25 }, (_, i) => ({
    id: 9000 + i,
    key: `PROJ-${100 + i}`,
    url: `https://tracker.example.com/browse/PROJ-${100 + i}`,
    title: `Login page times out under load (case ${i})`,
    state: i % 3 ? "open" : "closed",
    labels: ["bug", "backend", "p2", "needs-triage"].map((name, j) => ({ id: j, name, color: "ededed", description: `Label ${name}` })),
    assignee: { login: `dev${i % 4}`, id: 500 + (i % 4), avatar_url: `https://avatars.example.com/u/${500 + (i % 4)}`, type: "User" },
    body: "## Steps\n1. Open the login page\n2. Send 200 requests per second\n\n## Expected\nPage loads.\n\n## Actual\nTimeout after 30 s.\n".repeat(4),
    comments: 3 + i,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    reactions: { total_count: 2, "+1": 2, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0 },
  }));
  return { content: [{ type: "text", text: JSON.stringify({ total: 25, issues }, null, 2) }] };
}

const docManifest: Manifest = {
  fields: { "": "summarize", "/page_id": "keep", "/url": "keep", "/title": "keep" },
};

function docResult(): CallToolResult {
  const meta = {
    page_id: "pg_7f3a",
    url: "https://wiki.example.com/pages/pg_7f3a",
    title: "Release process",
    created_by: { id: "u_1", name: "Sam Example", avatar_url: "https://avatars.example.com/u_1" },
    last_edited_time: "2026-11-02T09:30:00Z",
    properties: { owner: "platform team", status: "current", tags: ["release", "process", "staging", "rollback", "oncall"] },
  };
  const sections = Array.from({ length: 200 }, (_, i) => `## Step ${i + 1}\n\nRun the checks for stage ${i + 1}. If one fails, stop and roll back. 🚀 Then tell the on-call person in the release channel.\n`);
  return {
    content: [
      { type: "text", text: JSON.stringify(meta) },
      { type: "text", text: `# Release process\n\n${sections.join("\n")}` },
    ],
  };
}

// ---------- helpers ----------

const unescape = (s: string) => s.replaceAll("~1", "/").replaceAll("~0", "~");
const ruleSegs = (p: string) => (p === "" ? [] : p.slice(1).split("/").map(unescape));

/** All [path, value] pairs that match a path pattern with `*`. */
function collect(v: unknown, segs: string[], path = ""): [string, unknown][] {
  if (!segs.length) return [[path, v]];
  if (v === null || typeof v !== "object") return [];
  const [s, ...rest] = segs as [string, ...string[]];
  const keys = s === "*" ? Object.keys(v) : s in v ? [s] : [];
  return keys.flatMap((k) => collect((v as Record<string, unknown>)[k], rest, `${path}/${k}`));
}

/** The JSON values in a result that a manifest applies to (structuredContent and JSON text blocks). */
function jsonValues(r: CallToolResult): unknown[] {
  const out: unknown[] = r.structuredContent ? [r.structuredContent] : [];
  for (const b of r.content) {
    if (b.type !== "text") continue;
    try {
      const v: unknown = JSON.parse(b.text);
      if (v !== null && typeof v === "object") out.push(v);
    } catch {}
  }
  return out;
}

/** Put the cut pieces back into a compacted result. Must give the original exactly. */
function restore(compacted: CallToolResult, pieces: Piece[]): CallToolResult {
  const out = structuredClone(compacted);
  out.content = out.content.slice(0, -1); // the notice block
  delete out._meta;
  // A text copy of structuredContent has no pieces of its own: it follows structuredContent.
  const mirrors = out.content.filter((b) => b.type === "text" && jsonValues({ content: [b] }).some((v) => isDeepStrictEqual(v, out.structuredContent)));
  const parsed = new Map<number, { root: unknown }>();
  for (const p of pieces) {
    const segs = p.path.slice(1).split("/").map(unescape);
    let holder: Record<string, unknown>;
    let rest: string[];
    if (segs[0] === "structuredContent") {
      holder = out as unknown as Record<string, unknown>;
      rest = segs;
    } else {
      const i = Number(segs[1]);
      const block = out.content[i] as { text: string };
      if (segs.length === 3) {
        holder = block;
        rest = ["text"];
      } else {
        if (!parsed.has(i)) parsed.set(i, { root: JSON.parse(block.text) });
        holder = parsed.get(i)!;
        rest = ["root", ...segs.slice(3)];
      }
    }
    let parent: Record<string, unknown> = holder;
    for (const s of rest.slice(0, -1)) parent = parent[s] as Record<string, unknown>;
    const key = rest.at(-1)!;
    parent[key] = p.offset === undefined ? p.value : String(parent[key] ?? "").slice(0, p.offset) + (p.value as string);
  }
  for (const [i, { root }] of parsed) (out.content[i] as { text: string }).text = JSON.stringify(root);
  for (const b of mirrors) (b as { text: string }).text = JSON.stringify(out.structuredContent);
  return out;
}

/** Same result, but JSON text compared as parsed values (compaction may change whitespace). */
const normal = (r: CallToolResult) => ({
  ...r,
  content: r.content.map((b) => {
    if (b.type !== "text") return b;
    try {
      return { ...b, text: JSON.parse(b.text) as unknown };
    } catch {
      return b;
    }
  }),
});

const tool = (name: string, manifest?: Manifest, extra: Partial<Tool> = {}): Tool => ({
  name,
  inputSchema: { type: "object" },
  ...(manifest ? { _meta: { [META_KEY]: manifest } } : {}),
  ...extra,
});

async function call(layer: ReturnType<typeof createLayer>, params: CallParams, result: () => CallToolResult, c = ctx) {
  let calls = 0;
  const res = await layer.callTool!(params, async () => (calls++, result()), c);
  return { res, calls };
}

/** Read every cut piece behind a cursor, page by page. Checks each page fits the budget. */
async function readAll(layer: ReturnType<typeof createLayer>, cursor: string, budget: number, path?: string) {
  const pieces: Piece[] = [];
  let pages = 0;
  for (let c: string | undefined = cursor; c; pages++) {
    const { res } = await call(layer, { name: MORE_TOOL, arguments: { cursor: c, ...(path ? { path } : {}) } }, () => {
      throw new Error("more must not call upstream");
    });
    assert.notEqual(res.isError, true);
    const body = JSON.parse((res.content[0] as { text: string }).text) as { pieces: Piece[]; cursor?: string };
    const tokens = resultTokens(res);
    assert.ok(tokens <= budget, `a more page fits the budget (${tokens} tokens)`);
    pieces.push(...body.pieces);
    c = body.cursor;
  }
  return { pieces, pages };
}

// ---------- the three shapes ----------

const shapes = [
  { name: "chat message list (structuredContent + JSON text copy)", tool: tool("read_channel", chatManifest), manifest: chatManifest, make: chatResult, budget: 5000 },
  { name: "issue tracker search (JSON in text)", tool: tool("search_issues", issueManifest), manifest: issueManifest, make: issueResult, budget: 2500 },
  // This one gets its manifest from the layer options, not from the server.
  { name: "document fetch (JSON metadata + markdown text)", tool: tool("fetch_page"), manifest: docManifest, make: docResult, budget: 1000, options: { fetch_page: docManifest } },
];

for (const s of shapes) {
  test(`${s.name}: drops tokens, keeps keep fields, cursor returns exactly what was cut`, async (t) => {
    const layer = createLayer({ budget: s.budget, ...(s.options ? { manifests: s.options } : {}) });
    const listed = await layer.listTools!([s.tool], ctx);
    assert.deepEqual(listed.map((x) => x.name), [s.tool.name, MORE_TOOL]);

    const original = s.make();
    const { res } = await call(layer, { name: s.tool.name, arguments: {} }, s.make);
    const info = res._meta?.[META_KEY] as { cursor: string; tokensBefore: number; tokensAfter: number };
    assert.ok(info, "result is compacted");
    const drop = Math.round((1 - info.tokensAfter / info.tokensBefore) * 100);
    t.diagnostic(`${s.tool.name}: ${info.tokensBefore} -> ${info.tokensAfter} tokens (-${drop}%), budget ${s.budget}`);
    assert.ok(info.tokensAfter <= s.budget, "fits the budget");
    assert.ok(Math.abs(info.tokensAfter - resultTokens(res)) <= 1, "the reported size includes the notice");
    assert.match((res.content.at(-1) as { text: string }).text, /^\[compacted\]/);

    // Every field marked keep is still there, unchanged.
    const origValues = jsonValues(original);
    const compValues = jsonValues({ ...res, content: res.content.slice(0, -1) });
    assert.equal(compValues.length, origValues.length);
    let checked = 0;
    for (const [p, policy] of Object.entries(s.manifest.fields)) {
      if (policy !== "keep") continue;
      origValues.forEach((ov, i) => {
        const after = new Map(collect(compValues[i], ruleSegs(p)));
        for (const [path, v] of collect(ov, ruleSegs(p))) {
          assert.deepEqual(after.get(path), v, `keep field ${path} survives`);
          checked++;
        }
      });
    }
    assert.ok(checked > 0);

    // The cursor gives back exactly what was cut: put it back and get the original.
    const { pieces, pages } = await readAll(layer, info.cursor, s.budget);
    t.diagnostic(`${s.tool.name}: cut content came back in ${pages} page(s)`);
    assert.deepEqual(normal(restore(res, pieces)), normal(original));
    // And nothing that was not cut: each piece is missing or shortened in the compacted result.
    for (const p of pieces) {
      const segs = p.path.slice(1).split("/").map(unescape);
      const text = segs[0] === "content" ? (res.content[Number(segs[1])] as { text: string }).text : "";
      const where =
        segs[0] === "structuredContent" ? collect(res, segs) : segs.length === 3 ? [[p.path, text]] : collect(JSON.parse(text), segs.slice(3));
      if (where.length) assert.match(String(where[0]![1]), MARKER, `${p.path} was shortened, not kept`);
    }
  });
}

// ---------- safety and pass-through ----------

test("no manifest: result is untouched and no tool is added", async () => {
  const layer = createLayer({ budget: 100 });
  const tools = [tool("read_channel")];
  assert.equal(await layer.listTools!(tools, ctx), tools);
  const big = chatResult();
  const { res } = await call(layer, { name: "read_channel" }, () => big);
  assert.equal(res, big);
});

test("an invalid manifest from a server is ignored", async () => {
  const layer = createLayer({ budget: 100 });
  const bad = tool("read_channel", { fields: { "/messages/*/text": "shrink" } } as unknown as Manifest);
  assert.deepEqual((await layer.listTools!([bad], ctx)).map((x) => x.name), ["read_channel"]);
  const big = chatResult();
  assert.equal((await call(layer, { name: "read_channel" }, () => big)).res, big);
});

test("under budget, or an error result: untouched", async () => {
  const layer = createLayer({ budget: 100_000 });
  await layer.listTools!([tool("read_channel", chatManifest)], ctx);
  const r = chatResult();
  assert.equal((await call(layer, { name: "read_channel" }, () => r)).res, r);

  const small = createLayer({ budget: 50 });
  await small.listTools!([tool("read_channel", chatManifest)], ctx);
  const err = { ...chatResult(), isError: true };
  assert.equal((await call(small, { name: "read_channel" }, () => err)).res, err);
});

test("structuredContent that would break the outputSchema is left whole", async () => {
  const layer = createLayer({ budget: 500 });
  const outputSchema = {
    type: "object" as const,
    properties: { messages: { type: "array", items: { type: "object", required: ["blocks"] } } },
  };
  await layer.listTools!([tool("read_channel", chatManifest, { outputSchema })], ctx);
  const r = chatResult();
  // The JSON text copy follows structuredContent, so nothing is cut at all.
  assert.equal((await call(layer, { name: "read_channel" }, () => r)).res, r);
});

test("a shortened value sent back to a tool is stopped before it reaches the server", async () => {
  const layer = createLayer({ budget: 600 });
  await layer.listTools!([tool("fetch_page", docManifest)], ctx);
  const { res } = await call(layer, { name: "fetch_page" }, docResult);
  const body = (res.content[1] as { text: string }).text;
  assert.match(body, MARKER);
  const { res: blocked, calls } = await call(layer, { name: "update_page", arguments: { body } }, docResult);
  assert.equal(blocked.isError, true);
  assert.equal(calls, 0);
});

test("a cursor is not served to another caller, and unknown cursors fail", async () => {
  const layer = createLayer({ budget: 600 });
  await layer.listTools!([tool("fetch_page", docManifest)], ctx);
  const { res } = await call(layer, { name: "fetch_page" }, docResult);
  const { cursor } = res._meta?.[META_KEY] as { cursor: string };
  const other = await call(layer, { name: MORE_TOOL, arguments: { cursor } }, docResult, { server: "synthetic", principal: "user-b" });
  assert.equal(other.res.isError, true);
  assert.equal((await call(layer, { name: MORE_TOOL, arguments: { cursor: "nope" } }, docResult)).res.isError, true);
});

test("more with a path returns only that part, and repeating a cursor gives the same page", async () => {
  const layer = createLayer({ budget: 2000 });
  await layer.listTools!([tool("read_channel", chatManifest)], ctx);
  const { res } = await call(layer, { name: "read_channel" }, chatResult);
  const { cursor } = res._meta?.[META_KEY] as { cursor: string };
  const path = "/structuredContent/messages/5/text";
  const { pieces } = await readAll(layer, cursor, 2000, path);
  assert.ok(pieces.length > 0 && pieces.every((p) => p.path === path));
  const original = (chatResult().structuredContent as { messages: { text: string }[] }).messages[5]!.text;
  assert.equal(original.slice(pieces[0]!.offset), pieces.map((p) => p.value).join(""));

  const again = async () => {
    const { res: page } = await call(layer, { name: MORE_TOOL, arguments: { cursor } }, chatResult);
    return (JSON.parse((page.content[0] as { text: string }).text) as { pieces: Piece[] }).pieces;
  };
  assert.deepEqual(await again(), await again());
});

test("bad options fail loudly", () => {
  assert.throws(() => createLayer({ budget: -1 }), /budget/);
  assert.throws(() => createLayer({ manifests: { x: { fields: { "no-slash": "keep" } } } }), /manifest/);
});

// ---------- JSON Schema ----------

test("example manifests match the JSON Schema, bad ones do not", () => {
  const spec = readFileSync(new URL("../../spec/response-compaction.md", import.meta.url), "utf8");
  const fromSpec: unknown[] = [];
  for (const [, block] of spec.matchAll(/```json\n([\s\S]*?)```/g)) {
    const v = JSON.parse(block!) as { fields?: unknown; _meta?: Record<string, unknown> };
    if (v.fields) fromSpec.push(v);
    if (v._meta?.[META_KEY]) fromSpec.push(v._meta[META_KEY]);
  }
  assert.ok(fromSpec.length >= 2, "the spec has example manifests");
  for (const m of [chatManifest, issueManifest, docManifest, ...fromSpec]) assert.ok(isManifest(m), JSON.stringify(m));

  for (const bad of [
    {},
    { fields: [] },
    { fields: { "/a": "shrink" } },
    { fields: { "a/b": "keep" } },
    { fields: { "/a~2": "keep" } },
  ]) assert.equal(isManifest(bad), false, JSON.stringify(bad));
});

test("more with no cursor reads the most recent cut result and then continues it", async () => {
  // Claude Code shows the model only structuredContent when a result has it, so the model never sees the cursor.
  const layer = createLayer({ budget: 300, manifests: { read_file: { fields: { "": "summarize" } } } });
  const text = "line of synthetic text. ".repeat(200);
  const { res } = await call(layer, { name: "read_file", arguments: { path: "a.txt" } }, () => ({ content: [{ type: "text", text }] }));
  assert.match((res.content[0] as { text: string }).text, MARKER);

  let got = "";
  for (let i = 0; i < 50; i++) {
    const { res: page } = await call(layer, { name: MORE_TOOL, arguments: {} }, () => {
      throw new Error("more must not call upstream");
    });
    assert.notEqual(page.isError, true);
    const body = JSON.parse((page.content[0] as { text: string }).text) as { from: string; pieces: Piece[]; cursor?: string };
    assert.equal(body.from, "read_file");
    got += body.pieces.map((p) => p.value).join("");
    if (!body.cursor) break;
  }
  const kept = (res.content[0] as { text: string }).text.replace(MARKER, "");
  assert.equal(kept + got, text);

  // A wrong cursor is still an error. It must not silently return some other result.
  const { res: bad } = await call(layer, { name: MORE_TOOL, arguments: { cursor: "cursor" } }, () => {
    throw new Error("more must not call upstream");
  });
  assert.equal(bad.isError, true);
});
