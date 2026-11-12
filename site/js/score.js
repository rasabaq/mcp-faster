// "How the heat score works": four cards that stack as you scroll, and the list that follows them.
import data from "../data.js";
import { $, $$, pct, reduce } from "./util.js";

const { totals } = data.stats;

const PARTS = [
  { name: "Connects", text: "How often a server starts when the agent asks for it.", formula: "sessions ÷ (sessions + failed connects)", share: totals.connect, label: "of connects worked, all servers" },
  { name: "Stays up", text: "How many sessions end without the connection dropping.", formula: "1 − drops ÷ sessions", share: totals.stay, label: "of sessions kept the connection" },
  { name: "Gets used", text: "Half for tool calls (1,000 counts as full), half for sessions that were not idle. Never below 12%.", formula: "12% + 88% × usage", share: totals.active, label: "of sessions called a tool" },
  { name: "Few errors", text: "How many tool calls work.", formula: "1 − tool error rate", share: 1 - totals.errorRate, label: "of tool calls worked" },
];
const CARD_GAP = 24;   /* the gap between cards, --s5 in styles.css */

let cards = [], stepButtons = [], onScreen = false;

export function initScore() {
  $("#pcards").innerHTML = PARTS.map((part, i) =>
    '<article class="pcard" data-i="' + i + '"><div class="pc-top"><span class="pc-tag">Part ' + (i + 1) + '</span><span class="pc-no">0' + (i + 1) + " / 0" + PARTS.length + "</span></div>" +
    '<div class="pc-big"><b>' + pct(part.share, 1) + "<small>%</small></b><span>" + part.label + '</span><div class="pc-meter"><i style="width:' + (part.share * 100).toFixed(1) + '%"></i></div></div>' +
    '<div class="pc-body"><h3>' + part.name + "</h3><p>" + part.text + "</p><code>" + part.formula + "</code></div></article>").join("");
  cards = $$(".pcard");
  stepButtons = $$("#steps button");

  $("#steps").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    const index = +button.dataset.card, stickyTop = parseFloat(getComputedStyle(cards[index]).top) || 0;
    /* a sticky card's own offset moves; use its place in the column instead */
    let y = $("#pcards").getBoundingClientRect().top + scrollY;
    for (let i = 0; i < index; i++) y += cards[i].offsetHeight + CARD_GAP;
    scrollTo({ top: Math.max(0, y - stickyTop), behavior: reduce ? "auto" : "smooth" });
  });

  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe($("#score"));
}

/** Marks the step of the card on top of the stack. Runs every frame, so it does nothing while the section is off screen. */
export function updateSteps(navHeight) {
  if (!onScreen) return;
  let active = 0;
  cards.forEach((card, i) => { if (card.getBoundingClientRect().top <= navHeight + 120 + i * 14) active = i; });
  stepButtons.forEach((button, i) => button.setAttribute("aria-current", i === active ? "true" : "false"));
}
