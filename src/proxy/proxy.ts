// The proxy core: one upstream MCP client, one downstream MCP server, and the layer chain between them.
// tools/list and tools/call go through the layers. Every other request passes through unchanged.
//
// Protocol revisions. The proxy asks the upstream for 2026-07-28 and falls back to the 2025 handshake.
// To the client it serves what the upstream speaks: both 2026-07-28 and the 2025 revisions when the
// upstream speaks 2026-07-28, only the 2025 revisions otherwise. A 2026-07-28 client falls back on its own.
import {
  Client,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isSpecType,
  LOG_LEVEL_META_KEY,
  ProtocolError as UpstreamProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  SUBSCRIPTION_ID_META_KEY,
  type JSONRPCRequest,
  type LoggingLevel,
  type McpSubscription,
  type SubscriptionFilter,
  type CallToolResult,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProtocolError, Server, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { Layer, LayerContext, Next } from "../layer.ts";

export type Upstream =
  | { command: string; args: string[]; env: Record<string, string> }
  | { url: string; headers: Record<string, string> };

export interface Proxy {
  /** Closes both sides and every layer. Safe to call more than once. */
  close(): Promise<void>;
  /** Resolves when the proxy has shut down, for any reason. */
  closed: Promise<void>;
}

// The client owns the timeout. When it gives up it sends notifications/cancelled,
// which aborts our upstream request. So the proxy adds no timeout of its own.
// This is the largest delay setTimeout accepts.
const NO_TIMEOUT = 2_147_483_647;

// ponytail: fixed probe timeout. A stdio server that ignores requests it does not know before initialize
// costs this much on every start. Store the verdict per server and pass it as `prior` if that shows up.
const STDIO_PROBE_TIMEOUT_MS = 3000;

// Backoff for reopening the subscriptions/listen stream.
const LISTEN_RETRY_MIN_MS = 1000;
const LISTEN_RETRY_MAX_MS = 30_000;

/** Accepts any result object and keeps every field, so a passed-through result reaches the client unchanged. */
const AnyResult = z.looseObject({});
// The SDK's own schemas for tools/list and tools/call drop fields they do not name (on a tool, on a content block).
// These check the same spec shape with the SDK's guards but keep every field.
const ToolPage = z.looseObject({
  tools: z.array(z.custom<Tool>((tool) => isSpecType.Tool(tool), "is not a valid tool")),
  nextCursor: z.string().optional(),
});
const ToolResult = z.custom<CallToolResult>((result) => isSpecType.CallToolResult(result), "is not a valid tools/call result");

// The SDK probes its own StdioClientTransport for 2026-07-28 on a second, short-lived copy of the server.
// A subclass is probed in place (documented in the SDK's protocol-versions guide), so the upstream starts once.
class InPlaceStdioClientTransport extends StdioClientTransport {}

const log = (message: string, error?: unknown) =>
  console.error(`mcp-faster proxy: ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`);

/** Upstream errors come from the client package. The server package only encodes its own error class. */
const relay = (error: unknown) => (error instanceof UpstreamProtocolError ? ProtocolError.fromError(error.code, error.message, error.data) : error);

async function connectUpstream(upstream: Upstream, onmessage: Transport["onmessage"]) {
  const open = async (prior?: { kind: "legacy" }) => {
    const transport =
      "url" in upstream
        ? new StreamableHTTPClientTransport(new URL(upstream.url), { requestInit: { headers: upstream.headers } })
        : new InPlaceStdioClientTransport({ ...upstream, stderr: "inherit" });
    // Protocol.connect keeps a handler that is set before connect and calls it first for every message.
    // That is the only place that sees all notifications, including progress, cancelled and the listen ack.
    transport.onmessage = onmessage;
    const probe = "url" in upstream ? {} : { probe: { timeoutMs: STDIO_PROBE_TIMEOUT_MS } };
    // ponytail: we connect upstream before the client says what it supports, so we declare no client capabilities.
    // So the upstream cannot ask for sampling, elicitation or roots. To add them, connect upstream on the client's
    // first request and copy its capabilities.
    const client = new Client({ name: "mcp-faster-proxy", version: "0.0.0" }, { versionNegotiation: { mode: "auto", ...probe } });
    client.onerror = (error) => log("upstream error", error);
    await client.connect(transport, prior && { prior });
    return { client, transport };
  };
  try {
    return await open();
  } catch (error) {
    if (!(error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed)) throw error;
    // Some 2025 servers exit, or answer badly, when server/discover comes before initialize.
    // The first process is gone by now, so this start is the only one running.
    log("the upstream failed the 2026-07-28 probe, connecting again with the 2025 handshake", error);
    return await open({ kind: "legacy" });
  }
}

export async function startProxy(config: { server: string; upstream: Upstream }, layers: Layer[], downstream: Transport): Promise<Proxy> {
  const ctx: LayerContext = { server: config.server };
  const eachLayer = (what: string, run: (layer: Layer) => unknown) => {
    for (const layer of layers) {
      Promise.resolve()
        .then(() => run(layer))
        .catch((error) => log(`layer "${layer.name}" failed in ${what}`, error));
    }
  };

  const { client: upstream, transport: upstreamTransport } = await connectUpstream(config.upstream, (message) => {
    if (!isJSONRPCNotification(message)) return;
    const notification = { method: message.method, params: message.params };
    eachLayer("onNotification", (layer) => layer.onNotification?.(notification, ctx));
  });
  const modern = upstream.getProtocolEra() === "modern";

  // ponytail: tasks are hidden, because layers expect a CallToolResult, not a task. SDK v2 dropped its task support.
  const { tasks: _tasks, ...capabilities } = upstream.getServerCapabilities() ?? {};
  const info = upstream.getServerVersion() ?? { name: config.server, version: "unknown" };

  // Resource URIs the client subscribed to, keyed by "uri <uri>" (2025 resources/subscribe)
  // or "listen <id>" (2026-07-28 subscriptions/listen). Used only with a 2026-07-28 upstream.
  const clientSubscriptions = new Map<string, string[]>();
  const clientWants = (uri: string) => [...clientSubscriptions.values()].some((uris) => uris.some((u) => uri.startsWith(u)));
  // The level a 2025 client set with logging/setLevel. A 2026-07-28 upstream needs it on every request.
  let legacyLogLevel: LoggingLevel = "debug";

  // Options for one upstream request made on behalf of one client request.
  // A cancelled client request aborts the signal, and the SDK then cancels the upstream request.
  const options = (extra: ServerContext) => ({ signal: extra.mcpReq.signal, timeout: NO_TIMEOUT });
  // A 2026-07-28 server sends log messages for a request only when the request names a level.
  // A 2026-07-28 client names its own (the SDK lifts it out of _meta). A 2025 client gets what logging/setLevel asked for.
  const withLogLevel = <P extends object>(params: P, extra: ServerContext): P => {
    if (!modern || !capabilities.logging) return params;
    // The SDK types the lifted envelope as an empty object.
    const envelope = extra.mcpReq.envelope as Record<string, unknown> | undefined;
    const level = envelope ? envelope[LOG_LEVEL_META_KEY] : legacyLogLevel;
    if (level === undefined) return params;
    return { ...params, _meta: { ...(params as { _meta?: object })._meta, [LOG_LEVEL_META_KEY]: level } };
  };
  const forward = async (request: Pick<JSONRPCRequest, "method" | "params">, extra: ServerContext) => {
    try {
      return await upstream.request({ method: request.method, params: withLogLevel(request.params ?? {}, extra) }, AnyResult, options(extra));
    } catch (error) {
      throw relay(error);
    }
  };

  let server: Server | undefined;
  // serveStdio may build two servers for one client (a probe, then a fallback), so this is a factory.
  const buildServer = () => {
    const s = new Server(info, { capabilities, instructions: upstream.getInstructions() });
    s.onerror = (error) => log("client error", error);
    s.fallbackRequestHandler = forward;
    s.fallbackNotificationHandler = (notification) => upstream.notification(notification);

    // The Server answers logging/setLevel itself when logging is on. A 2025 upstream must get it instead.
    // A 2026-07-28 upstream has no such method, so the proxy keeps the level and sends it with each request.
    if (capabilities.logging) {
      s.setRequestHandler("logging/setLevel", (request, extra) => {
        if (!modern) return forward(request, extra);
        legacyLogLevel = request.params.level;
        return {};
      });
    }
    // A 2026-07-28 upstream has no resources/subscribe either: the proxy adds the URI to its listen stream.
    if (modern && capabilities.resources?.subscribe) {
      s.setRequestHandler("resources/subscribe", ({ params }) => {
        clientSubscriptions.set(`uri ${params.uri}`, [params.uri]);
        relisten();
        return {};
      });
      s.setRequestHandler("resources/unsubscribe", ({ params }) => {
        if (clientSubscriptions.delete(`uri ${params.uri}`)) relisten();
        return {};
      });
    }

    if (capabilities.tools) {
      s.setRequestHandler("tools/list", async (_request, extra) => {
        // Layers see the whole list, so read every page and answer with one page.
        let tools: Tool[] = [];
        let cursor: string | undefined;
        try {
          do {
            const page = await upstream.request({ method: "tools/list", params: withLogLevel<{ cursor?: string }>(cursor ? { cursor } : {}, extra) }, ToolPage, options(extra));
            tools.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
        } catch (error) {
          throw relay(error);
        }
        for (const layer of layers.toReversed()) if (layer.listTools) tools = await layer.listTools(tools, ctx);
        relisten(); // Layers may want new resource URIs now.
        return { tools };
      });

      s.setRequestHandler("tools/call", async (request, extra) => {
        const callUpstream: Next = (params) => upstream.request({ method: "tools/call", params: withLogLevel(params, extra) }, ToolResult, options(extra));
        const chain = layers.reduceRight<Next>((next, layer) => (layer.callTool ? (params) => layer.callTool!(params, next, ctx) : next), callUpstream);
        try {
          return await chain(request.params);
        } catch (error) {
          // Protocol errors (unknown tool, closed connection) reach the client as they would without the proxy.
          if (error instanceof UpstreamProtocolError || error instanceof SdkError) throw relay(error);
          log(`tools/call "${request.params.name}" failed`, error);
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: `mcp-faster proxy error: ${message}` }], isError: true };
        }
      });
    }
    return (server = s);
  };

  upstream.fallbackNotificationHandler = async (notification) => {
    // Updates for URIs only the layers asked for stay in the proxy.
    if (modern && notification.method === "notifications/resources/updated") {
      const uri = (notification.params as { uri?: unknown } | undefined)?.uri;
      if (typeof uri !== "string" || !clientWants(uri)) return;
    }
    // The id of the proxy's own listen stream means nothing to the client. serveStdio stamps the client's own.
    const meta = notification.params?._meta;
    if (meta && SUBSCRIPTION_ID_META_KEY in meta) {
      const { [SUBSCRIPTION_ID_META_KEY]: _id, ...rest } = meta;
      const { _meta, ...params } = notification.params!;
      notification = { ...notification, params: Object.keys(rest).length > 0 ? { ...params, _meta: rest } : params };
    }
    await server?.notification(notification);
  };
  // The client's progress token goes upstream unchanged, so progress goes back unchanged too.
  // We do not use the SDK's onprogress: it drops progress that arrives in the same stdio chunk as the response.
  // ponytail: if a layer calls next() twice at once, both upstream calls share one progress token.
  // Give each call its own token and map it back if a layer ever needs that.
  upstream.removeNotificationHandler("notifications/progress");

  // One subscriptions/listen stream to a 2026-07-28 upstream, for list changes, the client's resource
  // subscriptions and the layers' resource subscriptions. A 2025 upstream sends all of these unasked.
  let stopped = false;
  let stream: McpSubscription | undefined;
  let streamKey = "";
  let retryMs = LISTEN_RETRY_MIN_MS;
  let retryTimer: NodeJS.Timeout | undefined;
  let listening = Promise.resolve();

  const wantedFilter = (): SubscriptionFilter => {
    const uris = new Set([...clientSubscriptions.values()].flat());
    for (const layer of layers) {
      try {
        for (const uri of layer.resourceSubscriptions?.(ctx) ?? []) uris.add(uri);
      } catch (error) {
        log(`layer "${layer.name}" failed in resourceSubscriptions`, error);
      }
    }
    return {
      ...(capabilities.tools?.listChanged && { toolsListChanged: true }),
      ...(capabilities.prompts?.listChanged && { promptsListChanged: true }),
      ...(capabilities.resources?.listChanged && { resourcesListChanged: true }),
      ...(capabilities.resources?.subscribe && uris.size > 0 && { resourceSubscriptions: [...uris].sort() }),
    };
  };

  // Opens a new stream when the filter changed (or the old one is gone), then closes the old one.
  // The new stream is acknowledged before the old one closes, so no event falls in between.
  const openStream = async () => {
    if (stopped) return;
    const filter = wantedFilter();
    const key = JSON.stringify(filter);
    if (stream && key === streamKey) return;
    const old = stream;
    stream = undefined;
    try {
      if (key !== "{}") {
        const opened = await upstream.listen(filter);
        if (stopped) return void (await opened.close());
        [stream, streamKey, retryMs] = [opened, key, LISTEN_RETRY_MIN_MS];
        void opened.closed.then((reason) => {
          if (stream !== opened) return; // Replaced on purpose. The new stream is live.
          stream = undefined;
          eachLayer("onStreamClosed", (layer) => layer.onStreamClosed?.(ctx));
          if (reason !== "local") retryLater(`the subscriptions/listen stream closed (${reason})`);
        });
      } else if (old) {
        eachLayer("onStreamClosed", (layer) => layer.onStreamClosed?.(ctx));
      }
    } catch (error) {
      if (old) eachLayer("onStreamClosed", (layer) => layer.onStreamClosed?.(ctx));
      retryLater("could not open the subscriptions/listen stream", error);
    } finally {
      await old?.close();
    }
  };
  const retryLater = (why: string, error?: unknown) => {
    if (stopped) return;
    log(`${why}, retrying in ${retryMs} ms`, error);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(relisten, retryMs);
    retryTimer.unref();
    retryMs = Math.min(retryMs * 2, LISTEN_RETRY_MAX_MS);
  };
  /** Runs openStream after any earlier run, so two streams are never opened at the same time. */
  function relisten() {
    if (!modern || stopped) return;
    listening = listening.then(openStream);
  }

  const done = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  let closeDownstream = async () => {};
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      stopped = true;
      clearTimeout(retryTimer);
      if (upstreamTransport instanceof StreamableHTTPClientTransport) {
        // Tell the server the session is over, but do not hang if it is gone.
        await Promise.race([upstreamTransport.terminateSession().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      }
      await Promise.allSettled([closeDownstream(), upstream.close()]);
      for (const layer of layers) {
        try {
          await layer.close?.();
        } catch (error) {
          log(`layer "${layer.name}" failed to close`, error);
        }
      }
      done.resolve();
    }));
  upstream.onclose = () => void close();

  if (modern) {
    const handle = serveStdio(buildServer, { transport: downstream, onerror: (error) => log("client error", error) });
    closeDownstream = () => handle.close();
    // serveStdio owns the transport and answers the client's subscriptions/listen itself.
    // Watch the client's listen requests to learn which resource URIs it wants.
    const { onclose, onmessage } = downstream;
    downstream.onclose = () => {
      onclose?.();
      void close();
    };
    downstream.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message) && message.method === "subscriptions/listen") {
        const uris = (message.params as { notifications?: { resourceSubscriptions?: unknown } } | undefined)?.notifications?.resourceSubscriptions;
        // ponytail: a listen the SDK then refuses still counts here until it is cancelled. The extra URIs cost
        // one wider upstream filter, and serveStdio still only delivers what each client stream asked for.
        if (Array.isArray(uris)) {
          clientSubscriptions.set(`listen ${JSON.stringify(message.id)}`, uris.filter((u): u is string => typeof u === "string"));
          relisten();
        }
      } else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
        const id = (message.params as { requestId?: unknown } | undefined)?.requestId;
        if (clientSubscriptions.delete(`listen ${JSON.stringify(id)}`)) relisten();
      }
      onmessage?.(message, extra);
    };
    relisten();
  } else {
    const s = buildServer();
    s.onclose = () => void close();
    closeDownstream = () => s.close();
    await s.connect(downstream);
  }
  return { close, closed: done.promise };
}
