// mcp-faster slack-tickets
// An MCP server on stdio. Settings come from the environment, so the token stays out of files in the repo:
//   SLACK_BOT_TOKEN        required, a bot token (xoxb-...)
//   SLACK_WRITE_CHANNELS   optional, comma-separated channel ids where resolve_ticket may write. Empty means read only.
//   SLACK_TICKET_REACTION  optional, default "ticket"
//   SLACK_DONE_REACTION    optional, default "white_check_mark"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./index.ts";

export async function main(_argv: string[]): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token?.startsWith("xoxb-")) {
    console.error("mcp-faster slack-tickets: set SLACK_BOT_TOKEN to a Slack bot token (it starts with xoxb-).");
    process.exitCode = 1;
    return;
  }
  const server = createServer({
    token,
    writeChannels: (process.env.SLACK_WRITE_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ticketReaction: process.env.SLACK_TICKET_REACTION || undefined,
    doneReaction: process.env.SLACK_DONE_REACTION || undefined,
  });
  await server.connect(new StdioServerTransport());
}
