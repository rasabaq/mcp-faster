// mcp-faster proxy --config <file>
// An MCP server on stdio that connects to one upstream MCP server and runs layers in between.
// stdout carries only MCP messages. Everything else goes to stderr.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { Layer } from "../layer.ts";
import { startProxy } from "./proxy.ts";

/** Layers the config may name. Each one lives in src/<name>/index.ts. */
export const LAYERS = ["cache", "consolidate", "compact"] as const;

// "${NAME}" in a value is replaced by the environment variable NAME, so secrets stay out of the file.
const withEnv = z.string().transform((value, ctx) =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = process.env[name];
    if (found === undefined) ctx.addIssue({ code: "custom", message: `environment variable ${name} is not set` });
    return found ?? "";
  }),
);

const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

const stdioUpstream = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), withEnv).default({}),
});
const httpUpstream = z.strictObject({
  url: z.string().refine((value) => {
    const url = URL.parse(value);
    return url?.protocol === "https:" || (url?.protocol === "http:" && isLocalHost(url.hostname));
  }, "must be an https URL (plain http is allowed only for localhost)"),
  headers: z.record(z.string(), withEnv).default({}),
});

const configSchema = z.strictObject({
  server: z.string().min(1),
  // Pick the branch by key, so the error talks about the right one.
  upstream: z.unknown().pipe(
    z.custom<object>((value) => typeof value === "object" && value !== null, "must be an object with either command or url").transform((value, ctx) => {
      const result = ("url" in value ? httpUpstream : stdioUpstream).safeParse(value);
      if (result.success) return result.data;
      for (const issue of result.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      return z.NEVER;
    }),
  ),
  layers: z.array(z.strictObject({ use: z.enum(LAYERS), options: z.unknown().optional() })).default([]),
  // true: once a snapshot of the upstream exists, start the upstream only on the first request that needs it.
  lazy: z.boolean().optional(),
  // Folder for snapshot files. Default: $XDG_CACHE_HOME/mcp-faster or ~/.cache/mcp-faster.
  cacheDir: z.string().min(1).optional(),
});

export type Config = z.infer<typeof configSchema>;

/** Parses and checks a config file's text. Throws an Error with one line per problem. */
export function parseConfig(text: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`config is not valid JSON: ${(error as Error).message}`);
  }
  const result = configSchema.safeParse(json);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new Error(`config is not valid:\n${lines.join("\n")}`);
}

/**
 * Loads layers by name from src/<name>/index.ts. Only names in LAYERS are allowed, so a config cannot load any other file.
 * `root` is the src folder. Tests point it at a temporary folder.
 */
export async function loadLayers(specs: Config["layers"], root = new URL("../", import.meta.url)): Promise<Layer[]> {
  const layers: Layer[] = [];
  try {
    for (const { use, options } of specs) {
      if (!(LAYERS as readonly string[]).includes(use)) throw new Error(`unknown layer "${use}". Known layers: ${LAYERS.join(", ")}`);
      const file = new URL(`${use}/index.ts`, root);
      if (!existsSync(file)) throw new Error(`layer "${use}" is not installed: ${fileURLToPath(file)} does not exist`);
      let layer: unknown;
      try {
        const mod = (await import(file.href)) as { createLayer?: unknown };
        if (typeof mod.createLayer !== "function") throw new Error("it does not export createLayer(options)");
        layer = await mod.createLayer(options);
      } catch (error) {
        throw new Error(`layer "${use}" failed to load: ${(error as Error).message}`, { cause: error });
      }
      if (typeof (layer as Layer | undefined)?.name !== "string") throw new Error(`layer "${use}": createLayer() must return an object with a name`);
      layers.push(layer as Layer);
    }
  } catch (error) {
    await Promise.allSettled(layers.map((layer) => layer.close?.()));
    throw error;
  }
  return layers;
}

export async function main(argv: string[]): Promise<void> {
  try {
    const { values } = parseArgs({ args: argv, options: { config: { type: "string" } } });
    if (!values.config) throw new Error("usage: mcp-faster proxy --config <file>");
    const config = parseConfig(readFileSync(values.config, "utf8"));
    const layers = await loadLayers(config.layers);
    let proxy;
    try {
      proxy = await startProxy(config, layers, new StdioServerTransport());
    } catch (error) {
      await Promise.allSettled(layers.map((layer) => layer.close?.()));
      throw new Error(`could not connect to upstream server "${config.server}": ${(error as Error).message}`, { cause: error });
    }
    // The SDK stdio transport does not notice when stdin ends, so watch for it here.
    process.stdin.once("end", () => void proxy.close());
    process.once("SIGINT", () => void proxy.close());
    process.once("SIGTERM", () => void proxy.close());
    await proxy.closed;
  } catch (error) {
    console.error(`mcp-faster proxy: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
