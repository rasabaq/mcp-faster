// The benchmark: a race of the four ways by median time, and a plain table of every number.
import { $, esc, fmt, usd, reduce, FROZEN } from "./util.js";
import { values } from "./values.js";
import { ways } from "./ways.js";

const slowest = Math.max(...ways.map((w) => w.seconds));
const seconds = (w) => w.seconds.toFixed(1) + " s";

function laneHtml(w) {
  return '<div class="lane' + (w.best ? " best" : "") + '" style="--d:' + w.seconds + '"><span>' + esc(w.name) +
    '</span><span class="t"><i style="width:' + (w.seconds / slowest * 100).toFixed(1) + '%"></i></span><span class="v">' + seconds(w) + "</span></div>";
}

function rowHtml(w) {
  return "<tr" + (w.best ? ' class="best"' : "") + '><th scope="row">' + esc(w.name) + "</th>" +
    "<td>" + w.ok + "/" + w.runs + "</td>" +
    "<td>" + seconds(w) + "</td>" +
    "<td>" + fmt(w.defTokens) + " tok</td>" +
    "<td>" + fmt(w.resultTokens) + " tok</td>" +
    "<td>" + w.calls + "</td>" +
    "<td>" + usd(w.costUsd) + "</td></tr>";
}

const HEADS = ["way", "right", "median time", "read first", "result size", "tool calls", "cost, " + values.runsPerWay + " runs"];

/** Fills the race and the table. The race runs the first time it is half on screen, and again on its button. */
export function initBench() {
  const race = $("#race");
  race.innerHTML = '<div class="race-h"><div><h3>median time per task</h3><p>each bar runs for its real time, at 2× speed.</p></div>' +
    '<button class="btn btn-line" type="button" id="raceBtn">run again</button></div>' + ways.map(laneHtml).join("");
  $("#tBench").innerHTML = "<thead><tr>" + HEADS.map((h) => '<th scope="col">' + h + "</th>").join("") + "</tr></thead>" +
    "<tbody>" + ways.map(rowHtml).join("") + "</tbody>";

  const button = $("#raceBtn");
  /* still page: without the run class the bars just show their final width.
     The button is removed, not hidden, because .btn sets display and would beat the hidden attribute. */
  if (reduce || FROZEN) {
    button.remove();
    return;
  }
  /* take the class off and force a reflow, so the animation starts again from zero */
  const run = () => {
    race.classList.remove("run");
    void race.offsetWidth;
    race.classList.add("run");
  };
  button.addEventListener("click", run);
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    run();
    seen.disconnect();
  }, { threshold: 0.5 });
  seen.observe(race);
}
