// Every number the page text shows. index.html marks a slot with data-v="name";
// fillValues() puts the value from the table below into each slot, once, at start.
// Rule: a value is a bare number (the unit and the words stay in index.html),
// except money, the date and names. Values are HTML, so names go through esc().
import data from "../data.js";
import { $$, esc, fmt, pct, plural, usd } from "./util.js";
import { way } from "./ways.js";

const { stats, bench } = data;
const { totals } = stats;
const mirror = way("mirror");
const upfront = way("upfront");

/** The 12 servers with the most sessions: the columns of chapter 2. */
export const columnServers = [...stats.servers].sort((a, b) => b.sessions - a.sessions).slice(0, 12);

/** Chapter 2: which of the 12 servers break the most. Empty when none of them drops or fails. */
function breakingSentence() {
  const name = (s) => "<b>" + esc(s.name) + "</b>";
  const dropping = columnServers.filter((s) => s.drops > 0).sort((a, b) => b.drops - a.drops).slice(0, 2);
  const failing = columnServers.filter((s) => s.failed > 0).sort((a, b) => b.failed - a.failed)[0];
  const parts = dropping.map((s, i) => name(s) + (i ? " " + fmt(s.drops) : " dropped " + plural(s.drops, "time")));
  if (failing) parts.push(name(failing) + " failed to connect " + plural(failing.failed, "time"));
  if (!parts.length) return "";
  const list = parts.length === 3 ? parts[0] + ", " + parts[1] + ", and " + parts[2] : parts.join(" and ");
  const count = new Set([...dropping, ...(failing ? [failing] : [])]).size;
  return (count === 1 ? " One keeps breaking: " : " A few keep breaking: ") + list + ".";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-03-09" to "9 Mar 2026". */
function day(iso) {
  const [y, m, d] = iso.split("-");
  return +d + " " + MONTHS[m - 1] + " " + y;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const okCounts = bench.ways.map((w) => w.ok);
const okLow = Math.min(...okCounts);
const okHigh = Math.max(...okCounts);
const okGain = mirror.ok - upfront.ok;

export const values = {
  asOf: day(data.asOf),

  /* usage, from `mcp-faster stats` */
  servers: fmt(totals.servers),
  sessions: fmt(totals.sessions),
  calls: fmt(totals.calls),
  drops: fmt(totals.drops),
  tokensShort: compact.format(totals.tokens),
  hours: (totals.totalMs / 3.6e6).toFixed(1),
  idleShare: pct(totals.idle / totals.sessions),
  connectShare: pct(totals.connect, 1),   /* one decimal, as in the numbers grid and the heat score */
  logFiles: fmt(stats.logFiles),
  transcriptFiles: fmt(stats.transcriptFiles),
  breaking: breakingSentence(),

  /* benchmark, from `mcp-faster bench` */
  modelName: esc(bench.modelName),
  tasks: fmt(bench.tasks),
  runsPerTask: fmt(bench.runsPerTask),
  runsPerWay: fmt(bench.tasks * bench.runsPerTask),
  runs: fmt(bench.runs),
  benchCost: usd(bench.costUsd),
  okRange: okLow === okHigh ? String(okLow) : okLow + "–" + okHigh,
  upfrontDef: fmt(upfront.defTokens),
  searchDef: fmt(way("search").defTokens),
  codeCost: usd(way("code").costUsd),

  /* the local mirror next to all upfront */
  mirrorOk: fmt(mirror.ok),
  mirrorRuns: fmt(mirror.runs),
  upfrontOk: fmt(upfront.ok),
  upfrontRuns: fmt(upfront.runs),
  okGain: (okGain < 0 ? "−" : "+") + Math.abs(okGain),
  mirrorSeconds: mirror.seconds.toFixed(1),
  upfrontSeconds: upfront.seconds.toFixed(1),
  secondsSaved: (upfront.seconds - mirror.seconds).toFixed(1),
  mirrorCost: usd(mirror.costUsd),
  upfrontCost: usd(upfront.costUsd),
  costCut: pct(1 - mirror.costUsd / upfront.costUsd, 0),
  costShare: pct(mirror.costUsd / upfront.costUsd),
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
