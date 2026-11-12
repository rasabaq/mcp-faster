// The servers section: one tile per server with its logo and heat, the label filters,
// and the warm-up that fills each tile the first time it shows.
import data from "../data.js";
import { $, $$, esc, FROZEN, plural, reduce } from "./util.js";
import { heatCss, heatScore } from "./heat.js";
import { logoHtml } from "./logos.js";

const { servers } = data.stats;

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

const countOf = (state) => servers.filter((s) => s.state === state).length;
const pill = (state) => '<span class="pill" style="--c:' + STATE[state].color + '"><i></i>' + STATE[state].long + "</span>";
const note = (s) => (s.calls ? plural(s.calls, "call") : s.sessions ? plural(s.sessions, "session") : "no activity");

function tile(s) {
  const score = heatScore(s);
  return '<div class="tile" data-s="' + s.state + '" style="--hc:' + heatCss(s.heat) + '" title="' + esc(s.name) + ": heat " + score + '">' +
    logoHtml(s) + '<span class="nm">' + esc(s.name) + '</span><span class="ht">' + score + '</span><span class="sub">' + pill(s.state) +
    "<span>" + note(s) + '</span></span><span class="heat" style="width:' + Math.max(3, score) + '%"></span></div>';
}

/** Counts a tile's score up from 0 over 1.1 s, fast at first and slow at the end. */
function countUp(el) {
  const to = +el.textContent, t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 1100);
    el.textContent = String(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = "0";
  requestAnimationFrame(step);
}

/** Fills the filter chips and the server tiles, and the label rules in the FAQ. */
export function initServers() {
  const byHeat = [...servers].sort((a, b) => b.heat - a.heat);
  $("#chips").innerHTML = '<button class="chip" type="button" data-f="all" aria-pressed="true">All <b>' + servers.length + "</b></button>" +
    CHIP_ORDER.filter(countOf).map((state) => '<button class="chip" type="button" data-f="' + state + '" aria-pressed="false" style="--c:' +
      STATE[state].color + '"><i></i>' + STATE[state].long + " <b>" + countOf(state) + "</b></button>").join("");
  $("#grid").innerHTML = byHeat.map(tile).join("");
  const tiles = $$("#grid .tile");

  $("#chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    $$("#chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    tiles.forEach((t) => (t.hidden = chip.dataset.f !== "all" && t.dataset.s !== chip.dataset.f));
  });

  /* each tile warms up once, the first time it is well on screen */
  if (reduce || FROZEN) tiles.forEach((t) => t.classList.add("on"));
  else {
    const warm = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("on");
      countUp(e.target.querySelector(".ht"));
      warm.unobserve(e.target);
    }), { rootMargin: "0px 0px -10% 0px", threshold: 0.1 });
    tiles.forEach((t) => warm.observe(t));
  }

  /* the FAQ explains the labels with the same pills */
  const rules = $("#rules");
  if (rules) rules.innerHTML = CHECK_ORDER.map((state) => "<li>" + pill(state) + "<span>" + STATE[state].rule + "</span></li>").join("");
}
