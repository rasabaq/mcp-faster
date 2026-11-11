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

Run on 2026-11-11 with `claude-sonnet-5-5`, effort `medium`, 5 runs per task per strategy (200 runs), turn cap 40.
It cost $2.78, plus $1.12 for a one-run pilot before it. Raw results: `bench-results/2026-11-11T14-00-12-155Z-claude-sonnet-5-5.json`.

```
MODEL RUN: claude-sonnet-5-5, 200/200 runs, spent $2.7800 of $18.

task                strategy   k            ok       pass^k  crash  cap  turns  calls  in tok  out tok       $  wall s
------------------  --------  --  ------------  -----------  -----  ---  -----  -----  ------  -------  ------  ------
count-open-p1       upfront    5           5/5          yes      0    0      2      1   11360      122  0.0024     3.3
count-open-p1       search     5           5/5          yes      0    0      3      2    8414      172  0.0026     4.3
count-open-p1       code       5           5/5          yes      0    0      3      2    5080      305  0.0044     5.0
count-open-p1       mirror     5           5/5          yes      0    0      2      1    4597       84  0.0013     4.4
user-open-issues    upfront    5           5/5          yes      0    0      3      5   15517      468  0.0062     5.2
user-open-issues    search     5           5/5          yes      0    0      5      8   16056      644  0.0195     7.4
user-open-issues    code       5           5/5          yes      0    0      4      3    8301      482  0.0080     8.3
user-open-issues    mirror     5           5/5          yes      0    0      3      2    7890      222  0.0048     3.8
oldest-open-bug     upfront    5           5/5          yes      0    0      2      1   10983      155  0.0027     2.6
oldest-open-bug     search     5           5/5          yes      0    0      3      2    8040      175  0.0026     3.6
oldest-open-bug     code       5           5/5          yes      0    0      3      2    5450      439  0.0065     4.6
oldest-open-bug     mirror     5           5/5          yes      0    0      2      1    4740      125  0.0025     3.0
last-commenter      upfront    5           5/5          yes      0    0      2      1    8276       64  0.0015     2.8
last-commenter      search     5           5/5          yes      0    0      3      2    5099      117  0.0017     3.3
last-commenter      code       5           5/5          yes      0    0      2      1    3788       82  0.0012     2.3
last-commenter      mirror     5           5/5          yes      0    0      2      1    4724      108  0.0022     3.0
milestone-progress  upfront    5           5/5          yes      0    0      3      3   19155      305  0.0050     4.3
milestone-progress  search     5           5/5          yes      0    0      4      4   13753      361  0.0050     6.2
milestone-progress  code       5           5/5          yes      0    0      6      5   12325      673  0.0108    20.9
milestone-progress  mirror     5           5/5          yes      0    0      2      1    4713      173  0.0023     3.0
unassigned-open     upfront    5           5/5          yes      0    0      3      4   49732      437  0.0094     4.9
unassigned-open     search     5           5/5          yes      0    0      5      6   48857      557  0.1034     7.1
unassigned-open     code       5           2/5           no      0    0      3      2    5486      558  0.0077     7.1
unassigned-open     mirror     5           5/5          yes      0    0      2      1    4589       82  0.0017     2.3
most-commented      upfront    5           1/5           no      0    0      5     62  140840     3337  0.1265    21.1
most-commented      search     5           2/5           no      0    0      5     63   96558     3307  0.1214    19.9
most-commented      code       5           5/5          yes      0    0      3      2    5439      505  0.0071     5.3
most-commented      mirror     5           5/5          yes      0    0      2      1    4578      105  0.0015     3.1
assign-and-comment  upfront    5           5/5          yes      0    0      3      3   12810      276  0.0041     7.1
assign-and-comment  search     5           5/5          yes      0    0      5      6   13887      459  0.0097     6.8
assign-and-comment  code       5           5/5          yes      0    0      3      2    5542      282  0.0051     4.5
assign-and-comment  mirror     5           5/5          yes      0    0      3      3    7436      317  0.0039     4.4
close-duplicates    upfront    5           5/5          yes      0    0      3      7   18936      664  0.0085     5.8
close-duplicates    search     5           5/5          yes      0    0      4      9   17096      762  0.0093     7.4
close-duplicates    code       5           5/5          yes      0    0      4      3    7472      564  0.0080     8.2
close-duplicates    mirror     5           5/5          yes      0    0      3      7   10087      614  0.0072     5.8
triage-unlabeled    upfront    5           5/5          yes      0    0      3      2   20940      267  0.0048     4.4
triage-unlabeled    search     5           5/5          yes      0    0      4      4   18830      376  0.0057     7.0
triage-unlabeled    code       5           5/5          yes      0    0      4      3    8053      493  0.0084     9.1
triage-unlabeled    mirror     5           5/5          yes      0    0      3      3    7641      255  0.0051     5.9
------------------  --------  --  ------------  -----------  -----  ---  -----  -----  ------  -------  ------  ------
TOTAL               upfront   50   46/50 (92%)   9/10 tasks      0    0      3      3   17227      292  0.8539     4.6
TOTAL               search    50   47/50 (94%)   9/10 tasks      0    0      4      5   14678      417  1.3971     6.8
TOTAL               code      50   47/50 (94%)   9/10 tasks      0    0      3      2    5544      487  0.3523     6.5
TOTAL               mirror    50  50/50 (100%)  10/10 tasks      0    0      2      1    4732      132  0.1767     3.5

k: runs. ok: runs that passed the checker. pass^k: every run passed. crash: the run threw (API failure), kept apart from wrong answers.
cap: the run hit the turn cap (counted as a failure, not a crash).
turns, calls, in tok, out tok, $, wall s: medians per run. In TOTAL rows, $ is the sum over all runs and the rest are medians.
in tok: all input tokens the API billed, summed over every model call (uncached + cache read + cache write).
```

What it shows:

- **The local copy (mirror) was the cheapest, fastest and most reliable.** It passed 50 of 50 runs for $0.18 in
  total, with a median of 2 turns and 3.5 seconds. Its rows do not include the backfill (191 upstream calls), so it
  only pays off when the same data is read again and again.
- **Code mode was about 2.4 times cheaper than all tools upfront** ($0.35 against $0.85), because the model reads
  one short answer, not pages of results. It was the only way to pass the hardest task (most-commented: 5 of 5)
  besides the mirror. But it failed 3 of 5 runs of `unassigned-open`, where the other three ways passed every run.
- **Tool search cost the most** ($1.40), 1.6 times more than all tools upfront, and was the slowest (6.8 s median).
  Its extra turns to find tools cost more than the tool definitions it saved.
- **All tools upfront and tool search broke on the task that needs 62 calls** (most-commented: 1 of 5 and 2 of 5).
  Pages of raw results pile up in the context, and the model loses count.

What it does not show: one model at one effort level, one made-up issue tracker with 24 tools, and 10 tasks. With 5
runs per cell, a single failure moves a rate by 20 points. Prices are list prices, not the bill. Code-mode time
includes about 75 ms to start each sandboxed script. The tool-search strategy uses a beta API feature
(`tool_addition`) that a real client may not use.

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
