#!/usr/bin/env node
// Each command lives in its own folder and exports: main(argv: string[]): Promise<void>
const commands: Record<string, string> = {
  stats: "./stats/cli.ts",
  bench: "./bench/cli.ts",
  mine: "./consolidate/cli.ts",
  proxy: "./proxy/cli.ts",
  "slack-tickets": "./slack-tickets/cli.ts",
};

const [name, ...argv] = process.argv.slice(2);
const path = name ? commands[name] : undefined;
if (!path) {
  console.error(`usage: mcp-faster <${Object.keys(commands).join(" | ")}> [options]`);
  process.exit(1);
}
const { main } = (await import(path)) as { main: (argv: string[]) => Promise<void> };
await main(argv);
