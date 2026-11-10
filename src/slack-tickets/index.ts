// A task-shaped Slack server (Gap 5). It is built around one job, "work through the tickets in a
// channel", not around Slack's API. A ticket is a message with the ticket reaction. It is open
// until it also has the done reaction.
//
// Two tools, so the model needs no tool search and no chain of calls:
//   list_tickets    one call returns every open ticket with its thread and the links in it
//   resolve_ticket  one call replies in the thread and adds the done reaction
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Options {
  /** Slack bot token (xoxb-...). */
  token: string;
  /** Channel ids where resolve_ticket may write. Empty means the server is read only. */
  writeChannels: string[];
  ticketReaction?: string;
  doneReaction?: string;
  fetch?: typeof fetch;
}

interface Message {
  ts: string;
  user?: string;
  username?: string;
  text?: string;
  reply_count?: number;
  reactions?: { name: string }[];
}

// ponytail: reads the newest 1000 messages of a channel. The result says so when more exist. Page further if a channel needs it.
const MAX_PAGES = 5;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
const LINK = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g;

export function createServer(opts: Options): McpServer {
  const doFetch = opts.fetch ?? fetch;
  const ticket = opts.ticketReaction ?? "ticket";
  const done = opts.doneReaction ?? "white_check_mark";
  const names = new Map<string, Promise<string>>();
  let channels: Promise<Map<string, string>> | undefined;

  async function slack<T>(method: string, params: Record<string, string | number>, post = false): Promise<T> {
    const url = new URL(`https://slack.com/api/${method}`);
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
    const init: RequestInit = { headers };
    if (post) {
      init.method = "POST";
      headers["content-type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(params);
    } else {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    }
    const res = await doFetch(url, init);
    if (res.status === 429) throw new Error(`Slack rate limit on ${method}. Retry after ${res.headers.get("retry-after") ?? "a few"} seconds.`);
    const body = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!body.ok) throw new Error(`Slack ${method} failed: ${body.error ?? `HTTP ${res.status}`}`);
    return body;
  }

  /** Accepts a channel id, "#name" or "name". */
  async function channelId(channel: string): Promise<string> {
    if (CHANNEL_ID.test(channel)) return channel;
    // ponytail: public channels only, first 1000. Pass a channel id for a private channel.
    channels ??= slack<{ channels: { id: string; name: string }[] }>("conversations.list", {
      types: "public_channel",
      exclude_archived: "true",
      limit: 1000,
    }).then((r) => new Map(r.channels.map((c) => [c.name, c.id])));
    const id = (await channels).get(channel.replace(/^#/, ""));
    if (!id) throw new Error(`No public channel named "${channel}". Pass the channel id instead.`);
    return id;
  }

  function nameOf(m: Message): Promise<string> {
    if (!m.user) return Promise.resolve(m.username ?? "unknown");
    let name = names.get(m.user);
    if (!name) {
      name = slack<{ user: { name: string; real_name?: string; profile?: { display_name?: string } } }>("users.info", { user: m.user })
        .then((r) => r.user.profile?.display_name || r.user.real_name || r.user.name)
        .catch(() => m.user!); // No users:read scope: the id is still useful.
      names.set(m.user, name);
    }
    return name;
  }

  const has = (m: Message, reaction: string) => m.reactions?.some((r) => r.name === reaction) ?? false;
  const at = (ts: string) => new Date(Number(ts) * 1000).toISOString();
  const clean = (text = "") => text.replace(LINK, "$1");
  const linksIn = (messages: Message[]) => [...new Set(messages.flatMap((m) => [...(m.text ?? "").matchAll(LINK)].map((x) => x[1]!)))];
  const text = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  });

  const server = new McpServer({ name: "slack-tickets", version: "0.0.0" });

  server.registerTool(
    "list_tickets",
    {
      description:
        `Lists the open tickets in a Slack channel in one call. A ticket is a message with the :${ticket}: reaction. ` +
        `It is open until it has the :${done}: reaction. Each ticket comes with its thread replies and the links found in it. ` +
        "Keep the ts of a ticket: resolve_ticket needs it.",
      inputSchema: { channel: z.string().describe('Channel id (like C0123ABCD) or channel name (like "support").') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ channel }) => {
      const id = await channelId(channel);
      const messages: Message[] = [];
      let cursor = "";
      let pages = 0;
      do {
        const page = await slack<{ messages: Message[]; response_metadata?: { next_cursor?: string } }>("conversations.history", {
          channel: id,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...page.messages);
        cursor = page.response_metadata?.next_cursor ?? "";
      } while (cursor && ++pages < MAX_PAGES);

      const tickets = messages.filter((m) => has(m, ticket));
      const open = await Promise.all(
        tickets
          .filter((m) => !has(m, done))
          .map(async (m) => {
            const replies = m.reply_count
              ? (await slack<{ messages: Message[] }>("conversations.replies", { channel: id, ts: m.ts, limit: 200 })).messages.slice(1)
              : [];
            return {
              ts: m.ts,
              at: at(m.ts),
              author: await nameOf(m),
              text: clean(m.text),
              links: linksIn([m, ...replies]),
              replies: await Promise.all(replies.map(async (r) => ({ author: await nameOf(r), text: clean(r.text) }))),
            };
          }),
      );
      return text({
        channel: id,
        open,
        resolved: tickets.length - open.length,
        ...(cursor ? { note: `Only the newest ${messages.length} messages were read. Older tickets may exist.` } : {}),
      });
    },
  );

  server.registerTool(
    "resolve_ticket",
    {
      description:
        `Resolves one ticket in one call: posts your reply in the ticket's thread and adds the :${done}: reaction. ` +
        "Does nothing if the ticket is already resolved, so it is safe to call again after an error.",
      inputSchema: {
        channel: z.string().describe("Channel id or name, as given to list_tickets."),
        ts: z.string().regex(/^\d+\.\d+$/).describe("The ts of the ticket, from list_tickets."),
        reply: z.string().min(1).describe("What was done, in one or two short sentences. People in the channel read this."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, ts, reply }) => {
      const id = await channelId(channel);
      if (!opts.writeChannels.includes(id)) {
        return text(`This server may not write to channel ${id}. It may write only to: ${opts.writeChannels.join(", ") || "no channel (read only)"}.`, true);
      }
      const state = await slack<{ message: Message }>("reactions.get", { channel: id, timestamp: ts });
      if (!has(state.message, ticket)) return text(`The message at ${ts} is not a ticket: it has no :${ticket}: reaction. Nothing was posted.`, true);
      if (has(state.message, done)) return text("This ticket is already resolved. Nothing was posted.");
      await slack("chat.postMessage", { channel: id, thread_ts: ts, text: reply }, true);
      try {
        await slack("reactions.add", { channel: id, timestamp: ts, name: done }, true);
      } catch (error) {
        // The reply is out. Say so, or a retry would post it twice.
        return text(`The reply was posted, but the :${done}: reaction failed: ${(error as Error).message}. Add the reaction by hand. Do not call this tool again for this ticket.`, true);
      }
      return text("Resolved: reply posted and reaction added.");
    },
  );

  return server;
}
