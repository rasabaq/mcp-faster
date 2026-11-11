// The Slack API is faked. All data is synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./index.ts";

const CHANNEL = "C0TESTCHAN1";
const OTHER = "C0REALCHAN2";

/** A tiny fake Slack. `calls` records every API method used, in order. */
function fakeSlack() {
  const calls: string[] = [];
  const posted: { channel: string; thread_ts: string; text: string }[] = [];
  const messages = [
    { ts: "300.0003", user: "U2", text: "The chart is empty <https://example.test/issues/7|issue 7>", reply_count: 1, reactions: [{ name: "ticket" }] },
    { ts: "200.0002", user: "U1", text: "Already fixed", reactions: [{ name: "ticket" }, { name: "white_check_mark" }] },
    { ts: "150.0001", user: "U1", text: "Just chatting", reactions: [{ name: "wave" }] },
    { ts: "100.0000", user: "U1", text: "Login loops", reactions: [{ name: "ticket" }] },
  ];
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").pop()!;
    calls.push(method);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer xoxb-test");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : Object.fromEntries(url.searchParams);
    switch (method) {
      case "conversations.list":
        return json({ ok: true, channels: [{ id: CHANNEL, name: "test-tickets" }] });
      case "conversations.history":
        return json({ ok: true, messages });
      case "conversations.replies":
        return json({ ok: true, messages: [messages[0], { ts: "301.0", user: "U1", text: "Tracked in <https://example.test/issues/8>" }] });
      case "users.info":
        return json({ ok: true, user: { name: body.user === "U1" ? "ana" : "ben", profile: { display_name: body.user === "U1" ? "Ana" : "" }, real_name: "Ben B" } });
      case "reactions.get":
        return json({ ok: true, message: messages.find((m) => m.ts === body.timestamp) ?? { ts: body.timestamp } });
      case "chat.postMessage":
        posted.push(body as (typeof posted)[number]);
        return json({ ok: true });
      case "reactions.add":
        messages.find((m) => m.ts === body.timestamp)!.reactions.push({ name: body.name! });
        return json({ ok: true });
      default:
        return json({ ok: false, error: "unknown_method" });
    }
  }) as typeof fetch;
  return { calls, posted, fetchFn };
}

async function connect(writeChannels: string[]) {
  const slack = fakeSlack();
  const server = createServer({ token: "xoxb-test", writeChannels, fetch: slack.fetchFn });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  const call = async (name: string, args: Record<string, string>) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { text: (r.content[0] as { text: string }).text, isError: r.isError === true };
  };
  return { ...slack, client, call };
}

test("list_tickets returns open tickets with threads and links in one call", async () => {
  const s = await connect([]);
  const tools = (await s.client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name), ["list_tickets", "resolve_ticket"]);
  // Both tools ask Claude Code to load them upfront, so no search turn is needed.
  assert.ok(tools.every((t) => t._meta?.["anthropic/alwaysLoad"] === true));

  const out = JSON.parse((await s.call("list_tickets", { channel: "#test-tickets" })).text);
  assert.equal(out.channel, CHANNEL);
  assert.equal(out.resolved, 1);
  assert.deepEqual(out.open.map((t: { ts: string }) => t.ts), ["300.0003", "100.0000"]);
  const first = out.open[0];
  assert.equal(first.author, "Ben B");
  assert.equal(first.text, "The chart is empty https://example.test/issues/7");
  assert.deepEqual(first.links, ["https://example.test/issues/7", "https://example.test/issues/8"]);
  assert.deepEqual(first.replies, [{ author: "Ana", text: "Tracked in https://example.test/issues/8" }]);
  assert.deepEqual(out.open[1].replies, []);
  // One thread read for the one ticket that has replies. One user lookup per person.
  assert.equal(s.calls.filter((c) => c === "conversations.replies").length, 1);
  assert.equal(s.calls.filter((c) => c === "users.info").length, 2);
});

test("resolve_ticket refuses a channel that is not on the write list", async () => {
  const s = await connect([OTHER]);
  const r = await s.call("resolve_ticket", { channel: CHANNEL, ts: "100.0000", reply: "Fixed." });
  assert.equal(r.isError, true);
  assert.match(r.text, /may not write/);
  assert.deepEqual(s.posted, []);
  assert.ok(!s.calls.includes("chat.postMessage") && !s.calls.includes("reactions.add"));
});

test("resolve_ticket replies in the thread, adds the reaction, and does nothing the second time", async () => {
  const s = await connect([CHANNEL]);
  const r = await s.call("resolve_ticket", { channel: CHANNEL, ts: "100.0000", reply: "Fixed in build 12." });
  assert.equal(r.isError, false);
  assert.deepEqual(s.posted, [{ channel: CHANNEL, thread_ts: "100.0000", text: "Fixed in build 12." }]);

  const again = await s.call("resolve_ticket", { channel: CHANNEL, ts: "100.0000", reply: "Fixed in build 12." });
  assert.match(again.text, /already resolved/);
  assert.equal(s.posted.length, 1);

  const out = JSON.parse((await s.call("list_tickets", { channel: CHANNEL })).text);
  assert.deepEqual(out.open.map((t: { ts: string }) => t.ts), ["300.0003"]);
});

test("resolve_ticket refuses a message that is not a ticket", async () => {
  const s = await connect([CHANNEL]);
  const r = await s.call("resolve_ticket", { channel: CHANNEL, ts: "150.0001", reply: "Done." });
  assert.equal(r.isError, true);
  assert.deepEqual(s.posted, []);
});
