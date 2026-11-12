// The servers section: the 8 big numbers, one heat tile per server, the filters,
// and the drawer that explains a server's score.
import data from "../data.js";
import { $, $$, clamp, esc, fmt, FROZEN, pct, plural, reduce, smooth } from "./util.js";
import { addSurface, heatScore, removeSurface, tileFn } from "./heat.js";

const { servers, totals } = data.stats;

/** The health labels. The rules match the `state` field that the data script writes. */
const STATE = {
  healthy: { label: "Healthy", long: "Healthy", color: "var(--s-healthy)", rule: "None of the problems above." },
  errors: { label: "Errors", long: "Tool errors", color: "var(--s-errors)", rule: "More than 10% of tool calls fail." },
  idle: { label: "Idle", long: "Mostly idle", color: "var(--s-idle)", rule: "No tool calls, or over 90% of sessions idle and under 500 calls." },
  drops: { label: "Drops", long: "Drops often", color: "var(--s-drops)", rule: "More than 20% of sessions drop." },
  fails: { label: "Fails", long: "Fails to connect", color: "var(--s-fails)", rule: "More than 20% of connect tries fail." },
};
/** The order the rules are checked in: the first one that fits is the server's label. */
const CHECK_ORDER = ["fails", "drops", "idle", "errors", "healthy"];
const CHIP_ORDER = ["healthy", "errors", "idle", "drops", "fails"];

const byHeat = [...servers].sort((a, b) => b.heat - a.heat);
const countOf = (state) => servers.filter((s) => s.state === state).length;
const pill = (state) => '<span class="pill" style="--c:' + STATE[state].color + '"><i></i>' + STATE[state].long + "</span>";
const ms = (n) => (n == null ? "–" : n >= 1000 ? (n / 1000).toFixed(1) + " s" : n + " ms");
const duration = (n) => (n >= 60000 ? (n / 60000).toFixed(1) + " min" : ms(n));

/** The line under a tile's label: it follows the sort, so the tile shows the number it is sorted by. */
const TILE_NOTE = {
  heat: (s) => (s.calls ? plural(s.calls, "call") : s.sessions ? plural(s.sessions, "session") : "no activity"),
  sessions: (s) => plural(s.sessions, "session"),
  calls: (s) => plural(s.calls, "call"),
  failed: (s) => fmt(s.failed) + " failed",
  drops: (s) => plural(s.drops, "drop"),
  tokens: (s) => fmt(s.tokens) + " tokens",
  name: (s) => (s.calls ? plural(s.calls, "call") : plural(s.sessions, "session")),
};

const view = { filter: "all", search: "", sort: "heat" };
let tiles = [];
/** The tiles that pass the filters, in the order on screen. The drawer steps through this list. */
let shown = [];

/* ================= the 8 big numbers ================= */
function renderNumbers() {
  const hottest = byHeat[0];
  $("#kgrid").innerHTML = [
    ["MCP servers", fmt(totals.servers), countOf("healthy") + " healthy"],
    ["Sessions", fmt(totals.sessions), fmt(totals.idle) + " never called a tool (" + pct(totals.idle / totals.sessions) + "%)"],
    ["Connects that worked", pct(totals.connect, 1) + "<small>%</small>", fmt(totals.failed) + " failed connects"],
    ["Dropped connections", fmt(totals.drops), "sessions cut off"],
    ["Tool calls", fmt(totals.calls), pct(totals.errorRate, 1) + "% of them failed"],
    ["Tokens of tool results", fmt(totals.tokens), "sent back into the context"],
    ["Time connecting and calling", (totals.totalMs / 3.6e6).toFixed(1) + "<small>h</small>", "across all servers"],
    ["Hottest server", heatScore(hottest) + "<small>/100</small>", esc(hottest.name) + ", " + plural(hottest.calls, "call")],
  ].map(([label, value, note]) => "<div><dt>" + label + "</dt><dd>" + value + '<span class="sub">' + note + "</span></dd></div>").join("");
}

/* ================= tiles and filters ================= */
function makeTile(server, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tile";
  button.setAttribute("aria-label", server.name + ", heat " + heatScore(server) + ", " + STATE[server.state].long + ". Open details.");
  button.innerHTML = '<canvas aria-hidden="true"></canvas><span class="tile-b"><span class="tile-r"><span class="tile-n"></span><span class="tile-h">' +
    heatScore(server) + '</span></span><span class="tile-r">' + pill(server.state) + '<span class="tile-m"></span></span></span>';
  button.querySelector(".tile-n").textContent = server.name;
  const tile = { button, server, seen: 0 };
  /* the tile warms up from 40% of its heat to its real heat when it first shows */
  const warm = () => (reduce || FROZEN ? 1 : .4 + .6 * smooth(0, 1.4, (performance.now() - (tile.seen || performance.now())) / 1000));
  tile.surface = addSurface(button.querySelector("canvas"), tileFn(server.heat, index * 1.7, warm));
  button.addEventListener("click", () => openDetail(tile));
  return tile;
}

function render() {
  const search = view.search.trim().toLowerCase(), key = view.sort;
  const list = [...tiles].sort((a, b) =>
    key === "name" ? a.server.name.localeCompare(b.server.name, "en", { sensitivity: "base" })
    : key === "heat" ? b.server.heat - a.server.heat
    : b.server[key] - a.server[key] || b.server.heat - a.server.heat);
  shown = [];
  const grid = $("#grid");
  for (const tile of list) {
    const ok = (view.filter === "all" || tile.server.state === view.filter) && (!search || tile.server.name.toLowerCase().includes(search));
    tile.button.hidden = !ok;
    if (ok) shown.push(tile);
    tile.button.querySelector(".tile-m").textContent = TILE_NOTE[key](tile.server);
    grid.appendChild(tile.button);
  }
  const state = STATE[view.filter];
  $("#count").innerHTML = "Showing <b>" + shown.length + "</b> of " + tiles.length + " servers" +
    (state ? " · " + state.long.toLowerCase() : "") + (search ? " · matching “" + esc(view.search.trim()) + "”" : "");
  $("#empty").classList.toggle("show", !shown.length);
  $("#emptyTxt").textContent = search
    ? "Nothing called “" + view.search.trim() + "”" + (state ? " in " + state.label : "") + ". Try another name, or clear the filters."
    : "Try another filter.";
  $$(".chip").forEach((chip) => chip.setAttribute("aria-pressed", chip.dataset.f === view.filter));
  /* a tile that was hidden has no size yet; fit its canvas once it is laid out */
  requestAnimationFrame(() => tiles.forEach((tile) => tile.button.hidden || tile.surface.resize()));
}

/* ================= detail drawer ================= */
let current = null, lastFocus = null, drawerSurface = null;
const isOpen = () => document.body.classList.contains("open");

function openDetail(tile) {
  if (!isOpen()) lastFocus = document.activeElement;
  current = tile;
  tiles.forEach((t) => t.button.classList.toggle("on", t === tile));
  const s = tile.server;
  const tries = s.sessions + s.failed, idleShare = s.sessions ? s.idle / s.sessions : 0, errorRate = s.errorRate ?? 0;
  $("#dPill").innerHTML = pill(s.state);
  $("#dTitle").textContent = s.name;
  $("#dHint").textContent = {
    healthy: "Connects, stays up and gets used.",
    fails: pct(1 - s.connect) + "% of connect tries failed.",
    drops: pct(1 - s.stay) + "% of sessions dropped.",
    idle: s.calls ? pct(idleShare) + "% of sessions made no tool call." : "No tool calls in any session.",
    errors: pct(errorRate, 1) + "% of tool calls failed.",
  }[s.state];
  /* a server that only shows up in chat records has no connect logs */
  const noLogs = !tries, row = (label, value) => "<div><dt>" + label + "</dt><dd>" + value + "</dd></div>";
  const parts = [
    ["Connects", s.connect, noLogs ? "No connect logs, counted as 100%" : fmt(s.sessions) + " of " + fmt(tries) + " tries worked"],
    ["Stays up", s.stay, noLogs ? "No connect logs, counted as 100%" : plural(s.drops, "drop") + " in " + plural(s.sessions, "session")],
    ["Gets used", s.used, plural(s.calls, "tool call") + " · " + (s.sessions ? pct(1 - idleShare) + "% of sessions active" : "no session logs")],
    ["Few errors", s.clean, s.calls ? pct(errorRate, 1) + "% of " + plural(s.calls, "call") + " failed" : "No tool calls, counted as 100%"],
  ];
  $("#dBody").innerHTML =
    '<div class="d-score"><canvas aria-hidden="true"></canvas><div><b>' + heatScore(s) + "<small>/100</small></b><span>Heat score · rank " + (byHeat.indexOf(s) + 1) + " of " + servers.length + "</span></div></div>" +
    '<p class="d-h">How the score is built</p><div class="br">' +
    parts.map(([label, share, note]) => '<div class="br-r"><b>' + label + "</b><em>" + pct(share) + '%</em><div class="meter"><i style="transform:scaleX(' + clamp(share) + ')"></i></div><small>' + note + "</small></div>").join("") +
    '</div><p class="eq">' + parts.map((part) => pct(part[1]) + "%").join(" × ") + " = <b>" + heatScore(s) + "</b></p>" +
    '<p class="d-h">Numbers</p><dl class="kv">' +
    row("Sessions", s.sessions ? fmt(s.sessions) + " <small>· " + fmt(s.idle) + " idle</small>" : "<small>no connect logs</small>") +
    row("Connect time", s.connectP50 == null ? "<small>no data</small>" : ms(s.connectP50) + " <small>usual · " + ms(s.connectP90) + " slow</small>") +
    row("Failed connects", s.failed ? fmt(s.failed) + " <small>of " + fmt(tries) + " tries</small>" : "0") +
    row("Drops", fmt(s.drops)) +
    row("Tool calls", s.calls ? fmt(s.calls) + " <small>· " + pct(errorRate, 1) + "% failed</small>" : "0") +
    row("Result tokens", fmt(s.tokens)) +
    row("Total wait", s.totalMs ? duration(s.totalMs) : "0") +
    '</dl><p class="d-h">Most used tools' + (s.toolsUsed ? " · " + s.toolsUsed + " in use" : "") + "</p>" +
    (s.custom ? '<p class="muted">Tool names are hidden for custom servers.</p>'
      : s.tools.length ? '<div class="tools">' + s.tools.map((tool) => "<div><code>" + esc(tool.name) + "</code><span>" + plural(tool.calls, "call") + "</span><span>" + ms(tool.p50Ms) + "</span></div>").join("") + "</div>"
      : '<p class="muted">No tool calls in the logs.</p>');
  if (drawerSurface) removeSurface(drawerSurface);
  drawerSurface = addSurface($("#dBody canvas"), tileFn(s.heat, 0, () => 1));
  const i = shown.indexOf(tile);
  $("#dPos").textContent = i < 0 ? "" : i + 1 + " of " + shown.length;
  $("#dPrev").disabled = i <= 0;
  $("#dNext").disabled = i < 0 || i >= shown.length - 1;
  /* a button that just turned off would drop the focus to the page: hand it to the other one */
  const focused = document.activeElement;
  if (focused?.disabled) { const other = focused === $("#dPrev") ? $("#dNext") : $("#dPrev"); (other.disabled ? $("#drawer") : other).focus(); }
  $("#dBody").scrollTop = 0;
  if (!isOpen()) {
    /* the page stops scrolling while the drawer is open; a scrollbar that takes room keeps it, so nothing moves */
    document.documentElement.style.scrollbarGutter = innerWidth > document.documentElement.clientWidth ? "stable" : "";
    document.body.classList.add("open");
    $("#drawer").focus({ preventScroll: true });
  }
  const surface = drawerSurface;
  requestAnimationFrame(() => { surface.resize(); surface.draw(performance.now() / 1000); });
}

function closeDetail() {
  if (!isOpen()) return;
  document.body.classList.remove("open");
  tiles.forEach((t) => t.button.classList.remove("on"));
  if (drawerSurface) { removeSurface(drawerSurface); drawerSurface = null; }
  current = null;
  if (lastFocus) lastFocus.focus({ preventScroll: true });
}

function step(by) {
  const next = shown[shown.indexOf(current) + by];
  if (current && next) openDetail(next);
}

function onKey(e) {
  if (!isOpen()) return;
  if (e.key === "Escape") closeDetail();
  else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (e.key === "Tab") {
    /* keep the focus inside the drawer */
    const drawer = $("#drawer"), buttons = [...drawer.querySelectorAll("button:not(:disabled)")], first = buttons[0], last = buttons[buttons.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === drawer)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }
}

/** Opens the drawer of the server with this name. Used by the ?open= preview link. */
export function openServer(name) {
  const tile = tiles.find((t) => t.server.name.toLowerCase() === name.toLowerCase());
  if (tile) openDetail(tile);
}

export function initServers() {
  renderNumbers();

  tiles = servers.map(makeTile);
  const seen = new IntersectionObserver((entries) => entries.forEach((e) => {
    const tile = e.isIntersecting && tiles.find((t) => t.button === e.target);
    if (tile && !tile.seen) tile.seen = performance.now();
  }));
  tiles.forEach((tile) => seen.observe(tile.button));

  $("#chips").innerHTML = '<button class="chip" type="button" data-f="all">All <span class="ct">' + tiles.length + "</span></button>" +
    CHIP_ORDER.map((state) => '<button class="chip" type="button" data-f="' + state + '"><i style="background:' + STATE[state].color + '"></i>' +
      STATE[state].label + ' <span class="ct">' + countOf(state) + "</span></button>").join("");
  $("#chips").addEventListener("click", (e) => { const chip = e.target.closest(".chip"); if (chip) { view.filter = chip.dataset.f; render(); } });
  $("#q").addEventListener("input", (e) => { view.search = e.target.value; render(); });
  $("#sort").addEventListener("change", (e) => { view.sort = e.target.value; render(); });
  $("#clear").addEventListener("click", () => { view.filter = "all"; view.search = ""; $("#q").value = ""; render(); });
  /* the FAQ explains the labels with the same pills */
  $("#rules").innerHTML = CHECK_ORDER.map((state) => "<li>" + pill(state) + "<span>" + STATE[state].rule + "</span></li>").join("");

  $("#dClose").addEventListener("click", closeDetail);
  $("#scrim").addEventListener("click", closeDetail);
  $("#dPrev").addEventListener("click", () => step(-1));
  $("#dNext").addEventListener("click", () => step(1));
  addEventListener("keydown", onKey);

  render();
}
