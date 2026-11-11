// Response compaction layer (Gap 2). Reference implementation of spec/response-compaction.md.
//
// A server says, per tool and per result field, what may be cut: keep | drop | summarize.
// When a result is over the token budget, this layer cuts what the manifest allows, never a
// `keep` field, keeps what it cut, and adds a tool that returns the cut content by cursor.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { Layer, LayerContext } from "../layer.ts";

export const META_KEY = "io.modelcontextprotocol/response-compaction";
export const MORE_TOOL = "compaction_more";

type Policy = "keep" | "drop" | "summarize";
export type Manifest = { fields: Record<string, Policy> };
/** One cut part. No offset: the whole value at `path`. With offset: a slice of the original string. */
export type Piece = { path: string; value: unknown; offset?: number };
type Rule = { segs: string[]; policy: Policy };
type Level = { chars: number; items: number };

// Level 0 only drops. Each next level also shortens `summarize` values more.
// The first level whose result fits the budget wins.
// ponytail: fixed steps, so a result can land well under the budget (a long page gets 1000 chars
// when 4000 would fit). Binary search on `chars` if the extra "more" calls matter.
const LEVELS: Level[] = [
  { chars: Infinity, items: Infinity },
  { chars: 1000, items: 10 },
  { chars: 200, items: 3 },
  { chars: 40, items: 1 },
];
export const MARKER = /… \[cut \d+ chars\]/;
// ponytail: cut content lives in memory, oldest dropped after 100 results, lost on restart.
// Move to a size-bounded store with a TTL if cursors must survive longer.
const MAX_CURSORS = 100;
const DEFAULT_BUDGET = 5000;

const ajv = new AjvJsonSchemaValidator();
const schema = JSON.parse(readFileSync(new URL("../../spec/compaction-manifest.schema.json", import.meta.url), "utf8"));
const checkManifest = ajv.getValidator(schema);
export const isManifest = (m: unknown): m is Manifest => checkManifest(m).valid;

// ponytail: chars/4 guess, not a real tokenizer. Use the model's tokenizer if budgets must be exact.
// Text blocks count as their text, everything else as its JSON.
export function resultTokens(r: CallToolResult): number {
  let chars = r.structuredContent ? JSON.stringify(r.structuredContent).length : 0;
  for (const b of r.content) chars += b.type === "text" ? b.text.length : JSON.stringify(b).length;
  return Math.ceil(chars / 4);
}

const unescape = (s: string) => s.replaceAll("~1", "/").replaceAll("~0", "~");
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const parseRules = (m: Manifest): Rule[] =>
  Object.entries(m.fields).map(([p, policy]) => ({ segs: p === "" ? [] : p.slice(1).split("/").map(unescape), policy }));

// True when `rule` starts with a pattern that matches the concrete path `segs`.
const matches = (rule: string[], segs: string[]) => segs.every((s, i) => rule[i] === "*" || rule[i] === s);

function policyAt(rules: Rule[], segs: string[]): Policy | undefined {
  const hits = rules.filter((r) => r.segs.length === segs.length && matches(r.segs, segs)).map((r) => r.policy);
  return hits.includes("keep") ? "keep" : hits.includes("summarize") ? "summarize" : hits[0];
}

const keepBelow = (rules: Rule[], segs: string[]) =>
  rules.some((r) => r.policy === "keep" && r.segs.length > segs.length && matches(r.segs, segs));

// Do not split a UTF-16 surrogate pair.
const cutPoint = (s: string, n: number) => {
  const c = s.charCodeAt(n - 1);
  return n > 0 && n < s.length && c >= 0xd800 && c <= 0xdbff ? n + 1 : n;
};

const CUT = Symbol("cut");

/** Apply the rules to one value. Pushes what was cut to `pieces`, paths prefixed with `base`. */
function compactValue(value: unknown, rules: Rule[], level: Level, base: string, pieces: Piece[]): unknown {
  const walk = (v: unknown, segs: string[], inherited: Policy, removable: boolean): unknown => {
    const own = policyAt(rules, segs) ?? inherited;
    const path = base + segs.map((s) => "/" + escape(s)).join("");
    // A value with a `keep` rule below it is never removed, and if it is an array, never shortened.
    const guarded = keepBelow(rules, segs);
    if (own === "drop" && removable && !guarded) {
      pieces.push({ path, value: v });
      return CUT;
    }
    // `drop` on a value that cannot be removed (the root, an array element) acts as `summarize`.
    const shorten = own !== "keep";
    if (Array.isArray(v)) {
      const n = shorten && !guarded ? Math.min(v.length, level.items) : v.length;
      const out = v.slice(0, n).map((x, i) => walk(x, [...segs, String(i)], own, false));
      for (let i = n; i < v.length; i++) pieces.push({ path: `${path}/${i}`, value: v[i] });
      return out;
    }
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = walk(x, [...segs, k], own, true);
        if (r !== CUT) out[k] = r;
      }
      return out;
    }
    if (typeof v === "string" && shorten && v.length > level.chars) {
      const at = cutPoint(v, level.chars);
      if (at >= v.length) return v;
      pieces.push({ path, offset: at, value: v.slice(at) });
      return `${v.slice(0, at)}… [cut ${v.length - at} chars]`;
    }
    return v;
  };
  return walk(value, [], "keep", false);
}

function parseJson(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

function notice(pieces: Piece[], before: number, after: number, budget: number, cursor: string): string {
  const counts = new Map<string, number>();
  for (const p of pieces) {
    const k = p.path.replace(/\/\d+(?=\/|$)/g, "/*");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const cut = [...counts].map(([k, n]) => `${k} (${n})`).join(", ");
  const over = after > budget ? " It is still over budget: the manifest allows no more cuts." : "";
  return (
    `[compacted] This result was cut from about ${before} to about ${after} tokens to fit a budget of ${budget}.${over} ` +
    `Cut: ${cut}. Text ending in "… [cut N chars]" was shortened. ` +
    `To read the cut content, call ${MORE_TOOL} with cursor "${cursor}"; add path to get one part. ` +
    `Do not send a shortened value back to a tool.`
  );
}

type Compacted = { result: CallToolResult; pieces: Piece[] };

/** Returns undefined when the result must pass unchanged. The notice counts against the budget. */
function compactResult(res: CallToolResult, rules: Rule[], budget: number, cursor: string, valid?: (v: unknown) => boolean): Compacted | undefined {
  const before = resultTokens(res);
  if (before <= budget) return undefined;
  const sc = res.structuredContent;
  let best: Compacted | undefined;
  for (const level of LEVELS) {
    const pieces: Piece[] = [];
    let outSc = sc;
    if (sc) {
      const scPieces: Piece[] = [];
      const c = compactValue(sc, rules, level, "/structuredContent", scPieces) as Record<string, unknown>;
      // Never return structuredContent that breaks the tool's outputSchema: clients validate it.
      if (!valid || valid(c)) {
        outSc = c;
        pieces.push(...scPieces);
      }
    }
    const content = res.content.map((block, i) => {
      if (block.type !== "text") return block;
      const base = `/content/${i}/text`;
      const json = parseJson(block.text);
      if (json === undefined) return { ...block, text: compactValue(block.text, rules, level, base, pieces) as string };
      // The text copy of structuredContent follows it, and its cut parts are not stored twice.
      if (sc && isDeepStrictEqual(json, sc)) return outSc === sc ? block : { ...block, text: JSON.stringify(outSc) };
      const n = pieces.length;
      const c = compactValue(json, rules, level, base, pieces);
      return pieces.length === n ? block : { ...block, text: JSON.stringify(c) };
    });
    const body = resultTokens({ content, structuredContent: outSc });
    // The notice holds its own size, so estimate it once, then write it with the real total.
    const after = body + Math.ceil(notice(pieces, before, body, budget, cursor).length / 4);
    const result: CallToolResult = {
      ...res,
      content: [...content, { type: "text", text: notice(pieces, before, after, budget, cursor) }],
      ...(outSc ? { structuredContent: outSc } : {}),
      _meta: { ...res._meta, [META_KEY]: { cursor, cut: pieces.length, tokensBefore: before, tokensAfter: after, budget } },
    };
    best = { result, pieces };
    if (after <= budget) break;
  }
  return best?.pieces.length ? best : undefined;
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

const moreTool: Tool = {
  name: MORE_TOOL,
  description:
    'Returns content that was cut from an earlier tool result to save tokens. Cut text ends in "… [cut N chars]". ' +
    "Pass the cursor if the result gave you one. With no cursor you get the cut content of the most recent cut result, " +
    "and calling again with no cursor continues it. Pass path to get only one part, for example /structuredContent/messages/3/text.",
  inputSchema: {
    type: "object",
    properties: {
      cursor: { type: "string", description: "Optional. Cursor from the earlier result. Leave out to read the most recent cut result." },
      path: { type: "string", description: "Optional. Only return cut content at or below this path." },
    },
  },
};

export function createLayer(options: unknown): Layer {
  const opts = (options ?? {}) as { budget?: unknown; manifests?: unknown };
  const budget = opts.budget ?? DEFAULT_BUDGET;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) {
    throw new Error("compact: budget must be a positive whole number of tokens");
  }
  const optionRules = new Map<string, Rule[]>();
  for (const [name, m] of Object.entries((opts.manifests ?? {}) as Record<string, unknown>)) {
    if (!isManifest(m)) throw new Error(`compact: manifest for tool "${name}" does not match spec/compaction-manifest.schema.json`);
    optionRules.set(name, parseRules(m));
  }

  type Entry = { rules: Rule[]; valid?: (v: unknown) => boolean };
  const known = new Map<string, Entry>(); // key: server + tool name
  const validators = new Map<string, (v: unknown) => boolean>(); // key: outputSchema as JSON
  const store = new Map<string, { principal?: string; tool: string; pieces: Piece[] }>();
  const keyOf = (ctx: LayerContext, name: string) => `${ctx.server}\0${name}`;

  const outputValidator = (outputSchema: object) => {
    const k = JSON.stringify(outputSchema);
    let v = validators.get(k);
    if (!v) {
      try {
        const check = ajv.getValidator(outputSchema as Parameters<typeof ajv.getValidator>[0]);
        v = (x) => check(x).valid;
      } catch {
        v = () => false; // Schema we cannot compile: never touch structuredContent.
      }
      validators.set(k, v);
    }
    return v;
  };

  const save = (pieces: Piece[], principal: string | undefined, tool: string, cursor = randomUUID()) => {
    store.set(cursor, { principal, tool, pieces });
    if (store.size > MAX_CURSORS) store.delete(store.keys().next().value!);
    return cursor;
  };

  const more = (args: Record<string, unknown> | undefined, ctx: LayerContext): CallToolResult => {
    // Some clients show the model only structuredContent, so it never sees the notice that holds the cursor.
    // With no cursor, serve this caller's newest entry. The reply names the tool, so a mix-up is visible.
    // ponytail: "newest" is wrong if two cut results came back before the first "more" call. The cursor is exact.
    const entry =
      args?.cursor === undefined
        ? [...store.values()].findLast((e) => e.principal === ctx.principal)
        : store.get(String(args.cursor));
    if (!entry || entry.principal !== ctx.principal) {
      return errorResult(
        args?.cursor === undefined
          ? "Nothing was cut, or it has expired. Call the original tool again."
          : "Unknown or expired cursor. Call again with no cursor to read the most recent cut result, or call the original tool again.",
      );
    }
    const path = typeof args?.path === "string" ? args.path : "";
    const rest = entry.pieces.filter(
      (p) => p.path === path || p.path.startsWith(path + "/") || path.startsWith(p.path + "/"),
    );
    // Fill one page up to the budget. A long string is split into slices with offsets.
    const page: Piece[] = [];
    // Chars, same chars/4 guess as resultTokens. 150 chars are left for the wrapper,
    // the next cursor and the "More is left" line, plus the "from" field.
    let room = budget * 4 - 150 - entry.tool.length - 12;
    while (rest.length) {
      const p = rest[0]!;
      const size = JSON.stringify(p).length + 1; // + the comma between pieces
      // ponytail: one non-string piece bigger than the budget is sent whole. Split objects and arrays if that bites.
      if (size <= room || (!page.length && typeof p.value !== "string")) {
        page.push(p);
        rest.shift();
        room -= size;
        continue;
      }
      if (typeof p.value === "string") {
        // Measure the slice as JSON: newlines and quotes take more room once escaped.
        const avail = room - p.path.length - 40;
        let n = avail;
        while (n > 1 && JSON.stringify(p.value.slice(0, n)).length > avail) n = Math.floor(n * 0.9);
        const take = cutPoint(p.value, Math.max(n, page.length ? 0 : 1));
        if (take >= p.value.length) {
          page.push(p);
          rest.shift();
        } else if (take > 0) {
          const offset = p.offset ?? 0;
          page.push({ path: p.path, offset, value: p.value.slice(0, take) });
          rest[0] = { path: p.path, offset: offset + take, value: p.value.slice(take) };
        }
      }
      break;
    }
    const body = { from: entry.tool, pieces: page, ...(rest.length ? { cursor: save(rest, ctx.principal, entry.tool) } : {}) };
    const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(body) }];
    if (body.cursor) content.push({ type: "text", text: `More is left. Call ${MORE_TOOL} with cursor "${body.cursor}".` });
    // Text only: a structuredContent copy would double the size of every page.
    return { content };
  };

  return {
    name: "compact",

    listTools(tools, ctx) {
      let any = false;
      for (const t of tools) {
        if (t.name === MORE_TOOL) throw new Error(`compact: upstream server "${ctx.server}" already has a tool named ${MORE_TOOL}`);
        const fromMeta = t._meta?.[META_KEY];
        const rules = optionRules.get(t.name) ?? (isManifest(fromMeta) ? parseRules(fromMeta) : undefined);
        if (!rules) {
          known.delete(keyOf(ctx, t.name)); // No manifest or an invalid one: never touch this tool.
          continue;
        }
        known.set(keyOf(ctx, t.name), { rules, valid: t.outputSchema ? outputValidator(t.outputSchema) : undefined });
        any = true;
      }
      return any ? [...tools, moreTool] : tools;
    },

    async callTool(params, next, ctx) {
      if (params.name === MORE_TOOL) return more(params.arguments, ctx);
      // Writing a shortened value back would lose data. Stop it before it reaches the server.
      if (MARKER.test(JSON.stringify(params.arguments ?? {}))) {
        return errorResult(
          `An argument holds text that was cut ("… [cut N chars]"). Call ${MORE_TOOL} to get the full value, then call again.`,
        );
      }
      const res = await next(params);
      const entry = known.get(keyOf(ctx, params.name)) ?? (optionRules.has(params.name) ? { rules: optionRules.get(params.name)! } : undefined);
      if (!entry || res.isError) return res;
      const cursor = randomUUID();
      const c = compactResult(res, entry.rules, budget, cursor, entry.valid);
      if (!c) return res;
      save(c.pieces, ctx.principal, params.name, cursor);
      return c.result;
    },
  };
}
