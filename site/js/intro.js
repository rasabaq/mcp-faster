// The opening: an orange screen counts to 100 and wipes up, then the headline lines slide in.
// It plays once per visit. It never plays for reduced motion or a still preview link.
import { FROZEN, reduce } from "./util.js";

const SEEN = "mcp-faster:intro";

/** True when this visit already saw the opening. Storage can be blocked, so a failure counts as not seen. */
function seen() {
  try {
    return sessionStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    sessionStorage.setItem(SEEN, "1");
  } catch {
    /* blocked storage only means the opening plays again next time */
  }
}

export function initIntro() {
  if (reduce || FROZEN || seen()) return;
  markSeen();
  const root = document.documentElement;
  const loader = document.createElement("div");
  loader.className = "loader";
  loader.setAttribute("aria-hidden", "true");
  loader.innerHTML = "<span>LOADING <b>000</b></span>";
  document.body.append(loader);
  const count = loader.querySelector("b");
  const start = Date.now();

  /* a timer, not requestAnimationFrame: a background tab throttles frames and would leave the page covered */
  const done = () => {
    clearInterval(tick);
    clearTimeout(hardStop);
    count.textContent = "100";
    loader.classList.add("out");
    root.classList.add("in");
    setTimeout(() => loader.remove(), 850);
  };
  const tick = setInterval(() => {
    const k = Math.min(1, (Date.now() - start) / 850);
    count.textContent = String(Math.round(k * 100)).padStart(3, "0");
    if (k >= 1) done();
  }, 30);
  const hardStop = setTimeout(done, 1400);
}
