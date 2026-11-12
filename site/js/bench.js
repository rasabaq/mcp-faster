// The benchmark table: one row per way, sortable by any column.
// On a phone the rows turn into cards and a select does the sorting.
import { $, esc, fmt, usd } from "./util.js";
import { values } from "./values.js";
import { ways } from "./ways.js";

const CHEVRON = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>';
const COST_LABEL = "Cost, " + values.runsPerWay + " runs";

/** `key` is the field of a way to sort by. `asc` marks columns where a low number is good, so they sort low to high first. */
const COLUMNS = [
  { key: "name", label: "Way", asc: true },
  { key: "ok", label: "Right answers" },
  { key: "defTokens", label: "Read first", asc: true },
  { key: "resultTokens", label: "Result size", asc: true },
  { key: "seconds", label: "Median time", asc: true },
  { key: "calls", label: "Tool calls", asc: true, cls: "xs-hide" },
  { key: "costUsd", label: COST_LABEL, asc: true },
];

const highest = (key) => Math.max(...ways.map((w) => w[key]));
const HIGHEST = { defTokens: highest("defTokens"), resultTokens: highest("resultTokens"), seconds: highest("seconds"), costUsd: highest("costUsd") };

/** One dot per run, in two rows: filled for a right answer, a ring for a wrong one. */
function dots(ok, runs) {
  const perRow = Math.ceil(runs / 2), gap = 79.2 / Math.max(1, perRow - 1);
  let svg = '<svg viewBox="0 0 84 16" aria-hidden="true">';
  for (let i = 0; i < runs; i++) {
    const x = (1.5 + (i % perRow) * gap).toFixed(1), y = 4 + Math.floor(i / perRow) * 8;
    svg += i < ok
      ? '<circle cx="' + x + '" cy="' + y + '" r="1.25" fill="#f5f3ef"/>'
      : '<circle cx="' + x + '" cy="' + y + '" r="1.2" fill="none" stroke="#ff964e" stroke-width=".8"/>';
  }
  return svg + "</svg>";
}

/** A number with a small bar that shows it against the highest in its column. */
function bar(way, key, text) {
  return '<span class="cellbar"><span class="mbar' + (way.best && key !== "defTokens" ? " am" : "") + '"><i style="width:' +
    (way[key] / HIGHEST[key] * 100).toFixed(1) + '%"></i></span><span>' + text + "</span></span>";
}

function rowHtml(way) {
  return "<tr" + (way.best ? ' class="win"' : "") + ">" +
    '<td class="name"><span class="wayname"><span class="t">' + esc(way.name) + (way.best ? ' <span class="best">Best</span>' : "") + "</span><small>" + esc(way.desc) + "</small></span></td>" +
    '<td data-l="Right answers" class="wide' + (way.best ? " strong" : "") + '"><span class="okdots">' + dots(way.ok, way.runs) + "<span>" + way.ok + "/" + way.runs + "</span></span></td>" +
    '<td data-l="Read first">' + bar(way, "defTokens", fmt(way.defTokens) + " tok") + "</td>" +
    '<td data-l="Result size">' + bar(way, "resultTokens", fmt(way.resultTokens) + " tok") + "</td>" +
    '<td data-l="Median time">' + bar(way, "seconds", way.seconds.toFixed(1) + " s") + "</td>" +
    '<td data-l="Tool calls" class="xs-hide">' + way.calls + "</td>" +
    '<td data-l="' + COST_LABEL + '">' + bar(way, "costUsd", usd(way.costUsd)) + "</td></tr>";
}

export function initBench() {
  const table = $("#tBench"), select = $("#bnSort");
  let key = "costUsd", direction = 1;   /* 1 sorts low to high, -1 high to low */

  const column = (k) => COLUMNS.find((c) => c.key === k);
  const firstDirection = (k) => (column(k).asc ? 1 : -1);
  const headHtml = () => "<thead><tr>" + COLUMNS.map((c) =>
    '<th scope="col"' + (c.cls ? ' class="' + c.cls + '"' : "") + (c.key === key ? ' aria-sort="' + (direction > 0 ? "ascending" : "descending") + '"' : "") +
    '><button class="sb" type="button" data-k="' + c.key + '">' + c.label + CHEVRON + "</button></th>").join("") + "</tr></thead>";
  function render() {
    const list = [...ways].sort((a, b) => {
      const x = a[key], y = b[key];
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * direction;
    });
    table.innerHTML = headHtml() + "<tbody>" + list.map(rowHtml).join("") + "</tbody>";
    select.value = key;
  }

  select.innerHTML = COLUMNS.map((c) => '<option value="' + c.key + '">' + c.label + "</option>").join("");
  table.addEventListener("click", (e) => {
    const button = e.target.closest(".sb");
    if (!button) return;
    const k = button.dataset.k;
    direction = k === key ? -direction : firstDirection(k);
    key = k;
    render();
    /* the table was rebuilt: put the focus back on the same column */
    table.querySelector('.sb[data-k="' + k + '"]')?.focus();
  });
  select.addEventListener("change", () => { key = select.value; direction = firstDirection(key); render(); });
  render();
}
