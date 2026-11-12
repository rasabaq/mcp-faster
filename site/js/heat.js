// The heat look: the colour ramps, and the glyph surfaces (small canvases filled with
// coloured characters) behind the server tiles, the orange card and the last call to action.
import { clamp, dprMax, FROZEN, reduce, smooth } from "./util.js";

/** The 0 to 100 score shown for a server. */
export const heatScore = (server) => Math.round(server.heat * 100);

/* ================= palettes ================= */
function ramp(stops, v) {
  v = clamp(v);
  for (let i = 1; i < stops.length; i++)
    if (v <= stops[i][0]) {
      const [a, A] = stops[i - 1], [b, B] = stops[i], t = (v - a) / (b - a);
      return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    }
  return stops[stops.length - 1][1];
}
/* dots sit on a dark window, so the cold end stays a bright blue */
const DOT_STOPS = [[0, [58, 78, 236]], [.22, [118, 64, 220]], [.42, [196, 52, 168]], [.6, [255, 62, 88]], [.8, [255, 150, 78]], [1, [255, 240, 212]]];
/* glyph surfaces fill their own box, so the cold end can go deep */
const SURFACE_STOPS = [[0, [12, 16, 64]], [.2, [40, 58, 214]], [.4, [192, 42, 156]], [.6, [255, 59, 74]], [.8, [255, 154, 74]], [1, [255, 243, 214]]];

/** The dot ramp as 256 RGB triples, for the story canvas. */
export const LUT = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const c = ramp(DOT_STOPS, i / 255);
  LUT[i * 3] = c[0]; LUT[i * 3 + 1] = c[1]; LUT[i * 3 + 2] = c[2];
}
/** The dot ramp as a CSS colour, for a heat from 0 to 1. */
export const heatCss = (v) => {
  const c = ramp(DOT_STOPS, v);
  return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")";
};

/* ================= glyph surfaces ================= */
/** The size of one glyph cell, in CSS pixels. */
export const CW = 10, CH = 16;
const CHARS = " .xXS0O#@", NCOL = 48;   /* the glyphs, and how many colour steps each one is drawn in */
const TIERS = [" ", ".", ".x", "xXS", "XS0O", "S0O#@", "0O#@"];
/** The time a surface is drawn at when the page stands still. */
const STILL = 4;

/* every glyph in every colour, drawn once; it needs the mono font, so build it when fonts are ready */
let atlas = null;
export function buildAtlas() {
  const d = dprMax();
  atlas = document.createElement("canvas"); atlas.width = CHARS.length * CW * d; atlas.height = NCOL * CH * d;
  const g = atlas.getContext("2d"); g.scale(d, d);
  g.font = "500 " + (CH * .7) + 'px "Geist Mono",ui-monospace,monospace'; g.textAlign = "center"; g.textBaseline = "middle";
  for (let c = 0; c < NCOL; c++) {
    const v = c / (NCOL - 1), p = ramp(SURFACE_STOPS, v), k = v > .8 ? [236, 128, 64] : [255, 255, 255], m = v > .8 ? .24 : .24 + .12 * (1 - v);
    g.fillStyle = "rgb(" + (p[0] + (k[0] - p[0]) * m | 0) + "," + (p[1] + (k[1] - p[1]) * m | 0) + "," + (p[2] + (k[2] - p[2]) * m | 0) + ")";
    for (let j = 1; j < CHARS.length; j++) g.fillText(CHARS[j], j * CW + CW / 2, c * CH + CH / 2 + .5);
  }
}
const ihash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

function surface(canvas, valueAt, fade) {
  const ctx = canvas.getContext("2d"), small = document.createElement("canvas"), sctx = small.getContext("2d");
  let cols = 0, rows = 0, img, hashes, vals, dpr = 1;
  return {
    canvas,
    vis: false,
    /** Fits the canvas to its box. Does nothing when the size did not change, so it is safe to call often. */
    resize() {
      const r = canvas.getBoundingClientRect(), W = Math.round(r.width), H = Math.round(r.height); if (!W || !H) return;
      const d = dprMax(), w = Math.round(W * d), h = Math.round(H * d);
      if (cols && d === dpr && canvas.width === w && canvas.height === h) return;
      dpr = d; canvas.width = w; canvas.height = h; cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
      small.width = cols; small.height = rows; img = sctx.createImageData(cols, rows);
      hashes = new Float32Array(cols * rows); vals = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) hashes[y * cols + x] = ihash(x, y);
    },
    draw(t) {
      if (!cols || !atlas) return;
      const d = img.data; let k = 0;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const v = clamp(valueAt(x / cols, y / rows, t, cols, rows)), p = ramp(SURFACE_STOPS, v); vals[y * cols + x] = v; d[k++] = p[0]; d[k++] = p[1]; d[k++] = p[2]; d[k++] = fade ? 255 * smooth(.04, .34, v) : 255; }
      sctx.putImageData(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(small, 0, 0, cols, rows, 0, 0, canvas.width, canvas.height);
      const gw = CW * dpr, gh = CH * dpr;
      for (let i = 0; i < cols * rows; i++) {
        const v = vals[i], tier = TIERS[Math.min(6, (v * 7) | 0)]; if (tier === " ") continue;
        const ci = CHARS.indexOf(tier[(hashes[i] * tier.length) | 0]);
        ctx.drawImage(atlas, ci * gw, Math.round(v * (NCOL - 1)) * gh, gw, gh, (i % cols) * gw, ((i / cols) | 0) * gh, gw, gh);
      }
    },
  };
}

const surfaces = [];
/* only surfaces on screen are drawn; on a still page each one is drawn once, when it shows */
const onScreen = new IntersectionObserver((entries) => entries.forEach((e) => {
  const s = surfaces.find((x) => x.canvas === e.target);
  if (s) { s.vis = e.isIntersecting; if (s.vis && (reduce || FROZEN)) s.draw(STILL); }
}));

/** Turns a canvas into a glyph surface. valueAt(u, v, t, cols, rows) gives the heat, 0 to 1, of each cell. */
export function addSurface(canvas, valueAt, fade) {
  const s = surface(canvas, valueAt, fade);
  surfaces.push(s); onScreen.observe(canvas);
  return s;
}
export function removeSurface(s) {
  surfaces.splice(surfaces.indexOf(s), 1); onScreen.unobserve(s.canvas);
}
/** Fits every surface to its box again, then draws them still: all of them, or only those on screen. */
export function refreshSurfaces(all) {
  surfaces.forEach((s) => s.resize());
  surfaces.forEach((s) => (all || s.vis) && s.draw(STILL));
}
/** One animation frame for the surfaces on screen. */
export function drawSurfaces(t) {
  for (const s of surfaces) if (s.vis) s.draw(t);
}

/** The heat field of a server tile: hot at the top left, with a slow wave. `warm` scales the heat, 0 to 1. */
export const tileFn = (heat, ph, warm) => (u, v, t) => { const h = heat * warm(), g = 1 - .55 * Math.hypot(u * .9 - .1, v * 1.1 - .05) / 1.1, w = .05 * Math.sin(5 * u + 3 * v + t * .9 + ph) + .04 * Math.sin(9 * v - t * .7 + ph * 2); return .07 + h * (.6 + .5 * g) + w * (.3 + h); };
