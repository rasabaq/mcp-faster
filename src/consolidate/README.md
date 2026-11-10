# consolidate

Gap 1 in [mcp-gaps.md](../../mcp-gaps.md). Two parts:

1. `mcp-faster mine` reads your Claude Code transcripts and proposes composite tools.
2. The `consolidate` proxy layer exposes the composites you approved and runs them.

## Mine

```sh
node src/cli.ts mine --server github --since 14 --top 3 --out proposals.json
```

- `--server` is the MCP server name, as in `mcp__<server>__<tool>`.
- `--transcripts` defaults to `~/.claude/projects`. Every `.jsonl` file under it is one session,
  including subagent files.
- `--since` keeps calls from the last N days. `--top` is how many proposals to write (default 3).
- Without `--out`, the JSON goes to stdout. A short summary always goes to stderr.

How it works:

1. For each session, take the calls to this server, in order. Calls to other tools are ignored, so
   `search, Bash, read` still counts as `search -> read`.
2. Count every run of 2 to 4 calls in a row. Keep runs seen in at least 2 sessions.
3. Skip runs of one tool repeated (`send, send, send`). That is a loop, not a chain. Such a tool needs a
   batch argument, not a composite.
4. Drop a run when a longer run contains it and is seen as often.
5. Rank by number of sessions, then by data flow, then by count.

Data flow means a value in the result of an earlier step shows up as an argument of a later step.
The miner looks for the exact value in `structuredContent`, then in the first text item that parses
as JSON. If one path explains at least half of the uses, it proposes that path as the mapping.
Each argument gets an `evidence` record:

- `present`: how often the argument was passed.
- `fromPath`: how often the proposed path held that exact value.
- `inPlainText`: how often the value was only inside non-JSON text. No path can be proposed then.
- `echoOfInput`: how often an earlier step's input already held the value. Results often repeat their
  input. That is not data flow, because the caller already had the value.

Paths with array indexes (`items.0.id`) deserve a close look. They are right only if the agent
always takes the first item.

## The proposals file

```json
{
  "server": "acme",
  "composites": [
    {
      "name": "search_then_get_item",
      "description": "Seen 9 times in 6 sessions.",
      "approved": false,
      "allowNonReadOnly": false,
      "steps": [
        { "tool": "search", "args": { "query": { "input": "query" } } },
        { "tool": "get_item", "args": { "id": { "fromStep": 0, "in": "text", "path": ["items", 0, "id"] } } }
      ],
      "support": { "count": 9, "sessions": 6, "sessionShare": 0.4, "dataFlowShare": 0.9 }
    }
  ]
}
```

Each step argument comes from one of two places:

- `{ "input": "query" }`: the caller passes it. Two steps may share one input name.
- `{ "fromStep": 0, "in": "structuredContent" | "text", "path": [...] }`: a value from the result of
  an earlier step. `fromStep` is a 0-based step index. `"text"` means the first text content item,
  parsed as JSON.

To approve a composite, set `"approved": true`. You can edit names, descriptions, inputs and paths.
The layer ignores `support`, `evidence` and any other extra fields.

## The layer

`createLayer(options)` takes `{ "file": "<path to proposals.json>" }` or `{ "composites": [...] }`. The layer checks the file when it
starts and fails with a clear message if it is wrong.

- `listTools` adds each approved composite that passes the checks below. Its input schema is built
  from the caller inputs, using each step tool's own property schema and `required` list. Its
  description names the real tools it calls.
- `callTool` on a composite first checks that every required input is there, so no step runs on a
  call that is bound to fail. Then it runs the steps through `next()`, one at a time. It returns the content of
  every step, each under a `Step N: <tool>` line. When a step fails, it stops and returns an error that
  says which step failed, plus the content of the steps that ran.
  A step fails when the tool returns `isError`, when `next()` throws, or when a mapped value is missing.
- Any other call passes through untouched.

A composite is not exposed when:

- a step tool is not in the live tool list,
- a step tool needs an argument that the composite does not map,
- its name is already a tool on the server,
- a step tool is not marked `readOnlyHint: true` and the composite does not set `"allowNonReadOnly": true`.

The layer prints the reason to stderr. A call to a composite that is not exposed gets an error and
never reaches the server.

## Why only read-only tools by default

A client asks the user before it runs a tool, or the user approves a tool once and for all. Either way,
the approval is for one tool. A composite hides several tool calls behind one name. If a composite
could contain a write, the user would approve "search then read" and also, without seeing it, approve
"delete". That breaks the deal the user made with the client.

Read-only tools do not change anything, so running them together is no worse than running them one by
one. Running one twice is also safe, so a retry of the whole composite is safe.

So the default rule is: every step must be marked `readOnlyHint: true` by the server. The spec says
the default for `readOnlyHint` is `false`, so a missing hint means "may write" and the step is refused.
The layer checks this against the live tool list on every `listTools`, not against the proposals file.
If the server changes a tool, the composite goes away on the next list.

A human can opt one composite in with `"allowNonReadOnly": true`. The composite is then listed with
`readOnlyHint: false` and no `destructiveHint`, so the client treats it as destructive (the spec
default) and asks the user. The layer does not retry or roll back. If step 2 of 3 fails after a write,
the write stays. The error says which step failed, so the caller can see what happened.

The hints come from the server. The spec says a client should not trust hints from a server it does
not trust. This check trusts the server you already chose to put behind the proxy. It stops honest
mistakes, not a hostile server.

## Known limits

- `callTool` cannot see the tool list, so the layer remembers the last `listTools` result. Before the
  first `listTools`, every composite call is refused.
- Only whole, exact values are matched. An id built into a URL, or a value in a nested argument, is not
  found.
- An argument is mapped from one fixed path. There is no "for each item" step.
- The combined result has content only. Each step's `structuredContent` is not carried over.
