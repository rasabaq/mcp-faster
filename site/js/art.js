// The galloping horse drawn in glyphs. How dark a cell is picks the glyph, and its heat
// picks the colour. The mouse warms the cells near it.
import { COLS, FRAMES, ROWS } from "./horse-frames.js";
import { heatCss } from "./heat.js";
import { dprMax, FROZEN, reduce } from "./util.js";

/** The size of one glyph cell, in CSS pixels. */
const CW = 6, CH = 11;
const GLYPHS = " .·:;=+x*#";
const FONT = '500 9px "Geist Mono", ui-monospace, monospace';
const COLORS = [...Array(33)].map((_, i) => heatCss(i / 32));
/** The frame shown when the page stands still. */
const STILL = 3;

/** Draws the horse on a canvas, and gallops while it is on screen unless the page stands still. */
export function initArt(canvas) {
  const ctx = canvas.getContext("2d"), still = reduce || FROZEN;
  let frame = STILL, last = 0, mx = null, my = null, vis = false, dpr = 0, ready = false;

  function fit() {
    dpr = dprMax();
    canvas.width = COLS * CW * dpr; canvas.height = ROWS * CH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  }

  function draw() {
    ctx.clearRect(0, 0, COLS * CW, ROWS * CH);
    const f = FRAMES[frame];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const v = parseInt(f[y * COLS + x], 16) / 15;
      let w = 0;
      if (mx !== null) { const dx = (x / COLS - mx) * 2.7, dy = y / ROWS - my; w = Math.exp(-(dx * dx + dy * dy) / .025); }
      let g, h, a;
      if (v > .06) { g = GLYPHS[Math.min(9, 1 + Math.round(v * 8))]; h = .32 + .58 * v + .4 * w; a = 1; }
      else { if ((x * 7 + y * 13) % 5) continue; g = "."; h = .04 + .6 * w; a = .28 + .72 * w; } /* the faint dot grid */
      ctx.globalAlpha = a; ctx.fillStyle = COLORS[Math.min(32, Math.round(h * 32))];
      ctx.fillText(g, x * CW + CW / 2, y * CH + CH / 2);
    }
    ctx.globalAlpha = 1;
  }

  if (!FROZEN) {
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      mx = (e.clientX - r.left) / r.width; my = (e.clientY - r.top) / r.height;
      if (reduce && ready) draw();
    });
    canvas.addEventListener("pointerleave", () => { mx = null; if (reduce && ready) draw(); });
  }

  /* the canvas keeps its own size; only a new pixel ratio needs a re-fit */
  let timer = 0;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (ready && dprMax() !== dpr) { fit(); draw(); } }, 150);
  });

  /* about 14 frames a second, close to a real gallop; drawn only while on screen */
  new IntersectionObserver((es) => { vis = es[0].isIntersecting; }).observe(canvas);
  const tick = (now) => {
    if (vis && now - last > 70) { last = now; frame = (frame + 1) % FRAMES.length; draw(); }
    requestAnimationFrame(tick);
  };

  document.fonts.load(FONT).catch(() => {}).then(() => {
    ready = true; fit(); draw();
    if (!still) requestAnimationFrame(tick);
  });
}
