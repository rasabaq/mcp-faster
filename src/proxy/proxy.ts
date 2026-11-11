// The proxy core: one upstream MCP client, one downstream MCP server, and the layer chain between them.
// tools/list and tools/call go through the layers. Every other request passes through unchanged.
//
// Protocol revisions. The proxy asks the upstream for 2026-07-28 and falls back to the 2025 handshake.
// To the client it serves what the upstream speaks: both 2026-07-28 and the 2025 revisions when the
// upstream speaks 2026-07-28, only the 2025 revisions otherwise. A 2026-07-28 client falls back on its own.
//
// Lazy start (opt in). The proxy saves what the upstream advertised in a snapshot file. On later starts it
// answers initialize and tools/list from the snapshot, and starts the upstream on the first request that
// needs it. See "Snapshot" below.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  type CallToolResult,
  type Implementation,
  type JSONRPCRequest,
  type LoggingLevel,
  type McpSubscription,
  type ServerCapabilities,
  type SubscriptionFilter,
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

export interface ProxyConfig {
  server: string;
  upstream: Upstream;
  /** Start the upstream on the first request that needs it, once a snapshot exists. */
  lazy?: boolean;
  /** Folder for snapshot files. Default: $XDG_CACHE_HOME/mcp-faster or ~/.cache/mcp-faster. */
  cacheDir?: string;
}

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
const ToolSchema = z.custom<Tool>((tool) => isSpecType.Tool(tool), "is not a valid tool");
const ToolPage = z.looseObject({ tools: z.array(ToolSchema), nextCursor: z.string().optional() });
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

// Snapshot: what the upstream advertised, so a later start can answer without it.
// It holds only what the server sent. Headers, env values and the URL are never written.
const Snapshot = z.strictObject({
  format: z.literal(1),
  protocolVersion: z.string().min(1),
  serverInfo: z.custom<Implementation>((value) => isSpecType.Implementation(value), "is not valid server info"),
  capabilities: z.custom<ServerCapabilities>((value) => isSpecType.ServerCapabilities(value), "are not valid capabilities"),
  instructions: z.string().optional(),
  tools: z.array(ToolSchema),
});
type Snapshot = z.infer<typeof Snapshot>;

/** One file per server. The name is a hash of the server name and how it is started, never of a secret. */
export function snapshotPath(config: ProxyConfig): string {
  const dir = config.cacheDir ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "mcp-faster");
  const how = "url" in config.upstream ? config.upstream.url : [config.upstream.command, ...config.upstream.args];
  return join(dir, `${createHash("sha256").update(JSON.stringify([config.server, how])).digest("hex").slice(0, 32)}.json`);
}

function readSnapshot(file: string): Snapshot | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined; // No snapshot yet.
  }
  try {
    return Snapshot.parse(JSON.parse(text));
  } catch (error) {
    log(`ignoring the snapshot ${file}, it is not valid`, error instanceof z.ZodError ? z.prettifyError(error).replaceAll("\n", " ") : error);
    return undefined;
  }
}

function writeSnapshot(file: string, snapshot: Snapshot) {
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    // Write a new file and rename it, so a reader never sees half a file.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    log(`could not save the snapshot ${file}`, error);
  }
}

const isModern = (protocolVersion: string) => protocolVersion >= "2026-07-28"; // Revisions are dates.

export async function startProxy(config: ProxyConfig, layers: Layer[], downstream: Transport): Promise<Proxy> {
  const ctx: LayerContext = { server: config.server };
  const eachLayer = (what: string, run: (layer: Layer) => unknown) => {
    for (const layer of layers) {
      Promise.resolve()
        .then(() => run(layer))
        .catch((error) => log(`layer "${layer.name}" failed in ${what}`, error));
    }
  };

  // The upstream connection. Undefined until connect() finishes. One connect at a time: callers share it.
  let upstream: Client | undefined;
  let upstreamTransport: Transport | undefined;
  let connecting: Promise<Client> | undefined;
  let stopped = false;
  const start = () =>
    connectUpstream(config.upstream, (message) => {
      if (!isJSONRPCNotification(message)) return;
      const notification = { method: message.method, params: message.params };
      eachLayer("onNotification", (layer) => layer.onNotification?.(notification, ctx));
    });
  const connect = () =>
    (connecting ??= start().then(
      ({ client, transport }) => attach(client, transport),
      (error) => {
        connecting = undefined; // The next request tries again.
        throw error;
      },
    ));
  /** The upstream for a request. If it cannot start, the error says so and the proxy keeps running. */
  const upstreamFor = async () => {
    if (upstream) return upstream;
    try {
      return await connect();
    } catch (error) {
      throw new Error(`could not start upstream server "${config.server}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };

  const file = config.lazy ? snapshotPath(config) : undefined;
  let snapshot = file ? readSnapshot(file) : undefined;
  // Not lazy, or no snapshot yet: connect now, as without lazy. attach() runs further down.
  const first = snapshot ? undefined : await start();
  const describe = (client: Client, tools: Tool[]): Snapshot => {
    // ponytail: tasks are hidden, because layers expect a CallToolResult, not a task. SDK v2 dropped its task support.
    const { tasks: _tasks, ...capabilities } = client.getServerCapabilities() ?? {};
    return {
      format: 1,
      protocolVersion: client.getNegotiatedProtocolVersion() ?? "unknown",
      serverInfo: client.getServerVersion() ?? { name: config.server, version: "unknown" },
      capabilities,
      instructions: client.getInstructions(),
      tools,
    };
  };
  // What the client sees: the snapshot, or what the upstream just said (the tool list comes later).
  const advertised = snapshot ?? describe(first!.client, []);
  const { capabilities } = advertised;
  // The upstream's revision. Until the upstream starts, the snapshot's.
  let modern = isModern(advertised.protocolVersion);

  // Resource URIs the client subscribed to, keyed by "uri <uri>" (2025 resources/subscribe)
  // or "listen <id>" (2026-07-28 subscriptions/listen). Used only with a 2026-07-28 upstream.
  const clientSubscriptions = new Map<string, string[]>();
  const clientWants = (uri: string) => [...clientSubscriptions.values()].some((uris) => uris.some((u) => uri.startsWith(u)));
  // The level a 2025 client set with logging/setLevel. A 2026-07-28 upstream needs it on every request,
  // and a 2025 upstream that starts late gets it when it starts.
  let clientLogLevel: LoggingLevel | undefined;

  // Options for one upstream request made on behalf of one client request.
  // A cancelled client request aborts the signal, and the SDK then cancels the upstream request.
  const options = (extra?: ServerContext) => ({ signal: extra?.mcpReq.signal, timeout: NO_TIMEOUT });
  // A 2026-07-28 server sends log messages for a request only when the request names a level.
  // A 2026-07-28 client names its own (the SDK lifts it out of _meta). A 2025 client gets what logging/setLevel asked for.
  const withLogLevel = <P extends object>(params: P, extra: ServerContext): P => {
    if (!modern || !capabilities.logging) return params;
    // The SDK types the lifted envelope as an empty object.
    const envelope = extra.mcpReq.envelope as Record<string, unknown> | undefined;
    const level = envelope ? envelope[LOG_LEVEL_META_KEY] : (clientLogLevel ?? "debug");
    if (level === undefined) return params;
    return { ...params, _meta: { ...(params as { _meta?: object })._meta, [LOG_LEVEL_META_KEY]: level } };
  };
  const forward = async (request: Pick<JSONRPCRequest, "method" | "params">, extra: ServerContext) => {
    const client = await upstreamFor();
    try {
      return await client.request({ method: request.method, params: withLogLevel(request.params ?? {}, extra) }, AnyResult, options(extra));
    } catch (error) {
      throw relay(error);
    }
  };
  /** Every page of the upstream tool list. */
  const listTools = async (client: Client, extra?: ServerContext) => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const params = cursor ? { cursor } : {};
      const page = await client.request({ method: "tools/list", params: extra ? withLogLevel(params, extra) : params }, ToolPage, options(extra));
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  };

  let server: Server | undefined;
  // serveStdio may build two servers for one client (a probe, then a fallback), so this is a factory.
  const buildServer = () => {
    const s = new Server(advertised.serverInfo, { capabilities, instructions: advertised.instructions });
    s.onerror = (error) => log("client error", error);
    s.fallbackRequestHandler = forward;
    // Notifications never start the upstream. Before it runs there is nothing to tell it.
    s.fallbackNotificationHandler = async (notification) => void (await upstream?.notification(notification));

    // The Server answers logging/setLevel itself when logging is on. A 2025 upstream must get it instead.
    // A 2026-07-28 upstream has no such method, so the proxy keeps the level and sends it with each request.
    if (capabilities.logging) {
      s.setRequestHandler("logging/setLevel", (request, extra) => {
        clientLogLevel = request.params.level;
        return !modern && upstream ? forward(request, extra) : {};
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
        let tools: Tool[];
        if (!upstream && snapshot) tools = structuredClone(snapshot.tools);
        else {
          const client = await upstreamFor();
          try {
            tools = await listTools(client, extra);
          } catch (error) {
            throw relay(error);
          }
        }
        for (const layer of layers.toReversed()) if (layer.listTools) tools = await layer.listTools(tools, ctx);
        relisten(); // Layers may want new resource URIs now.
        return { tools };
      });

      s.setRequestHandler("tools/call", async (request, extra) => {
        // A layer that answers without next() (a cache hit) never starts the upstream.
        const callUpstream: Next = async (params) =>
          (await upstreamFor()).request({ method: "tools/call", params: withLogLevel(params, extra) }, ToolResult, options(extra));
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

  /** Runs once the upstream is connected. */
  async function attach(client: Client, transport: Transport): Promise<Client> {
    if (stopped) {
      await client.close();
      throw new Error("the proxy is closed");
    }
    [upstream, upstreamTransport] = [client, transport];
    // ponytail: if the upstream changed revision since the snapshot, the client keeps the old one until the
    // next start. The new snapshot fixes that start. Basic requests work on both revisions.
    modern = client.getProtocolEra() === "modern";
    client.fallbackNotificationHandler = async (notification) => {
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
    client.removeNotificationHandler("notifications/progress");
    client.onclose = () => void close();
    if (!modern && clientLogLevel && capabilities.logging) void client.setLoggingLevel(clientLogLevel).catch((error) => log("logging/setLevel failed", error));
    relisten();
    if (file) void refreshSnapshot(client);
    return client;
  }

  /** Saves what the upstream advertises now. Tells the client when the tool list differs from the old snapshot. */
  async function refreshSnapshot(client: Client) {
    try {
      const fresh = describe(client, await listTools(client));
      if (JSON.stringify(fresh) === JSON.stringify(snapshot)) return;
      const toolsChanged = snapshot !== undefined && JSON.stringify(fresh.tools) !== JSON.stringify(snapshot.tools);
      snapshot = fresh;
      writeSnapshot(file!, fresh);
      if (toolsChanged) await server?.notification({ method: "notifications/tools/list_changed" });
    } catch (error) {
      log("could not read the upstream tool list for the snapshot", error);
    }
  }

  // One subscriptions/listen stream to a 2026-07-28 upstream, for list changes, the client's resource
  // subscriptions and the layers' resource subscriptions. A 2025 upstream sends all of these unasked.
  // It opens only once the upstream runs.
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
    if (stopped || !upstream) return;
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
    if (!upstream || !modern || stopped) return;
    listening = listening.then(openStream);
  }

  const done = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  let closeDownstream = async () => {};
  function close() {
    return (closing ??= Promise.resolve().then(async () => {
      stopped = true;
      clearTimeout(retryTimer);
      await connecting?.catch(() => {}); // A start in progress ends first, then closes below.
      if (upstreamTransport instanceof StreamableHTTPClientTransport) {
        // Tell the server the session is over, but do not hang if it is gone.
        await Promise.race([upstreamTransport.terminateSession().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      }
      await Promise.allSettled([closeDownstream(), upstream?.close()]);
      for (const layer of layers) {
        try {
          await layer.close?.();
        } catch (error) {
          log(`layer "${layer.name}" failed to close`, error);
        }
      }
      done.resolve();
    }));
  }

  if (first) connecting = attach(first.client, first.transport);

  if (isModern(advertised.protocolVersion)) {
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
  } else {
    const s = buildServer();
    s.onclose = () => void close();
    closeDownstream = () => s.close();
    await s.connect(downstream);
  }
  return { close, closed: done.promise };
}
