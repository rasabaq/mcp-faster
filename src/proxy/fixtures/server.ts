// A small MCP server for the proxy tests. Synthetic data only.
// Run directly, it serves on stdio: both 2026-07-28 and the 2025 revisions, or only the 2025 ones with --legacy.
// If FIXTURE_STARTS names a file, every start appends one line to it.
// Tests also run it in-process over streamable HTTP.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

/**
 * `state` and `toolsChanged` let an HTTP host that builds one server per request keep the runtime tool,
 * and publish the list change on its own event bus.
 */
export function createFixtureServer(state = { added: false }, toolsChanged?: () => void): McpServer {
  const server = new McpServer({ name: "fixture", version: "1.2.3" }, { capabilities: { logging: {} }, instructions: "fixture instructions" });

  server.registerTool("echo", { description: "Echo text back.", inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }));

  const addLater = () => server.registerTool("later", { description: "Added at runtime." }, () => ({ content: [{ type: "text", text: "later" }] }));
  if (state.added) addLater();
  // Sends a log message, progress if asked for, and changes the tool list.
  server.registerTool("notify", { description: "Send notifications." }, async (ctx) => {
    await ctx.mcpReq.log("info", "hello from fixture");
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken !== undefined) {
      await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress: 1, total: 2 } });
    }
    if (!state.added) {
      state.added = true; // Registering a tool after connect sends notifications/tools/list_changed.
      addLater();
      toolsChanged?.();
    }
    return { content: [{ type: "text", text: "sent" }] };
  });

  server.registerTool("protocol", { description: "Return the protocol revision of this connection." }, () => ({
    content: [{ type: "text", text: server.server.getNegotiatedProtocolVersion() ?? "none" }],
  }));

  server.registerTool("exit", { description: "Exit the process (stdio only)." }, () => {
    if (import.meta.main) setTimeout(() => process.exit(0), 10);
    return { content: [{ type: "text", text: "bye" }] };
  });

  server.registerResource("hello", "fixture://hello", { mimeType: "text/plain" }, (uri) => ({
    contents: [{ uri: uri.href, text: "hello resource" }],
  }));
  server.registerPrompt("greet", { argsSchema: z.object({ name: z.string() }) }, ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: `hello ${name}` } }],
  }));
  return server;
}

if (import.meta.main) {
  if (process.env.FIXTURE_STARTS) appendFileSync(process.env.FIXTURE_STARTS, `${process.pid}\n`);
  if (process.argv.includes("--legacy")) await createFixtureServer().connect(new StdioServerTransport());
  else serveStdio(() => createFixtureServer());
}
