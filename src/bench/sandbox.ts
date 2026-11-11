// Runs a code-mode script in a separate Node process, so model-written code never runs in this process.
// The child runs under Node's permission model: no file system, no network, no child processes,
// no workers, no addons. It gets an empty environment (so no API key), cannot build code from strings,
// and is killed at the time limit. Its only way out is the IPC channel, and over that it can only
// call the tools this process chooses to run.
// ponytail: Node's permission model is a seat belt, not a jail (its docs say malicious code can get around it).
// Fine for a benchmark on synthetic data. Run the child in a container or an OS sandbox before you trust real data to it.
import { spawn } from "node:child_process";

export type RunTool = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
export type ScriptResult = { ok: true; value: unknown } | { ok: false; error: string };

export const SCRIPT_TIMEOUT_MS = 10_000;

// The child side. `tools.<name>(args)` sends one IPC message and waits for the answer.
const prelude = `"use strict";
const pending = new Map(); let next = 0;
const tools = new Proxy({}, { get: (_, tool) => (args = {}) => new Promise((ok, no) => {
  const id = ++next; pending.set(id, { ok, no }); process.send({ type: "call", id, tool: String(tool), args });
}) });
process.on("message", (m) => { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.no(new Error(m.error)) : p.ok(m.value); });
const done = (m) => process.send(m, () => process.exit(0));
(async () => {
`;
const epilogue = `
})().then((value) => done({ type: "done", value: value === undefined ? null : value }), (e) => done({ type: "fail", error: String(e && e.message || e) }));`;

export function runScript(script: string, runTool: RunTool, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ScriptResult> {
  const child = spawn(process.execPath, ["--permission", "--disallow-code-generation-from-strings", "-e", prelude + script + epilogue], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {},
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ScriptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `Script stopped: it ran longer than ${timeoutMs} ms.` }), timeoutMs);
    child.on("message", async (m: any) => {
      if (m?.type === "done") return finish({ ok: true, value: m.value });
      if (m?.type === "fail") return finish({ ok: false, error: m.error });
      if (m?.type !== "call") return;
      try {
        const value = await runTool(String(m.tool), m.args ?? {});
        if (!settled) child.send({ id: m.id, value });
      } catch (e) {
        if (!settled) child.send({ id: m.id, error: (e as Error).message });
      }
    });
    child.on("exit", (code, signal) => finish({ ok: false, error: `Script process exited (${signal ?? code}). ${lastLines(stderr)}`.trim() }));
    child.on("error", (e) => finish({ ok: false, error: `Script process failed to start: ${e.message}` }));
  });
}

/** The useful part of a Node error on stderr, without the stack. */
const lastLines = (s: string) => s.split("\n").filter((l) => l.trim() && !l.startsWith("    at ")).slice(-3).join(" ");
