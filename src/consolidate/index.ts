// The consolidate layer. It adds approved composite tools to the tool list and runs them.
// A composite runs its steps one by one through next(). Every other call passes through.
// Why only read-only tools by default: see README.md in this folder.
import { readFileSync } from "node:fs";
import { validateToolName } from "@modelcontextprotocol/sdk/shared/toolNameValidation.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CallParams, Layer, Next } from "../layer.ts";

// Where a step argument comes from.
// - { input }: the caller passes it. Steps may share an input name.
// - { fromStep, in, path }: a value from the result of an earlier step (fromStep is a 0-based step index).
//   `in` picks structuredContent, or the first text content item parsed as JSON.
const Source = z.union([
  z.strictObject({ input: z.string().min(1) }),
  z.strictObject({
    fromStep: z.number().int().min(0),
    in: z.enum(["structuredContent", "text"]),
    path: z.array(z.union([z.string(), z.number().int().min(0)])),
  }),
]);

const Composite = z
  .object({
    name: z.string().refine((n) => validateToolName(n).isValid, "is not a valid MCP tool name"),
    description: z.string().default(""),
    approved: z.boolean(),
    // Opt in to steps that the server does not mark read-only. Off unless a human sets it.
    allowNonReadOnly: z.boolean().default(false),
    steps: z.array(z.object({ tool: z.string().min(1), args: z.record(z.string(), Source) })).min(2),
  })
  .superRefine((c, ctx) => {
    c.steps.forEach((step, i) => {
      for (const [arg, src] of Object.entries(step.args)) {
        if ("fromStep" in src && src.fromStep >= i) {
          ctx.addIssue({ code: "custom", message: `steps[${i}] argument "${arg}" reads from steps[${src.fromStep}], which has not run yet` });
        }
      }
    });
  });

const Proposals = z.object({ composites: z.array(Composite) });

export type Composite = z.infer<typeof Composite>;
export type ArgSource = z.infer<typeof Source>;

/**
 * options: `{ file: "proposals.json" }` or `{ composites: [...] }`.
 * Only composites with `approved: true` are used.
 */
export function createLayer(options: unknown): Layer {
  let raw = options;
  if (options && typeof options === "object" && "file" in options && typeof options.file === "string") {
    try {
      raw = JSON.parse(readFileSync(options.file, "utf8"));
    } catch (err) {
      throw new Error(`consolidate: cannot read ${options.file}: ${(err as Error).message}`);
    }
  }
  const parsed = Proposals.safeParse(raw);
  if (!parsed.success) throw new Error(`consolidate: bad options: ${z.prettifyError(parsed.error)}`);
  const approved = parsed.data.composites.filter((c) => c.approved);
  const names = approved.map((c) => c.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`consolidate: composite "${dup}" is defined twice`);

  // State from the last listTools call. callTool cannot see the live list, so we keep it here.
  let exposed = new Map<string, { c: Composite; required: string[] }>();
  let refused = new Map<string, string>();
  let upstream = new Set<string>();

  return {
    name: "consolidate",

    listTools(tools) {
      const byName = new Map(tools.map((t) => [t.name, t]));
      exposed = new Map();
      refused = new Map();
      upstream = new Set(byName.keys());
      const out = [...tools];
      for (const c of approved) {
        const result = buildTool(c, byName);
        if (typeof result === "string") {
          refused.set(c.name, result);
          console.error(`consolidate: not exposing "${c.name}": ${result}`);
          continue;
        }
        exposed.set(c.name, { c, required: result.inputSchema.required ?? [] });
        out.push(result);
      }
      return out;
    },

    async callTool(params, next) {
      const live = exposed.get(params.name);
      if (live) {
        // Check inputs first, so a step does not run on a call that is bound to fail later.
        const missing = live.required.filter((k) => params.arguments?.[k] === undefined);
        if (missing.length) return errorResult(`Composite "${params.name}" needs: ${missing.join(", ")}. No step ran.`);
        return runComposite(live.c, params, next);
      }
      // A refused composite must not reach the server, unless the server owns that name.
      if (names.includes(params.name) && !upstream.has(params.name)) {
        const why = refused.get(params.name) ?? "the tool list has not been loaded yet";
        return errorResult(`Composite "${params.name}" is not available: ${why}.`);
      }
      return next(params);
    },
  };
}

/** Returns the composite tool, or a reason why it may not be exposed. */
function buildTool(c: Composite, byName: Map<string, Tool>): Tool | string {
  if (byName.has(c.name)) return "the server already has a tool with this name";
  const properties: Record<string, object> = {};
  const required = new Set<string>();
  let allReadOnly = true;
  for (const [i, step] of c.steps.entries()) {
    const tool = byName.get(step.tool);
    if (!tool) return `step ${i + 1} uses "${step.tool}", which the server does not list`;
    if (tool.annotations?.readOnlyHint !== true) {
      allReadOnly = false;
      if (!c.allowNonReadOnly) {
        return `step ${i + 1} uses "${step.tool}", which the server does not mark readOnlyHint: true. Set "allowNonReadOnly": true on this composite to opt in`;
      }
    }
    const props = (tool.inputSchema.properties ?? {}) as Record<string, object>;
    for (const arg of tool.inputSchema.required ?? []) {
      if (!(arg in step.args)) return `step ${i + 1} ("${step.tool}") needs argument "${arg}", but the composite does not map it`;
    }
    for (const [arg, src] of Object.entries(step.args)) {
      if (!("input" in src)) continue;
      properties[src.input] ??= props[arg] ?? {};
      if (tool.inputSchema.required?.includes(arg)) required.add(src.input);
    }
  }
  const tools = c.steps.map((s) => s.tool).join(", then ");
  return {
    name: c.name,
    description:
      `Calls these tools in order: ${tools}. ` +
      `If a step fails, it stops and returns the results so far.` +
      (c.description ? ` ${c.description}` : ""),
    inputSchema: { type: "object", properties, required: [...required] },
    // No destructiveHint: when readOnlyHint is false, clients then assume the worst (spec default true).
    annotations: { readOnlyHint: allReadOnly },
  };
}

async function runComposite(c: Composite, params: CallParams, next: Next): Promise<CallToolResult> {
  const input = params.arguments ?? {};
  const results: CallToolResult[] = [];
  const content: CallToolResult["content"] = [];
  const fail = (i: number, why: string): CallToolResult => ({
    isError: true,
    content: [
      ...content,
      { type: "text", text: `Step ${i + 1} of ${c.steps.length} (${c.steps[i]!.tool}) failed: ${why}. Later steps did not run.` },
    ],
  });

  for (const [i, step] of c.steps.entries()) {
    const args: Record<string, unknown> = {};
    for (const [arg, src] of Object.entries(step.args)) {
      if ("input" in src) {
        if (input[src.input] !== undefined) args[arg] = input[src.input];
        continue;
      }
      const value = readPath(results[src.fromStep]!, src.in, src.path);
      if (value === undefined) {
        const where = [src.in, ...src.path].join(".");
        return fail(i, `argument "${arg}" should come from ${where} in the result of step ${src.fromStep + 1}, but there is no value there`);
      }
      args[arg] = value;
    }
    let result: CallToolResult;
    try {
      result = await next({ name: step.tool, arguments: args });
    } catch (err) {
      return fail(i, err instanceof Error ? err.message : String(err));
    }
    results.push(result);
    content.push({ type: "text", text: `Step ${i + 1}: ${step.tool}` }, ...(result.content ?? []));
    if (result.isError) return fail(i, "the tool returned an error, shown above");
  }
  return { content };
}

/** Reads a value from a tool result. Used by the layer and by the miner, so both agree on paths. */
export function readPath(
  result: { structuredContent?: unknown; content?: unknown[] },
  from: "structuredContent" | "text",
  path: (string | number)[],
): unknown {
  let value = from === "structuredContent" ? result.structuredContent : jsonText(result.content ?? []);
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/** The first text content item that parses as a JSON object or array. */
export function jsonText(content: unknown[]): unknown {
  for (const item of content) {
    const text = (item as { type?: unknown; text?: unknown })?.type === "text" ? (item as { text: unknown }).text : undefined;
    if (typeof text !== "string") continue;
    try {
      const value = JSON.parse(text);
      if (value !== null && typeof value === "object") return value;
    } catch {
      // not JSON, try the next item
    }
  }
  return undefined;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
