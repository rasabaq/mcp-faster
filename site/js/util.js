// Small helpers and the URL flags that every part of the page shares.

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* ---------- number formats ---------- */
export const fmt = (n) => n.toLocaleString("en-US");
export const usd = (n) => "$" + n.toFixed(2);
/** "1 call", "2 calls". */
export const plural = (n, word) => fmt(n) + " " + word + (n === 1 ? "" : "s");
/** A share from 0 to 1 as a percentage, without the sign. Shares under 10% keep one decimal. */
export const pct = (share, digits) => (share * 100).toFixed(digits ?? (share > 0 && share < 0.1 ? 1 : 0));

/* ---------- URL flags ----------
   Preview links, used for screenshots, because a headless browser does not paint after a scroll:
   ?p=1.5 freezes the story at that point, ?at=servers opens at a section,
   ?open=Slack opens a drawer, ?menu opens the mobile menu. */
export const query = new URLSearchParams(location.search);
const point = query.get("p");
/** The story point from ?p=, or null when the story follows the scroll. */
export const forced = point != null && point !== "" ? clamp(+point, 0, 3) : null;
/** True when a preview link asks for a still page: nothing animates. */
export const FROZEN = forced != null || query.has("at") || query.has("open");
export const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Canvas pixels per CSS pixel. Capped at 2 to keep the canvases cheap. */
export const dprMax = () => Math.min(window.devicePixelRatio || 1, 2);
