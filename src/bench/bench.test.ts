import { test } from "node:test";
import assert from "node:assert/strict";
import { seedStore, startFixture } from "./fixture.ts";
import { createStrategy, searchTools } from "./strategies.ts";
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

test("code mode refuses scripts that the benchmark does not ship", async () => {
  const fx = await startFixture();
  try {
    const s = await createStrategy("code", fx);
    const r = await s.call("execute", { script: "return process.env" });
    assert.equal(r.isError, true);
  } finally {
    await fx.close();
  }
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
