// The one contract every proxy layer implements (cache, consolidate, compact).
// The proxy in src/proxy runs the chain. Layers never talk to the network themselves.
//
// Order: the first layer in the config is the outermost one.
//   callTool:  client -> layer[0] -> layer[1] -> ... -> upstream server
//   listTools: upstream server -> ... -> layer[1] -> layer[0] -> client
//
// Each layer lives in src/<name>/index.ts and exports:
//   export function createLayer(options: unknown): Layer | Promise<Layer>
//
// One proxy serves one upstream server, so one layer instance sees one server.
import type { CallToolRequest, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type CallParams = CallToolRequest["params"];
export type Next = (params: CallParams) => Promise<CallToolResult>;

export interface LayerContext {
  /** Name of the upstream server, as written in the proxy config. */
  server: string;
  /**
   * Stable id of the caller. Undefined means "unknown caller":
   * a layer must then never share stored data outside its own instance.
   */
  principal?: string;
}

export interface Layer {
  name: string;
  /** Change the tool list the model sees. */
  listTools?(tools: Tool[], ctx: LayerContext): Tool[] | Promise<Tool[]>;
  /** Wrap one tool call. May call next() zero or more times. */
  callTool?(params: CallParams, next: Next, ctx: LayerContext): Promise<CallToolResult>;
  /** Every notification the upstream server sends is passed to every layer. */
  onNotification?(notification: { method: string; params?: unknown }, ctx: LayerContext): void | Promise<void>;
  close?(): void | Promise<void>;
}
