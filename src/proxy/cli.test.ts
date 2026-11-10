// Tests of the config, the layer loader, and the real `mcp-faster proxy` process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadLayers, parseConfig, type Config } from "./cli.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/server.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcp-faster-proxy-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(name: string, config: unknown) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(config));
  return file;
}
const fixtureConfig = { server: "fixture", upstream: { command: process.execPath, args: [fixture] } };

/** Runs the proxy process with nothing on stdin. Resolves with its exit code and output. */
function run(args: string[]) {
  const child = spawn(process.execPath, [cli, "proxy", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

describe("parseConfig", () => {
  test("fills defaults and expands environment variables in headers and env", () => {
    process.env.MCP_FASTER_TEST_TOKEN = "synthetic-token";
    const config = parseConfig(
      JSON.stringify({ server: "s", upstream: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MCP_FASTER_TEST_TOKEN}" } } }),
    );
    assert.deepEqual(config, { server: "s", upstream: { url: "https://example.com/mcp", headers: { Authorization: "Bearer synthetic-token" } }, layers: [] });
    const stdio = parseConfig(JSON.stringify({ server: "s", upstream: { command: "x", env: { KEY: "${MCP_FASTER_TEST_TOKEN}" } }, layers: [{ use: "cache" }] }));
    assert.deepEqual(stdio.upstream, { command: "x", args: [], env: { KEY: "synthetic-token" } });
    assert.deepEqual(stdio.layers, [{ use: "cache" }]);
  });

  test("lists every problem with its path", () => {
    const text = JSON.stringify({
      upstream: { url: "http://example.com", headers: { Authorization: "${MCP_FASTER_TEST_MISSING}" } },
      layers: [{ use: "../../etc/passwd" }],
      extra: true,
    });
    assert.throws(() => parseConfig(text), (error: Error) => {
      for (const part of [
        "server:",
        "upstream.url: must be an https URL",
        "upstream.headers.Authorization: environment variable MCP_FASTER_TEST_MISSING is not set",
        'layers.0.use: Invalid option: expected one of "cache"|"consolidate"|"compact"',
        'Unrecognized key: "extra"',
      ]) {
        assert.ok(error.message.includes(part), `missing "${part}" in:\n${error.message}`);
      }
      return true;
    });
    assert.throws(() => parseConfig("{"), /config is not valid JSON/);
    assert.throws(() => parseConfig('{"server":"s","upstream":{"command":"x","url":"https://a.b"}}'), /upstream: Unrecognized key: "command"/);
    assert.throws(() => parseConfig('{"server":"s","upstream":"x"}'), /upstream: must be an object with either command or url/);
  });
});

describe("loadLayers", () => {
  const root = pathToFileURL(join(dir, "src") + "/");
  mkdirSync(join(dir, "src", "cache"), { recursive: true });
  writeFileSync(join(dir, "src", "cache", "index.ts"), "export function createLayer(options) { return { name: 'cache', options }; }\n");
  mkdirSync(join(dir, "src", "compact"), { recursive: true });
  writeFileSync(join(dir, "src", "compact", "index.ts"), "export const nothing = 1;\n");

  test("loads a layer by name and passes its options", async () => {
    const [layer] = await loadLayers([{ use: "cache", options: { ttl: 5 } }], root);
    assert.deepEqual(layer, { name: "cache", options: { ttl: 5 } });
  });

  test("fails clearly for an unknown, missing, or broken layer", async () => {
    await assert.rejects(loadLayers([{ use: "../x" } as unknown as Config["layers"][number]], root), /unknown layer "..\/x". Known layers: cache, consolidate, compact/);
    await assert.rejects(loadLayers([{ use: "consolidate" }], root), /layer "consolidate" is not installed: .*consolidate\/index.ts does not exist/);
    await assert.rejects(loadLayers([{ use: "compact" }], root), /layer "compact" failed to load: it does not export createLayer\(options\)/);
  });
});

describe("mcp-faster proxy process", () => {
  test("serves the upstream on stdio and ends when the upstream exits", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "proxy", "--config", writeConfig("ok.json", fixtureConfig)], stderr: "pipe" });
    const client = new Client({ name: "test", version: "0" });
    const ended = Promise.withResolvers<void>();
    client.onclose = () => ended.resolve();
    await client.connect(transport);
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["echo", "notify", "exit"]);
      assert.deepEqual((await client.callTool({ name: "echo", arguments: { text: "hi" } })).content, [{ type: "text", text: "echo: hi" }]);
      await client.callTool({ name: "exit" });
      await ended.promise; // The proxy process ended on its own.
    } finally {
      await client.close();
    }
  });

  test("exits with code 0 and writes nothing to stdout when the client closes stdin", async () => {
    const result = await run(["--config", writeConfig("ok.json", fixtureConfig)]);
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  });

  test("exits with code 1 and a clear message for a bad config", async () => {
    const result = await run(["--config", writeConfig("bad.json", { server: "s", upstream: { command: "x" }, layers: [{ use: "nope" }] })]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /mcp-faster proxy: config is not valid:\n {2}layers.0.use: Invalid option/);
    assert.match((await run([])).stderr, /usage: mcp-faster proxy --config <file>/);
  });

  test("exits with code 1 when the upstream cannot start", async () => {
    const result = await run(["--config", writeConfig("nocmd.json", { server: "s", upstream: { command: join(dir, "does-not-exist") } })]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /could not connect to upstream server "s"/);
  });
});
