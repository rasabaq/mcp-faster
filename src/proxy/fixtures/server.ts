// A small MCP server for the proxy tests. Synthetic data only.
// Run directly, it serves on stdio. Tests also run it in-process over streamable HTTP.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function createFixtureServer(): McpServer {
  const server = new McpServer({ name: "fixture", version: "1.2.3" }, { capabilities: { logging: {} }, instructions: "fixture instructions" });

  server.registerTool("echo", { description: "Echo text back.", inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }));

  let added = false;
  // Sends a log message, progress if asked for, and changes the tool list.
  server.registerTool("notify", { description: "Send notifications." }, async (extra) => {
    await server.sendLoggingMessage({ level: "info", data: "hello from fixture" });
    const progressToken = extra._meta?.progressToken;
    if (progressToken !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 1, total: 2 } });
    }
    if (!added) {
      added = true; // Registering a tool after connect sends notifications/tools/list_changed.
      server.registerTool("later", { description: "Added at runtime." }, () => ({ content: [{ type: "text", text: "later" }] }));
    }
    return { content: [{ type: "text", text: "sent" }] };
  });

  server.registerTool("exit", { description: "Exit the process (stdio only)." }, () => {
    if (import.meta.main) setTimeout(() => process.exit(0), 10);
    return { content: [{ type: "text", text: "bye" }] };
  });

  server.registerResource("hello", "fixture://hello", { mimeType: "text/plain" }, (uri) => ({
    contents: [{ uri: uri.href, text: "hello resource" }],
  }));
  server.registerPrompt("greet", { argsSchema: { name: z.string() } }, ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: `hello ${name}` } }],
  }));
  return server;
}

if (import.meta.main) await createFixtureServer().connect(new StdioServerTransport());
