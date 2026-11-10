# Proposal: cache hints, validators and invalidation events for `tools/call`

Status: draft. Target: the MCP spec after 2026-07-28. Reference client: `src/cache` in this repo.

## Problem

The 2026-07-28 revision added `ttlMs` and `cacheScope` (SEP-2549, the `CacheableResult` interface).
They are required on the results of `tools/list`, `prompts/list`, `resources/list`,
`resources/templates/list`, `resources/read`, and `server/discover`. They are not on `tools/call`.

`tools/call` is where the slow and costly work happens. Today a client or proxy that caches a tool
result has to guess three things:

1. How long the result stays correct.
2. Whether the result holds one user's data, so it must not be shown to another user.
3. Whether the source changed since the result was stored.

A wrong guess on 2 leaks data. A wrong guess on 1 or 3 gives the model stale facts.

`subscriptions/listen` tells a client when a list changes, or when a resource it subscribed to
changes. It does not say which tool results depend on which resource.

## Design rules

- Reuse the words the spec already has: `ttlMs`, `cacheScope`, `readOnlyHint`,
  `subscriptions/listen`, `resourceSubscriptions`, `notifications/resources/updated`.
- Add nothing a server must implement. Every field is optional. A server that ignores the proposal
  still works with a client that implements it, and the other way round.
- New keys live in `_meta` and follow the `_meta` naming rules. While this is a proposal they use the
  prefix `dev.mcp-faster/`. If adopted, they would move to `io.modelcontextprotocol/` (reserved
  for MCP) or become plain fields.

## Fields

### On a `tools/call` result

| Field | Type | Meaning |
| --- | --- | --- |
| `ttlMs` | number, >= 0 | Same as on `CacheableResult`. How long, in ms, the result stays fresh. `0` means "stale at once": reuse only after revalidation. |
| `cacheScope` | `"public"` or `"private"` | Same as on `CacheableResult`. `"public"` may be shared across authorization contexts. `"private"` must not be. |
| `_meta["dev.mcp-faster/validator"]` | string | Opaque version of this result, like an HTTP ETag. Only the server reads it. |
| `_meta["dev.mcp-faster/notModified"]` | `true` | Sent only in reply to a request that carried a validator. Means "your stored result is still current". `content` is empty. |

`ttlMs` and `cacheScope` are top-level fields, the same place `CacheableResult` puts them.
`CallToolResult` already allows extra fields, and SDK clients keep them.
In the spec this is a one-line change: `CallToolResult` takes the `CacheableResult` fields as
optional.

### On a `tools/call` request

| Field | Type | Meaning |
| --- | --- | --- |
| `params._meta["dev.mcp-faster/validator"]` | string | "I hold the result with this version. Send `notModified` if it is still current." |

### On a tool in `tools/list`

| Field | Type | Meaning |
| --- | --- | --- |
| `annotations.readOnlyHint` | boolean | Existing field. A client caches only read-only tools, unless its operator says otherwise. |
| `_meta["dev.mcp-faster/invalidatedBy"]` | string[] | Resource URIs. When any of them changes, every stored result of this tool is stale. |

No new notification type. The server reports a change with the existing
`notifications/resources/updated`, on a `subscriptions/listen` stream, for URIs the client listed
in `resourceSubscriptions`. The URIs do not need to be readable resources. They name the source
the tool reads, for example `slack://channels/C123`.

## Rules for the client

1. Cache a `tools/call` result only when all of these hold:
   - the tool is read-only (`readOnlyHint: true`, or the operator says so);
   - the result is final (`resultType` absent or `"complete"`) and `isError` is not `true`;
   - something declared how long it stays correct: a `ttlMs` (from the server or the operator), a
     validator, or a live event subscription for the tool.
   - the request has no fields beyond `name`, `arguments`, `_meta` (no `task`, `inputResponses`,
     `requestState`).
2. Cache key: server, tool name, arguments as JSON with sorted keys, and scope.
   - Scope is `"private"` unless the server or the operator says `"public"`. If either says
     `"private"`, it is private.
   - A private key includes the caller's identity. With no known identity, the entry stays inside
     one cache instance and is never shared with another.
3. Freshness: the smallest `ttlMs` of server and operator. With no `ttlMs`, a result is fresh until
   an event evicts it, but only if every URI in `invalidatedBy` is acknowledged on a live stream.
   Otherwise it is stale at once and can only be reused through its validator.
4. If a `notifications/resources/updated` arrives while a call is in flight, the result of that call
   is returned but not stored. It may describe the source before the change.
5. Two identical calls at the same time, from the same caller, share one upstream call.

## Flow

Validator:

```
client -> server   tools/call {name: "history", arguments: {...}}
server -> client   {content: [...], ttlMs: 0, cacheScope: "private",
                    _meta: {"dev.mcp-faster/validator": "v41"}}
...later...
client -> server   tools/call {name: "history", arguments: {...},
                    _meta: {"dev.mcp-faster/validator": "v41"}}
server -> client   {content: [], ttlMs: 0, _meta: {"dev.mcp-faster/notModified": true}}
                   or a full new result with a new validator
```

Events:

```
client -> server   tools/list
server -> client   {tools: [{name: "history", annotations: {readOnlyHint: true},
                    _meta: {"dev.mcp-faster/invalidatedBy": ["slack://channels/C123"]}}], ...}
client -> server   subscriptions/listen {notifications: {resourceSubscriptions: ["slack://channels/C123"]}}
server -> client   notifications/subscriptions/acknowledged {notifications: {resourceSubscriptions: [...]}}
client -> server   tools/call history   (stored)
server -> client   notifications/resources/updated {uri: "slack://channels/C123"}   (entry evicted)
```

## What happens when the source changes mid-session

**TTL only.** The client keeps serving the old result until `ttlMs` runs out. The staleness is
bounded by `ttlMs` and not lower. Use this only for data where that delay is acceptable, such as
search indexes or docs.

**Validator.** The client asks the server on every reuse once the TTL is over (every time, when
`ttlMs` is 0). The server compares versions and sends the new result. With `ttlMs` 0 the client
never serves a changed result after the server has seen the change. The cost is one round trip per reuse, but a
`notModified` answer is small and cheap to make.

**Events.** The server sends `notifications/resources/updated`. The client drops every stored result
of every tool that lists that URI (or a parent of it) in `invalidatedBy`. The client may serve the
old result in the short time between the change and the notification. That window is the delivery
delay of the stream.

The stream can break. The 2026-07-28 revision removed `Last-Event-ID` and SSE event IDs (SEP-2575),
so a client cannot resume a stream or replay what it missed. So:

- When a stream closes, cleanly or not, the client drops every stored result that depends on
  events for that server. Results that also have a TTL are dropped too.
- When a new stream is acknowledged, the client drops them again, because events may have been
  missed between the two streams. It then trusts only the URIs the server listed in the
  acknowledgement.
- Until a stream is live, a result that depends only on events is not stored.

## Open questions

- Per-argument invalidation. `invalidatedBy` is per tool, so an update to one channel evicts the
  history of every channel. A URI template with argument names (`slack://channels/{channel}`) would
  fix that.
- Operator policy can mark a tool `"public"`. If the operator is wrong, users share data. The
  server's `"private"` always wins, so a server that sets `cacheScope` protects itself.
