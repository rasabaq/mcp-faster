import { test } from "node:test";
import assert from "node:assert/strict";
import { seedStore, startFixture } from "./fixture.ts";
import { createStrategy, resultText, searchTools } from "./strategies.ts";
import { runScript } from "./sandbox.ts";
import { TASKS } from "./tasks.ts";
import { formatTable, runBench } from "./cli.ts";

test("every oracle trajectory passes its checker under every strategy", async () => {
  const { rows } = await runBench();
  assert.equal(rows.length, TASKS.length * 4);
  for (const r of rows) assert.ok(r.ok, `${r.task} / ${r.strategy} failed${r.error ? `: ${r.error}` : ""}`);
});

test("two runs give the same numbers", async () => {
  const a = await runBench();
  const b = await runBench();
  assert.deepEqual(a, b);
  assert.equal(formatTable(a.rows, a.setup), formatTable(b.rows, b.setup));
});

test("checkers are not vacuous: an empty answer on untouched data fails every task", () => {
  for (const t of TASKS) assert.equal(t.check("", seedStore()), false, t.id);
});

test("tool search only allows tools it has returned", async () => {
  const fx = await startFixture();
  try {
    const s = await createStrategy("search", fx);
    assert.equal((await s.call("list_projects", {})).isError, true);
    await s.call("search_tools", { query: "list projects" });
    assert.notEqual((await s.call("list_projects", {})).isError, true);
  } finally {
    await fx.close();
  }
  assert.deepEqual(searchTools([{ name: "a_b", description: "x", inputSchema: { type: "object" } }], "zzz"), []);
});

test("code mode runs a model-written script in a separate process and returns its value", async () => {
  const fx = await startFixture();
  try {
    const s = await createStrategy("code", fx);
    const r = await s.call("execute", { script: "const p = await tools.list_projects({}); return { n: p.length, pid: process.pid !== undefined }" });
    assert.notEqual(r.isError, true);
    assert.deepEqual(JSON.parse(resultText(r)), { n: 3, pid: true });
    const bad = await s.call("execute", { script: "return await tools.no_such_tool({})" });
    assert.equal(bad.isError, true);
    assert.match(resultText(bad), /Unknown tool no_such_tool/);
  } finally {
    await fx.close();
  }
});

test("code mode sandbox: no files, no network, no env, no eval, and a time limit", async () => {
  const noTools = async () => null;
  const denied = async (script: string) => {
    const r = await runScript(script, noTools, 5000);
    assert.equal(r.ok, false, `expected ${script} to fail, got ${JSON.stringify(r)}`);
    return r.ok ? "" : r.error;
  };
  assert.match(await denied(`return require("node:fs").readFileSync(${JSON.stringify(import.meta.filename)}, "utf8")`), /fs-read|restricted/i);
  assert.match(await denied(`return (await import("node:fs/promises")).readFile("/etc/hosts", "utf8")`), /fs-read|restricted/i);
  assert.match(await denied(`return await new Promise((ok, no) => require("node:net").connect(80, "127.0.0.1", ok).on("error", no))`), /ACCESS_DENIED|allow-net/);
  assert.match(await denied(`return (await fetch("http://127.0.0.1:9/")).status`), /fetch failed/);
  assert.match(await denied(`return require("node:child_process").execSync("echo hi").toString()`), /child-process|restricted/i);
  assert.match(await denied(`return eval("1 + 1")`), /Code generation from strings disallowed/);
  const env = await runScript("return Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/i.test(k))", noTools);
  assert.deepEqual(env, { ok: true, value: [] });
  const t0 = Date.now();
  assert.match(await (async () => { const r = await runScript("while (true) {}", noTools, 300); return r.ok ? "" : r.error; })(), /longer than 300 ms/);
  assert.ok(Date.now() - t0 < 3000);
});

test("mirror query is read-only and the mirror sees its own writes", async () => {
  const fx = await startFixture();
  try {
    const s = await createStrategy("mirror", fx);
    assert.equal((await s.call("query", { sql: "DELETE FROM issues" })).isError, true);
    await s.call("add_label", { issue_id: "CORE-1", label: "zz" });
    const r = await s.call("query", { sql: "SELECT label FROM issue_labels WHERE issue_id = 'CORE-1' AND label = 'zz'" });
    assert.match(r.content[0]!.type === "text" ? r.content[0]!.text : "", /zz/);
  } finally {
    await fx.close();
  }
});
