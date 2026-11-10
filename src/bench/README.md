# bench

Compares four ways to expose the same MCP server to an agent, on the same tasks.

```sh
node src/cli.ts bench          # one table
node src/cli.ts bench --json   # the same rows as JSON
```

The command exits with code 1 if any run fails its checker.

## What is in here

| File | What it holds |
| --- | --- |
| `fixture.ts` | A fake issue tracker as a real MCP server (24 tools, seeded data, simulated latency), connected in memory. |
| `strategies.ts` | The four strategies. Each one gives the turn-one tool list and runs tool calls. |
| `tasks.ts` | 10 tasks, a checker for each, the `Runner` type, and the `oracle` runner. |
| `cli.ts` | Runs every task under every strategy, computes the metrics, prints the table. |
| `bench.test.ts` | Proves every oracle run passes, and that two runs give the same numbers. |

## The four strategies

All four sit on the same server with the same data. Every task starts with a fresh server.

- **upfront**: all 24 tool definitions on turn one. Calls go straight to the server.
- **search**: one `search_tools` tool. It returns the full definitions of up to 3 tools that match the keywords.
  A tool can be called only after a search has returned it.
- **code**: one `execute` tool. Its description lists a one-line signature for every server tool.
  The script calls the tools and only the returned value goes back to the model.
- **mirror**: the data is copied into an in-memory SQLite database through the public tools before the task.
  The model gets one read-only `query` tool, plus the 10 write tools, passed through.
  After each write, the mirror reads the changed issue back so the next query sees it.

## Metrics

Per task and strategy:

- `calls`: tool calls the model makes. Each one is a model round trip.
- `upstream`: calls that reach the server.
- `def tok`: tool definitions on turn one (name, description, input schema).
- `result tok`: all tool results the model reads. For tool search this includes the definitions it loads.
- `input tok`: text the model writes as tool arguments, scripts included.
- `sim ms`: simulated server time per call (see `LATENCY_MS` in `fixture.ts`), plus 2 ms per local step.
- `ok`: the task checker passed. `crash` means the run threw, which is kept apart from a wrong answer.

Tokens are characters / 4. That is close enough to compare strategies, not to predict a bill.

## The oracle runner

A `Runner` takes a strategy and a task and returns a trajectory (the steps and the final answer).
The only runner here is `oracle`: a hand-written, best-case trajectory for each task under each strategy.
The oracle never reads the store. It only sees what the tools return. The checker reads the store.

So the table shows the floor for each strategy: the fewest calls and tokens a perfect agent would need.
It says nothing about how often a real model finds that path.

## Plugging in a real model

Write a function of type `Runner` (in `tasks.ts`) and pass it to `runBench(runner)` (in `cli.ts`).
It should send `strategy.tools` to the model, run every tool call the model makes through `strategy.call`,
and return `{ steps: strategy.steps, answer }`. Every metric then comes out the same way it does for the oracle.

For the comparison to be fair, fix these and publish them with the results:

- **Model.** One exact model id and snapshot for all four strategies. Same temperature, same max output tokens.
- **Prompt.** One system prompt for all four. The only thing that changes is the tool list.
  If a strategy needs a usage hint (for example "search before you call"), write it once, put it in the
  tool description, and keep it in the repo.
- **Turn limit.** The same cap for all, for example 40 model turns. Hitting the cap is a failure, not a crash.
- **Retry policy.** Tool errors go back to the model as tool results, and it may try again. That counts.
  Transport or rate-limit errors from the model API are retried by the harness and not counted, but logged.
  A run that still fails is a `crash`, kept apart from a wrong answer.
- **Sample count.** At least 5 runs per task per strategy. Report the mean success rate and pass^k
  (all k runs pass). Compare strategies per task (paired). If you add intervals, resample tasks, not runs.
- **Token counts.** Use the usage numbers the model API returns, summed over every model call in the run.
  That includes the history re-sent on each turn, which chars / 4 on the tool text does not.
- **Wall time.** Measure real time, model time included. Keep `sim ms` next to it.
- **Code mode sandbox.** Model-written scripts must run in a real sandbox (a separate process or a container).
  `node:vm` is not one. Replace the `SHIPPED_SCRIPTS` check in `strategies.ts` when you do this.
- **Mirror freshness.** Decide when the mirror syncs and count it. Here it backfills before every task and
  that cost is printed under the table, not in the rows.

## Where these numbers mislead

- They are best case. A real model searches with worse keywords, guesses result shapes, and retries.
- Code mode looks almost free here because the oracle script already knows the shape of each result
  (`.total`, `.issues`, `author.name`). A model only sees input signatures, so it usually needs a first call to
  look at the output. The tool list carries no output schemas.
- The mirror looks almost free on reads because the backfill (191 calls) is left out of the rows,
  and because the data never changes during a task. Real sources change, and a stale answer is a wrong answer.
- `calls` for upfront and search assume one call per round trip. A model that sends several tool calls in one turn
  needs fewer round trips. Code mode wins most on the task that loops over 60 issues (`most-commented`).
- Turn-one `def tok` is the only context cost counted. Definitions and earlier results are re-sent on every later
  turn, so the real input cost of a long upfront or search run is much higher than the table shows.
- 24 tools and 10 tasks on one made-up domain. The trade-off may flip at 100 or 500 tools, or with near-duplicate tools.
- Simulated latency is a fixed number per tool. No network jitter, no rate limits, no cold starts.
