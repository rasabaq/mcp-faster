#!/usr/bin/env node
// Each command lives in its own folder and exports: main(argv: string[]): Promise<void>
// The imports are written out so the build can rewrite ".ts" to ".js".
type Command = () => Promise<{ main: (argv: string[]) => Promise<void> }>;
const commands: Record<string, Command> = {
  stats: () => import("./stats/cli.ts"),
  bench: () => import("./bench/cli.ts"),
  mine: () => import("./consolidate/cli.ts"),
  proxy: () => import("./proxy/cli.ts"),
  "slack-tickets": () => import("./slack-tickets/cli.ts"),
};

const [name, ...argv] = process.argv.slice(2);
const load = name ? commands[name] : undefined;
if (!load) {
  console.error(`usage: mcp-faster <${Object.keys(commands).join(" | ")}> [options]`);
  process.exit(1);
}
await (await load()).main(argv);
