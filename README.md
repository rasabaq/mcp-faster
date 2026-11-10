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

## Develop

Needs Node 24 or newer. TypeScript runs directly, there is no build step.

```sh
npm ci
npm test
npm run typecheck
node src/cli.ts stats
```

Every proxy layer implements the one contract in `src/layer.ts`.
