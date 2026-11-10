// Cache layer: caches tools/call results, knows when they are stale, never mixes users.
// The server-side contract it relies on is in spec/cache-validation.md.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CallParams, Layer, LayerContext, Next } from "../layer.ts";

// ponytail: prefix is not backed by a domain we own, rename it once the project has one.
const PREFIX = "dev.mcp-faster/";
/** Result `_meta` key: opaque version string (like an HTTP ETag). Request `_meta` key: "I hold this version". */
export const VALIDATOR = `${PREFIX}validator`;
/** Result `_meta` key: true means "the version you sent is still current", content is empty. */
export const NOT_MODIFIED = `${PREFIX}notModified`;
/** Tool `_meta` key in tools/list: resource URIs whose `notifications/resources/updated` makes results stale. */
export const INVALIDATED_BY = `${PREFIX}invalidatedBy`;

// ponytail: fixed size, oldest-used entry goes first; make it an option if one size does not fit.
const MAX_ENTRIES = 1000;

const Policy = z.strictObject({
  /** Upper bound on freshness. The smaller of this and the server's `ttlMs` wins. */
  ttlMs: z.number().int().min(0).optional(),
  /** "public" shares entries across principals. "private" wins over any "public". */
  cacheScope: z.enum(["public", "private"]).optional(),
  /** Set to true to cache a tool the server does not mark read-only. */
  readOnlyHint: z.boolean().optional(),
});
// ponytail: policies are keyed by tool name only, so one layer shared by two servers applies a
// policy to both same-named tools (keys still include the server, so no data mixes). Key by server if needed.
const Options = z.strictObject({ tools: z.record(z.string(), Policy).default({}) });

interface Entry {
  server: string;
  key: string;
  result: CallToolResult;
  expiresAt: number;
  validator?: string;
  /** Resource URIs this entry depends on. Non-empty means the entry is dropped when the event stream drops. */
  deps: string[];
}

interface ToolInfo {
  readOnlyHint: boolean;
  deps: string[];
}

export type CacheLayer = Layer & {
  /**
   * Call when the subscriptions/listen stream of a server closes or breaks.
   * Not in the Layer contract yet, see spec/cache-validation.md.
   */
  onStreamClosed(ctx: LayerContext): void;
  /** Resource URIs the proxy should put in `resourceSubscriptions` for this server. */
  resourceSubscriptions(ctx: LayerContext): string[];
};

export function createLayer(options: unknown): CacheLayer {
  const { tools: policies } = Options.parse(options ?? {});
  const store = new Map<string, Entry>();
  const inflight = new Map<string, Promise<CallToolResult>>();
  const toolInfo = new Map<string, Map<string, ToolInfo>>();
  /** Per server: resource URIs the server agreed to send updates for on the live stream. */
  const listening = new Map<string, Set<string>>();
  /** Per server: bumped on every event, so a result fetched across an event is not stored. */
  const generation = new Map<string, number>();

  const bump = (server: string) => generation.set(server, (generation.get(server) ?? 0) + 1);

  function get(key: string): Entry | undefined {
    const entry = store.get(key);
    if (entry) {
      store.delete(key);
      store.set(key, entry);
    }
    return entry;
  }

  // ponytail: linear scan over at most MAX_ENTRIES, index entries by URI if this shows up in profiles.
  function evict(server: string, match: (entry: Entry) => boolean) {
    for (const [key, entry] of store) if (entry.server === server && match(entry)) store.delete(key);
  }

  /** True when every dep is covered by a live, acknowledged subscription. */
  function protectedByEvents(server: string, deps: string[]): boolean {
    const live = listening.get(server);
    return deps.length > 0 && live !== undefined && deps.every((uri) => live.has(uri));
  }

  async function load(params: CallParams, next: Next, ctx: LayerContext, keys: [string, string], policy?: z.infer<typeof Policy>): Promise<CallToolResult> {
    const now = Date.now();
    const entry = get(keys[0]) ?? get(keys[1]);
    if (entry && now < entry.expiresAt) return structuredClone(entry.result);

    const gen = generation.get(ctx.server);
    const sent = entry?.validator ? { ...params, _meta: { ...params._meta, [VALIDATOR]: entry.validator } } : params;
    const reply = await next(sent);
    const notModified = entry?.validator !== undefined && reply._meta?.[NOT_MODIFIED] === true;
    const body = notModified ? structuredClone(entry.result) : reply;

    if (body.isError === true || !isComplete(reply) || generation.get(ctx.server) !== gen) return body;

    const hintTtl = typeof reply.ttlMs === "number" && reply.ttlMs >= 0 ? reply.ttlMs : undefined;
    const hintScope = reply.cacheScope;
    const validator = typeof reply._meta?.[VALIDATOR] === "string" ? reply._meta[VALIDATOR] : notModified ? entry.validator : undefined;
    const deps = toolInfo.get(ctx.server)?.get(params.name)?.deps ?? [];

    const ttls = [policy?.ttlMs, hintTtl].filter((t) => t !== undefined);
    const after = Date.now();
    const expiresAt = ttls.length > 0 ? after + Math.min(...ttls) : protectedByEvents(ctx.server, deps) ? Infinity : after;

    store.delete(keys[0]);
    store.delete(keys[1]);
    if (expiresAt > after || validator !== undefined) {
      const isPrivate = policy?.cacheScope === "private" || hintScope === "private";
      const isPublic = policy?.cacheScope === "public" || hintScope === "public";
      const key = !isPrivate && isPublic ? keys[1] : keys[0];
      store.set(key, { server: ctx.server, key, result: structuredClone(body), expiresAt, validator, deps });
      if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
    }
    return body;
  }

  return {
    name: "cache",

    listTools(tools, ctx) {
      const info = new Map<string, ToolInfo>();
      for (const tool of tools) {
        const deps = tool._meta?.[INVALIDATED_BY];
        info.set(tool.name, {
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          deps: Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string") : [],
        });
      }
      toolInfo.set(ctx.server, info);
      return tools;
    },

    async callTool(params, next, ctx) {
      // Anything beyond name/arguments/_meta (task, inputResponses, requestState, ...) is not a plain read.
      if (Object.keys(params).some((k) => k !== "name" && k !== "arguments" && k !== "_meta")) return next(params);
      const policy = policies[params.name];
      const readOnly = policy?.readOnlyHint ?? toolInfo.get(ctx.server)?.get(params.name)?.readOnlyHint ?? false;
      if (!readOnly) return next(params);

      const base = [ctx.server, params.name, canonicalJson(params.arguments ?? {})];
      // principal undefined -> null: shared only inside this layer instance, as the contract asks.
      const privateKey = JSON.stringify([...base, "private", ctx.principal ?? null]);
      const publicKey = JSON.stringify([...base, "public"]);

      const pending = inflight.get(privateKey);
      if (pending) return structuredClone(await pending);
      const promise = load(params, next, ctx, [privateKey, publicKey], policy);
      inflight.set(privateKey, promise);
      try {
        return await promise;
      } finally {
        inflight.delete(privateKey);
      }
    },

    onNotification(notification, ctx) {
      const params = (notification.params ?? {}) as Record<string, unknown>;
      if (notification.method === "notifications/resources/updated" && typeof params.uri === "string") {
        const uri = params.uri;
        bump(ctx.server);
        // The spec says the URI may be a sub-resource of the subscribed one, so match by prefix.
        evict(ctx.server, (e) => e.deps.some((dep) => uri.startsWith(dep)));
      } else if (notification.method === "notifications/subscriptions/acknowledged") {
        // A new stream. Without Last-Event-ID we cannot know what happened before it, so drop
        // everything that relied on events, then trust only what the server agreed to send.
        bump(ctx.server);
        evict(ctx.server, (e) => e.deps.length > 0);
        const filter = (params.notifications ?? {}) as { resourceSubscriptions?: unknown };
        const uris = Array.isArray(filter.resourceSubscriptions) ? filter.resourceSubscriptions : [];
        // ponytail: one stream per server; the latest ack replaces the set. Track per subscriptionId if a proxy opens several.
        listening.set(ctx.server, new Set(uris.filter((u): u is string => typeof u === "string")));
      }
    },

    onStreamClosed(ctx) {
      bump(ctx.server);
      listening.delete(ctx.server);
      evict(ctx.server, (e) => e.deps.length > 0);
    },

    resourceSubscriptions(ctx) {
      return [...new Set([...(toolInfo.get(ctx.server)?.values() ?? [])].flatMap((t) => t.deps))];
    },

    close() {
      store.clear();
      inflight.clear();
      toolInfo.clear();
      listening.clear();
    },
  };
}

/** A 2026-07-28 server sets resultType; "input_required" and unknown types are not final results. */
function isComplete(result: CallToolResult): boolean {
  return result.resultType === undefined || result.resultType === "complete";
}

/** JSON with object keys sorted at every level, so {a,b} and {b,a} give the same key. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
