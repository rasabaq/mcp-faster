# mcp-faster

MCP servers expose the shape of an API. Agents need the shape of a task.
This project builds the missing pieces in between. The full list is in [mcp-gaps.md](mcp-gaps.md).

| Command | What it does | Gap |
| --- | --- | --- |
| `mcp-faster stats` | Reads your Claude Code logs and shows what each MCP server and tool costs you. | 4 |
| `mcp-faster bench` | Compares ways to expose tools (all upfront, tool search, code mode, local mirror) on the same tasks. | 4 |
| `mcp-faster mine` | Finds tool calls that always chain and proposes one composite tool for each chain. | 1 |
| `mcp-faster proxy` | Sits between a client and any MCP server and runs layers: `consolidate`, `cache`, `compact`. | 1, 2, 3, 8 |
| `mcp-faster slack-tickets` | A two-tool Slack server built around one job: work through the tickets in a channel. | 5 |

Spec proposals are in `spec/`.

## Proxy config

`mcp-faster proxy --config proxy.json` reads one JSON file. All fields are checked in `src/proxy/cli.ts`.

```json
{
  "server": "github",
  "upstream": { "command": "node", "args": ["/path/to/server.js"], "env": { "TOKEN": "${GITHUB_TOKEN}" } },
  "layers": [{ "use": "cache" }],
  "lazy": true
}
```

- `upstream` is `{ command, args, env }` for stdio or `{ url, headers }` for HTTP. `${NAME}` in `env` and `headers` reads an environment variable.
- `lazy` (default `false`): the first start saves a snapshot of what the server advertises. Later starts answer
  `initialize` and `tools/list` from it and start the server only on the first request that needs it.
  If the tool list has changed by then, the proxy saves a new snapshot and sends `notifications/tools/list_changed`.
- `cacheDir`: where snapshots go. Default `$XDG_CACHE_HOME/mcp-faster` or `~/.cache/mcp-faster`. A snapshot holds
  only what the server sent, never headers, env values or the URL. Its file mode is 0600.

## Develop

Needs Node 24 or newer. TypeScript runs directly, there is no build step.

```sh
npm ci
npm test
npm run typecheck
node src/cli.ts stats
```

Every proxy layer implements the one contract in `src/layer.ts`.
