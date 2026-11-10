# Gaps in MCP tooling

Date: 2026-11-10. Companion to `slack-bridge/RESEARCH-slack-mcp-latency-and-gaps.md`.
That file is about Slack. This one is about the general problem: MCP servers expose the API shape,
agents need the task shape, and almost nothing in between exists as reusable software.

Each gap lists what is missing, who has done part of it, what is hard, and how you would know it works.

---

## Gap 1. Trace-driven tool consolidation

**Missing.** A proxy that reads session logs, finds calls that always chain, and emits a composite tool
for that chain. Search, then read, then read again becomes one call. No server change, works on any
MCP server.

**Why it is open.** Anthropic describes the manual version of this in "Writing effective tools for
agents": track total tool calls, spot recurring workflows, consolidate. Code-mode gateways compress
the catalog and merge calls at runtime, but they do not learn anything and they do not change the
tool list the model sees on turn one.

**Partial work.** Bifrost, ToolMux, FastMCP CodeMode, agentgateway. All of them route, none of them
learn.

**Hard part.** Merging arguments and results of calls whose schemas do not match, keeping the
composite idempotent, and not breaking permissions when the chain crosses a boundary that the user
approved only for one step.

**Done looks like.** Feed it two weeks of logs from one server. It proposes three composites, you
approve them, and the median task drops 2 or more tool calls without losing accuracy on a fixed
eval set.

---

## Gap 2. Response compaction as a reusable layer

**Missing.** A drop-in layer that caps and restructures tool results for a token budget and hands back
a cursor for "more". Not schema trimming, result trimming.

**Why it is open.** Anthropic's guidance (`response_format` with `concise`/`detailed`, truncation with
instructions, pagination) is advice, not code. Every server author reimplements it or skips it.

**Partial work.** `mcp-spine` minifies schemas. `mcp-cache` chunks responses over 900 KB, which is a
size guard, not a token budget. Nothing applies a per-tool policy.

**Hard part.** Knowing what is safe to drop per tool. Dropping `thread_ts` makes the next call
impossible. That knowledge lives with the server author and has to be declared, which means a small
contract, not a clever heuristic.

**Done looks like.** A manifest a server can ship (`field: keep | drop | summarize`), a proxy that
honours it, and measured token drops on three real servers with no rise in task failure.

---

## Gap 3. Caching with correct invalidation and scope

**Missing.** A cache for `tools/call` results that knows when its entry is stale, and that cannot serve
one user's data to another.

**Why it is open.** The 2026-07-28 revision added `ttlMs` and `cacheScope` (SEP-2549), but only to list
and read results. `tools/call`, where all the expensive work happens, has no standard hint. So every
cache is a guess.

**Partial work.** `mcp-cache-proxy` (SQLite, LRU, stale-while-revalidate, adaptive TTL),
`mcp-cache` (file cache, stale-on-error), `mcp-cache-kit` (honours `cacheScope` correctly),
`mcp-toolkit` (`withCache` for the TS SDK). Four projects, four incompatible cache keys, zero
invalidation.

**Hard part.** Invalidation. A cached channel read is wrong the moment a message arrives. You need the
server to declare either a validator (an ETag equivalent) or an event stream, and today it declares
neither. This gap and Gap 8 are the same gap seen from two sides.

**Done looks like.** A server that returns a validator, a proxy that revalidates on use, and a
documented answer to "what happens when the source changes mid-session".

---

## Gap 4. Measurement

**Missing.** Two things. A benchmark that compares MCP efficiency options (tools upfront, tool search,
code mode, local mirror) on the same tasks. And a log analyser that turns Claude Code's own
`mcp-logs-*` files into per-server, per-tool p50 and p90 numbers so a person can see what to delete.

**Why it is open.** FastMCP has an open issue asking for the benchmark (PrefectHQ/fastmcp#4887).
The best public write-up on connect latency (27 257 connections, p90 35 s session fan-out) used
hand-rolled scripts. I wrote a variant of the analyser myself for the Slack report because nothing
existed.

**Partial work.** Load testers (`mcp-storm`), fuzzers (`mcp-fuzz`). Neither answers "which of my
servers is costing me time".

**Hard part.** Fair workloads. Comparing code mode against direct tool calls means fixing the model,
the prompt, and the retry policy, and a bad harness produces confident nonsense.

**Done looks like.** One command, one table, reproducible by a stranger on their own logs. This is the
cheapest gap here and the one that makes the others credible.

---

## Gap 5. Task-shaped servers per domain

**Missing.** Servers built around what people ask for, not around the vendor's endpoints. Slack is the
clearest case (18 to 27 tools wrapping one API), but the shape repeats for Jira, GitHub, Notion,
Drive, Linear, Salesforce. Fewer tools, compact answers, local cache.

**Why it is open.** It is per-domain work, not a framework, so it does not attract library authors.
The existing servers are generated from API docs, which is why they look like the API docs.

**Partial work.** `aaronsb/slack-mcp` is the closest in spirit (durable workspace ledger, an `estate`
view instead of raw channel dumps). Nothing equivalent exists for the other vendors.

**Hard part.** You need real task data to know which 5 tools matter. Guessing gives you another
API-shaped server with fewer endpoints.

**Done looks like.** An eval set of 30 real requests, a server with under 8 tools, and better task
completion than the vendor server on that set.

---

## Gap 6. A local read model for any source

**Missing.** The mirror pattern as a reusable shape: backfill, incremental sync, local index, query.
Works today for Slack (`slackdump`, `slacrawl`). Nothing shared for GitHub issues, Jira, Drive, Gmail
or Notion, even though agents ask the same repeated questions of all of them.

**Why it is open.** Each source has its own incremental sync rules and its own permissions model, so
every project starts over.

**Partial work.** Per-source scrapers and CLIs. No common schema, no shared cursor handling, no shared
MCP query layer.

**Hard part.** Incremental sync correctness per API, and the permission question: a mirror can hold
data the user later loses access to.

**Done looks like.** One storage schema and one sync loop, two sources implemented, and a stale-data
rule that survives a permission change.

---

## Gap 7. Startup cost of a fleet

**Missing.** Managing how many servers a session pays for. Per-project profiles, warm pools, lazy
loading, and a report of what each server costs to connect.

**Why it is open.** Clients treat servers as a flat list. `mcp-cache-proxy` has an on-demand gateway
that lazy-loads servers; that is the only piece of this I found.

**Hard part.** None technically. It is political: the client owns the config format.

**Done looks like.** A session starts in under a second with 20 servers configured, because only the
ones the task needs connect.

---

## Gap 8. An event feed as a protocol primitive

**Missing.** A standard way for a server to tell a client that a source changed, beyond list changes.
The 2026-07-28 spec has `subscriptions/listen` for `toolsListChanged` and friends. It does not cover
"this cached read is stale" or "a new message arrived, decide whether to act".

**Why it is open.** The protocol solved list invalidation first. Data invalidation is the harder case
and it is left to application code, so every bridge (Socket Mode bridges, Discord bridges, webhook
relays) reinvents a local queue.

**Hard part.** Ordering and delivery guarantees across a stateless protocol. `Last-Event-ID` was
removed in this revision, so a client cannot resume a stream, only re-issue a request.

**Done looks like.** A server declares which tools are invalidated by which events, and a proxy
subscribes on the client's behalf. This is the enabler for Gap 3.

---

## Not gaps

Checked and closed, or owned by someone who will not lose:

- Handshake and session latency. Removed by the 2026-07-28 revision.
- Catalog size. Tool search in the client, code mode in the gateway. Both shipped.
- OAuth app handling for hosted servers. Ship it, do not rebuild it.
- Chat bridges (Slack, Discord, Telegram). Six or more exist per platform.
- Semantic search over a corpus. The cost is embedding and permissions, not plumbing, and the vendor
  search APIs cover the common case.

---

## Order I would do them in

Gap 4 first, because it is a week of work and it tells you whether the rest is worth it. Gap 1 second,
because it is the only genuinely new idea and it generalises. Gap 3 and Gap 8 together, because they
are one problem. Gap 5 last, and only for a domain you actually work in.

Gap 2 is the one I would file as a spec proposal rather than a library.