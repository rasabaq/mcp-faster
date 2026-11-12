// Entry point: starts each part of the page in order, and runs the one animation loop.
import { $, FROZEN, query, reduce } from "./util.js";
import { fillValues } from "./values.js";
import { buildAtlas, drawSurfaces, refreshSurfaces } from "./heat.js";
import { initCopy } from "./copy.js";
import { initFeatures } from "./features.js";
import { initServers, openServer } from "./servers.js";
import { initScore, updateSteps } from "./score.js";
import { initBench } from "./bench.js";
import { buildStory, frameStory, measureStory, navHeight } from "./story.js";
import { initNav, measureSections, updateNav } from "./nav.js";

if (FROZEN) document.documentElement.classList.add("frozen");

function measure() {
  measureStory();
  measureSections();
}
function frame(now, snap) {
  frameStory(now, snap);
  updateNav();
  updateSteps(navHeight);
}
/** Lays the story out for the window size, then draws one frame at the scroll position. */
function layout() {
  if (!buildStory()) return;
  measure();
  frame(undefined, true);
}
function loop(now) {
  frame(now, false);
  if (!reduce) drawSurfaces(now / 1000);
  requestAnimationFrame(loop);
}

fillValues();
initCopy();
initFeatures();
initServers();
initScore();
initBench();
initNav();

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    buildAtlas();   /* a browser zoom changes the pixel ratio, and the glyphs are drawn for one ratio */
    layout();
    refreshSurfaces(false);
  }, 120);
});
/* anything that changes the height of the page (filters, an open FAQ answer) moves the sections */
new ResizeObserver(measure).observe($("#main"));

layout();
/* the canvases draw text, so the real start waits for the fonts */
(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
  buildAtlas();
  layout();
  refreshSurfaces(true);
  const name = query.get("open");
  if (name) openServer(name);
  requestAnimationFrame(loop);
});
