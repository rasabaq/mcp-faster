// A real-model runner: drives Claude through the Anthropic Messages API with tool use.
// Plain fetch, no SDK. Every tool call goes through strategy.call, so metrics come out the same as for the oracle.
import { resultText } from "./strategies.ts";
import type { ModelUsage, Runner } from "./tasks.ts";

/** Dollars per million tokens, from the published Anthropic prices. Cache writes are the 5-minute rate (1.25x input). */
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

/** The fixed settings. The same for every strategy; only the tool list changes. */
export const DEFAULT_SETTINGS = {
  model: "claude-sonnet-5-5",
  apiVersion: "2026-10-21",
  maxTokens: 16_000,
  // Thinking is left at the model default (adaptive). Effort is set, not left to the default.
  effort: "medium",
  // API version 2026-10-21 rejects temperature, top_p and top_k on every model, so none is sent.
  temperature: "not sent (model default; the API version does not accept it)",
  maxTurns: 40,
  // Prompt caching: one top-level breakpoint that moves to the end of the history on each turn.
  cache: "automatic, 5-minute",
  // Tool search: hidden tools are shown with tool_addition blocks, so the tools list never changes mid-run.
  beta: "mid-conversation-tool-changes-2026-07-01",
  system:
    "You work with an issue tracker through the tools you are given. Use the tools to look up the facts " +
    "or make the changes the user asks for. Do not guess. When the task is done, reply with only the final " +
    "answer, in the exact format the user asks for, and nothing else.",
};
export type ModelSettings = typeof DEFAULT_SETTINGS;

export const RETRY = { max: 6, baseMs: 1000, capMs: 60_000, timeoutMs: 300_000 };
const API_URL = "https://api.anthropic.com/v1/messages";

export interface ModelRunnerOptions {
  apiKey: string;
  settings?: Partial<ModelSettings>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** A crash that still carries what the run spent before it failed. */
export class RunCrash extends Error {
  usage: ModelUsage;
  constructor(message: string, usage: ModelUsage) {
    super(message);
    this.usage = usage;
  }
}

export function createModelRunner(opts: ModelRunnerOptions) {
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const price = PRICES[settings.model];
  if (!price) throw new Error(`No price for model ${settings.model}. Known: ${Object.keys(PRICES).join(", ")}.`);
  if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  // Every line and error that leaves this file goes through redact, so the key can never show up.
  const redact = (s: string) => s.split(opts.apiKey).join("[redacted]");
  const log = (line: string) => (opts.log ?? ((l: string) => console.error(l)))(redact(line));
  const totals = { spentUsd: 0, maxRunUsd: 0 };

  /** One model call. Retries transport errors, 429 and 5xx with backoff. Anything else throws. */
  async function callApi(body: unknown, usage: ModelUsage): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      let reason: string;
      let waitMs = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** attempt);
      try {
        const res = await doFetch(API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": settings.apiVersion,
            "anthropic-beta": settings.beta,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(RETRY.timeoutMs),
        });
        if (res.ok) return await res.json();
        const text = (await res.text()).slice(0, 500);
        if (res.status !== 429 && res.status < 500) throw new Fatal(`API error ${res.status}: ${text}`);
        reason = `HTTP ${res.status}`;
        const after = Number(res.headers.get("retry-after"));
        if (after > 0) waitMs = Math.min(RETRY.capMs, after * 1000);
      } catch (e) {
        if (e instanceof Fatal) throw new Error(redact(e.message));
        reason = `transport error: ${(e as Error).message}`;
      }
      if (attempt >= RETRY.max) throw new Error(redact(`Model API failed after ${RETRY.max} retries: ${reason}`));
      usage.retries++;
      log(`retry ${attempt + 1}/${RETRY.max} after ${reason}, waiting ${Math.round(waitMs / 1000)} s`);
      await sleep(waitMs);
    }
  }

  const run: Runner = async (strategy, task) => {
    const usage: ModelUsage = {
      turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0, retries: 0, stopReason: "", hitTurnCap: false,
    };
    const toApi = (t: { name: string; description?: string; inputSchema: unknown }) => ({
      name: t.name, description: t.description ?? "", input_schema: t.inputSchema,
    });
    const tools: any[] = strategy.tools.map(toApi);
    // Tool search: declare every loadable tool now, hidden, so the tools list stays the same all run.
    if (strategy.deferred) tools.push(...strategy.deferred.tools.map((t) => ({ ...toApi(t), defer_loading: true })));
    const shown = new Set<string>();
    const messages: any[] = [{ role: "user", content: task.prompt }];

    try {
      while (usage.turns < settings.maxTurns) {
        const res = await callApi({
          model: settings.model,
          max_tokens: settings.maxTokens,
          system: settings.system,
          tools,
          messages,
          output_config: { effort: settings.effort },
          cache_control: { type: "ephemeral" },
        }, usage);
        usage.turns++;
        const u = res.usage ?? {};
        usage.inputTokens += u.input_tokens ?? 0;
        usage.outputTokens += u.output_tokens ?? 0;
        usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
        const cost = ((u.input_tokens ?? 0) * price.input + (u.output_tokens ?? 0) * price.output +
          (u.cache_creation_input_tokens ?? 0) * price.cacheWrite + (u.cache_read_input_tokens ?? 0) * price.cacheRead) / 1e6;
        usage.costUsd += cost;
        totals.spentUsd += cost;
        usage.stopReason = res.stop_reason ?? "";

        // Keep the assistant turn exactly as sent back, thinking blocks included. The history is append-only.
        const content: any[] = res.content ?? [];
        messages.push({ role: "assistant", content });
        const uses = content.filter((b) => b.type === "tool_use");
        if (res.stop_reason !== "tool_use" || uses.length === 0) {
          const answer = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
          return { steps: strategy.steps, answer, usage };
        }
        // All results of one turn go back in one user message. Tool errors go back too, and the model may retry.
        const results = [];
        for (const use of uses) {
          const r = await strategy.call(use.name, use.input ?? {});
          results.push({ type: "tool_result", tool_use_id: use.id, content: resultText(r), ...(r.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        const fresh = [...(strategy.deferred?.loaded ?? [])].filter((n) => !shown.has(n));
        if (fresh.length) {
          for (const n of fresh) shown.add(n);
          messages.push({ role: "system", content: fresh.map((name) => ({ type: "tool_addition", tool: { type: "tool_reference", name } })) });
        }
      }
      usage.hitTurnCap = true;
      return { steps: strategy.steps, answer: "", usage };
    } catch (e) {
      throw new RunCrash(redact((e as Error).message), usage);
    } finally {
      totals.maxRunUsd = Math.max(totals.maxRunUsd, usage.costUsd);
    }
  };

  return {
    run,
    settings,
    /** Dollars spent so far, from real usage, crashed runs included. */
    get spentUsd() { return totals.spentUsd; },
    /** The most one run has cost so far. Used to guess whether the next run fits in the budget. */
    get maxRunUsd() { return totals.maxRunUsd; },
  };
}

class Fatal extends Error {}
