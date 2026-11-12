// The small mock screens inside the feature cards (the bento grid),
// and the glow floor under the last call to action.
import data from "../data.js";
import { $, esc, fmt, FROZEN, reduce, smooth, usd } from "./util.js";
import { addSurface, CH, CW, heatCss, heatScore } from "./heat.js";
import { ways } from "./ways.js";

export function initFeatures() {
  /* stats card: the 8 servers with the most tool calls */
  const top = [...data.stats.servers].sort((a, b) => b.calls - a.calls).slice(0, 8);
  $("#mrows").innerHTML = top.map((s) =>
    '<div class="mrow scan"><span>' + esc(s.name) + "</span><span>" + fmt(s.calls) + '</span><span class="xs">' + fmt(s.tokens) +
    '</span><span class="heat" style="color:' + heatCss(s.heat) + '"><i></i><b>' + heatScore(s) + "</b></span></div>").join("");

  /* bench card: one cost bar per way; the bars grow when the grid scrolls into view */
  const highest = Math.max(...ways.map((w) => w.costUsd));
  $("#mbars").insertAdjacentHTML("beforeend", ways.map((w) =>
    '<div class="brow' + (w.best ? " win" : "") + '"><span>' + esc(w.short ?? w.name) + '</span><span class="tr"><i style="--w:' +
    (w.costUsd / highest).toFixed(3) + '"></i></span><b>' + usd(w.costUsd) + "</b></div>").join(""));
  const bento = $("#bento");
  if (FROZEN || reduce) bento.classList.add("in");
  else new IntersectionObserver((entries, observer) => entries.forEach((e) => {
    if (e.isIntersecting) { bento.classList.add("in"); observer.disconnect(); }
  }), { rootMargin: "0px 0px -20% 0px" }).observe(bento);

  /* accent card: cream to orange, never dark, so dark text reads */
  addSurface($("#localCv"), (u, v, t) => {
    /* settles to exactly .80 (#ff9a4a) at the bottom, where the text sits on a matching fill */
    const k = 1 - smooth(0, .72, v), n = .035 * Math.sin(3 * u + 2 * v + .4 * t) + .03 * Math.sin(5 * v - .3 * t + 2 * u);
    return .8 + k * (.19 - .06 * u) + n * (1 - smooth(.3, .72, v));
  });
  /* the glow floor under the last call to action */
  addSurface($("#floorCv"), (u, v, t, cols, rows) => {
    const asp = cols * CW / (rows * CH), x = (u - .5) * asp, y = 1.18 - v;
    return 1.1 - Math.hypot(x * .42, y * 1.15) + .06 * Math.sin(2.2 * x + .3 * t + 1.4 * Math.sin(2 * y - .25 * t)) + .04 * Math.sin(3.7 * y - .33 * t);
  }, true);
}
