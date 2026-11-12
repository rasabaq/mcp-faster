// Every number the page text shows. index.html marks a slot with data-v="name";
// fillValues() puts the value from the table below into each slot, once, at start.
// Rule: a value is a bare number (the unit and the words stay in index.html),
// except money, the date and names. Values are HTML, so names go through esc().
import data from "../data.js";
import { $$, esc, fmt, pct, usd } from "./util.js";
import { way } from "./ways.js";

const { stats, bench } = data;
const { totals } = stats;
const mirror = way("mirror");
const upfront = way("upfront");

/** The server with the most sessions that never got a tool call: the clearest case of an idle server. */
const topIdle = [...stats.servers].filter((s) => s.calls === 0).sort((a, b) => b.sessions - a.sessions)[0];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-03-09" to "9 Mar 2026". */
function day(iso) {
  const [y, m, d] = iso.split("-");
  return +d + " " + MONTHS[m - 1] + " " + y;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const values = {
  asOf: day(data.asOf),

  /* usage, from `mcp-faster stats` */
  servers: fmt(totals.servers),
  sessions: fmt(totals.sessions),
  calls: fmt(totals.calls),
  drops: fmt(totals.drops),
  tokensShort: compact.format(totals.tokens),
  idleShare: pct(totals.idle / totals.sessions),
  idleSessions: fmt(totals.idle),
  connectShare: pct(totals.connect),
  failed: fmt(totals.failed),
  errorShare: pct(totals.errorRate),
  topIdleName: topIdle ? esc(topIdle.name) : "none",
  topIdleSessions: topIdle ? fmt(topIdle.sessions) : "0",
  logFiles: fmt(stats.logFiles),
  transcriptFiles: fmt(stats.transcriptFiles),

  /* benchmark, from `mcp-faster bench` */
  modelName: esc(bench.modelName),
  tasks: fmt(bench.tasks),
  runsPerTask: fmt(bench.runsPerTask),
  runsPerWay: fmt(bench.tasks * bench.runsPerTask),
  runs: fmt(bench.runs),
  benchCost: usd(bench.costUsd),
  codeCost: usd(way("code").costUsd),

  /* the local mirror next to all upfront */
  mirrorOk: fmt(mirror.ok),
  mirrorRuns: fmt(mirror.runs),
  mirrorSeconds: mirror.seconds.toFixed(1),
  mirrorCost: usd(mirror.costUsd),
  upfrontCost: usd(upfront.costUsd),
  costCut: pct(1 - mirror.costUsd / upfront.costUsd, 0),
  mirrorResult: fmt(mirror.resultTokens),
  upfrontResult: fmt(upfront.resultTokens),
  sizeRatio: fmt(Math.round(upfront.resultTokens / mirror.resultTokens)),
};

export function fillValues() {
  for (const el of $$("[data-v]")) {
    const name = el.dataset.v;
    if (!(name in values)) throw new Error(`index.html asks for data-v="${name}", which values.js does not have`);
    el.innerHTML = values[name];
  }
  /* a "Best" mark shows only next to the way that won */
  for (const el of $$("[data-best]")) el.hidden = el.dataset.best !== bench.best;
}
