# bench

Compares four ways to expose the same MCP server to an agent, on the same tasks.

```sh
node src/cli.ts bench          # one table
node src/cli.ts bench --json   # the same rows as JSON

# A real model. Reads the key from ANTHROPIC_API_KEY only. Spends real money.
node src/cli.ts bench --runner model [--runs N] [--model ID] [--budget USD] [--tasks a,b] [--strategies a,b] [--json]
```

The oracle command exits with code 1 if any run fails its checker. Without `--runner model` no network call is made.

## What is in here

| File | What it holds |
| --- | --- |
| `fixture.ts` | A fake issue tracker as a real MCP server (24 tools, seeded data, simulated latency), connected in memory. |
| `strategies.ts` | The four strategies. Each one gives the turn-one tool list and runs tool calls. |
| `tasks.ts` | 10 tasks, a checker for each, the `Runner` type, and the `oracle` runner. |
| `model.ts` | The real-model runner: Claude through the Messages API with plain `fetch`, fixed settings, retries, cost. |
| `sandbox.ts` | Runs code-mode scripts in a separate, locked-down Node process. |
| `cli.ts` | Runs every task under every strategy, computes the metrics, prints the table, keeps the budget. |
| `bench.test.ts` | Proves every oracle run passes, that two runs give the same numbers, and that the sandbox holds. |
| `model.test.ts` | Tests the model runner offline with a fake `fetch`: retries, budget, turn cap, key never leaks. |

## The four strategies

All four sit on the same server with the same data. Every task starts with a fresh server.

- **upfront**: all 24 tool definitions on turn one. Calls go straight to the server.
- **search**: one `search_tools` tool. It returns the full definitions of up to 3 tools that match the keywords.
  A tool can be called only after a search has returned it.
- **code**: one `execute` tool. Its description lists a one-line signature for every server tool.
  The script calls the tools and only the returned value goes back to the model.
  Every script runs in its own child process (see "Code mode sandbox" below).
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

## The model runner

`model.ts` drives a real model. It sends `strategy.tools` as the tool list, runs every tool call through
`strategy.call`, sends tool errors back as `is_error` results, and returns `{ steps, answer, usage }`.
The answer is the text of the last model turn.

Fixed settings, the same for all four strategies (`DEFAULT_SETTINGS` in `model.ts`, also written into every results file):

| Setting | Value |
| --- | --- |
| Model | `claude-sonnet-5-5` (no date suffix exists for this id) |
| API version | `2026-10-21` |
| Temperature | Not sent. API version `2026-10-21` rejects `temperature`, `top_p` and `top_k` on every model, so all runs use the model default. |
| Thinking | Model default (adaptive). Thinking blocks are passed back unchanged. |
| Effort | `medium`, set explicitly |
| Max output tokens | 16,000 per model call |
| Turn cap | 40 model calls per run. Hitting it is a failure (`cap`), not a crash. |
| System prompt | One prompt, in `model.ts`. Only the tool list changes. |
| Prompt caching | One automatic breakpoint (5-minute) that moves to the end of the history each turn. |
| Retries | Transport errors, 429 and 5xx: up to 6 retries, `retry-after` if sent, else 1 s, 2 s, 4 s ... up to 60 s. Logged, not counted as turns. Any other 4xx crashes the run. A 401 or 403 stops the whole bench. |
| Prices | $2 input, $10 output, $2.50 cache write, $0.10 cache read, per million tokens (published Sonnet 5.5 prices). |

Tool search with a real model: the API only lets a model call tools in the `tools` list, and changing that list
mid-run breaks the prompt cache and earlier thinking blocks. So all 24 server tools are declared up front with
`defer_loading: true` (hidden from the model), next to `search_tools`. When a search loads a tool, the runner appends
a system message with a `tool_addition` block for it (beta `mid-conversation-tool-changes-2026-07-01`, sent on every
request for every strategy). The search result still carries the full definitions, as before.

Budget: the runner adds up the dollar cost of every model call from the `usage` fields the API returns.
Before each run it checks `spent + costliest run so far <= --budget` (default $5). If not, it starts no more runs,
and the results say how far it got. Runs go run by run (all cells once, then all cells again), so a stopped bench
leaves every cell with about the same count.

Per run it records: the checker result, model turns, tool calls, input, output, cache read and cache write tokens
(summed over every call, history re-sent each turn included), retries, the last `stop_reason`, wall time, sim ms, and cost.
The table shows per task and strategy: runs, success, pass^k, crashes, cap hits, and medians of turns, calls, tokens,
cost and wall time. Crashes are counted apart from wrong answers.

Raw results go to `bench-results/<date>-<model>.json`, with the date, model, settings, code commit and every run.
No key and no headers are written. The key is read only from `ANTHROPIC_API_KEY`, and every log line, error and result
passes through a redaction step, so an API error that echoes the key cannot leak it.

## Code mode sandbox

A model writes its own scripts, and `node:vm` is not a security boundary, so scripts never run in this process.
`sandbox.ts` starts a child `node --permission --disallow-code-generation-from-strings` per script, with an empty
environment and a 10 second time limit. The permission model blocks the file system, network, child processes,
workers and addons. The script reaches the tools only through the IPC channel, and only names from the server's own
tool list are run. Tests check that a script cannot read a file, open a socket, `fetch`, spawn a process, `eval`,
or see any key, and that an endless loop is killed at its time limit.

Limits: Node's docs say the permission model is a seat belt, not a defence against code that tries to break out.
That is fine for synthetic data here. For real data, run the child in a container or an OS sandbox.
Each script now pays about 75 ms of process start-up in real wall time. Sim ms does not include it.

## Model results

None yet. The first attempt (2026-11-11) stopped at once: the API answered `401 invalid x-api-key` for the key in
`ANTHROPIC_API_KEY`, so no model call ran and nothing was billed. The table above is still the only data, and it is
the scripted best case. Run the command at the top with a working key to fill this section.

## Plugging in another runner

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
  `node:vm` is not one. Done: see "Code mode sandbox" above.
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
