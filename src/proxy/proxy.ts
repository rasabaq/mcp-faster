// The proxy core: one upstream MCP client, one downstream MCP server, and the layer chain between them.
// tools/list and tools/call go through the layers. Every other request passes through unchanged.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  isJSONRPCNotification,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ResultSchema,
  SetLevelRequestSchema,
  type CallToolResult,
  type Notification,
  type Request,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
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

const log = (message: string, error?: unknown) =>
  console.error(`mcp-faster proxy: ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`);

export async function startProxy(config: { server: string; upstream: Upstream }, layers: Layer[], downstream: Transport): Promise<Proxy> {
  const ctx: LayerContext = { server: config.server };
  const upstreamTransport =
    "url" in config.upstream
      ? new StreamableHTTPClientTransport(new URL(config.upstream.url), { requestInit: { headers: config.upstream.headers } })
      : new StdioClientTransport({ ...config.upstream, stderr: "inherit" });

  // Protocol.connect keeps a handler that is set before connect and calls it first for every message.
  // That is the only place that sees all notifications, including progress and cancelled.
  upstreamTransport.onmessage = (message) => {
    if (!isJSONRPCNotification(message)) return;
    const notification = { method: message.method, params: message.params };
    for (const layer of layers) {
      if (!layer.onNotification) continue;
      Promise.resolve()
        .then(() => layer.onNotification!(notification, ctx))
        .catch((error) => log(`layer "${layer.name}" failed in onNotification`, error));
    }
  };

  // ponytail: we connect upstream before the client says what it supports, so we declare no client capabilities.
  // So the upstream cannot ask for sampling, elicitation or roots. To add them, connect upstream on the client's
  // initialize request and copy its capabilities.
  // ponytail: an HTTP upstream that goes away only shows up as failed requests; the SDK never closes that transport.
  // So the proxy keeps running and returns errors. Add a health check if clients need the proxy to exit.
  const upstream = new Client({ name: "mcp-faster-proxy", version: "0.0.0" });
  upstream.onerror = (error) => log("upstream error", error);
  await upstream.connect(upstreamTransport);

  // ponytail: tasks (experimental in SDK 1.32) are hidden, because layers expect a CallToolResult, not a task.
  // Add them when the SDK makes tasks stable and a layer can handle them.
  const { tasks: _tasks, ...capabilities } = upstream.getServerCapabilities() ?? {};
  const server = new Server(upstream.getServerVersion() ?? { name: config.server, version: "unknown" }, {
    capabilities,
    instructions: upstream.getInstructions(),
  });
  server.onerror = (error) => log("client error", error);

  // Options for one upstream request made on behalf of one client request.
  // A cancelled client request aborts the signal, and the SDK then cancels the upstream request.
  const options = (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => ({ signal: extra.signal, timeout: NO_TIMEOUT });
  const forward = (request: Request, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
    upstream.request({ method: request.method, params: request.params }, ResultSchema, options(extra));

  server.fallbackRequestHandler = forward;
  server.fallbackNotificationHandler = (notification: Notification) => upstream.notification(notification);
  // The Server answers logging/setLevel itself when logging is on. The upstream must get it instead.
  if (capabilities.logging) server.setRequestHandler(SetLevelRequestSchema, forward);

  upstream.fallbackNotificationHandler = (notification: Notification) => server.notification(notification as ServerNotification);
  // The client's progress token goes upstream unchanged, so progress goes back unchanged too.
  // We do not use the SDK's onprogress: it drops progress that arrives in the same stdio chunk as the response.
  // ponytail: if a layer calls next() twice at once, both upstream calls share one progress token.
  // Give each call its own token and map it back if a layer ever needs that.
  upstream.removeNotificationHandler("notifications/progress");

  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      // Layers see the whole list, so read every page and answer with one page.
      let tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await upstream.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ListToolsResultSchema, options(extra));
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      for (const layer of layers.toReversed()) if (layer.listTools) tools = await layer.listTools(tools, ctx);
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const callUpstream: Next = (params) =>
        upstream.request({ method: "tools/call", params }, CallToolResultSchema, options(extra)) as Promise<CallToolResult>;
      const chain = layers.reduceRight<Next>((next, layer) => (layer.callTool ? (params) => layer.callTool!(params, next, ctx) : next), callUpstream);
      try {
        return await chain(request.params);
      } catch (error) {
        // Protocol errors (unknown tool, closed connection) reach the client as they would without the proxy.
        if (error instanceof McpError) throw error;
        log(`tools/call "${request.params.name}" failed`, error);
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `mcp-faster proxy error: ${message}` }], isError: true };
      }
    });
  }

  const done = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      if (upstreamTransport instanceof StreamableHTTPClientTransport) {
        // Tell the server the session is over, but do not hang if it is gone.
        await Promise.race([upstreamTransport.terminateSession().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      }
      await Promise.allSettled([server.close(), upstream.close()]);
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
  server.onclose = () => void close();

  await server.connect(downstream);
  return { close, closed: done.promise };
}
