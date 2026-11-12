// Getting around the page: scrolling to a section, the phone menu,
// the current link in the nav bar and the progress line under it.
import { $, $$, clamp, forced, query, reduce } from "./util.js";
import { navHeight, storyScrollTop, viewHeight } from "./story.js";

const nav = $("#nav"), menuButton = $("#menuBtn"), bar = $("#bar");
const navLinks = $$(".links a");
const SECTION_IDS = ["story", "features", "servers", "score", "bench", "faq"];
/** Where each section sits on the page. Cached, because updateNav() runs every frame. */
let sections = [];

export function measureSections() {
  sections = SECTION_IDS.map((id) => {
    const el = document.getElementById(id);
    return { id, top: el.getBoundingClientRect().top + scrollY, height: el.offsetHeight };
  });
}

/** Opens or closes the phone menu, and keeps the button's icon and label in step. */
function setMenu(open) {
  nav.classList.toggle("menu-open", open);
  menuButton.setAttribute("aria-expanded", open);
  menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  menuButton.querySelector("use").setAttribute("href", open ? "#i-x" : "#i-menu");
}

/** Scrolls to "top", to a chapter of the story ("0" to "3"), or to the element with this id.
    The position is computed, not a #hash jump, so it also works inside an iframe. */
function go(where) {
  let y;
  if (where === "top") y = 0;
  else if (/^[0-3]$/.test(where)) y = storyScrollTop(+where);
  else if (where === "story") y = storyScrollTop();
  else {
    const el = document.getElementById(where);
    y = el.getBoundingClientRect().top + scrollY - navHeight + (el.classList.contains("sec") ? 64 : 0);
  }
  scrollTo({ top: Math.max(0, Math.round(y)), behavior: reduce ? "auto" : "smooth" });
  setMenu(false);
  /* move the keyboard focus too, so the next Tab starts in the new section */
  const heading = document.getElementById(where)?.querySelector("h2");
  if (heading && where !== "story") { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
}

/** Every frame: marks the link of the section on screen and moves the progress line. */
export function updateNav() {
  const y = scrollY, probe = y + navHeight + viewHeight * .35;
  let current = null;
  for (const s of sections) if (probe >= s.top && probe < s.top + s.height) current = s.id;
  if (current === "score") current = "servers";   /* the heat score has no link of its own */
  navLinks.forEach((link) => link.setAttribute("aria-current", link.dataset.go === current ? "true" : "false"));
  const max = document.documentElement.scrollHeight - innerHeight;
  bar.style.transform = "scaleX(" + (max > 0 ? clamp(y / max) : 0).toFixed(4) + ")";
}

export function initNav() {
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-go]");
    if (!target) return;
    e.preventDefault();
    go(target.dataset.go);
  });
  menuButton.addEventListener("click", () => setMenu(!nav.classList.contains("menu-open")));
  /* with the menu open, a tap outside it only closes it; it does not reach what is under it */
  document.addEventListener("click", (e) => {
    if (!nav.classList.contains("menu-open") || nav.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu(false);
  }, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("menu-open")) { setMenu(false); menuButton.focus(); }
  });

  /* Preview links (see util.js). They hide what is above instead of scrolling. */
  if (query.has("menu")) menuButton.click();
  const at = query.get("at"), section = at && document.getElementById(at), from = forced != null ? $("#story") : section;
  if (from) for (let el = from.previousElementSibling; el; el = el.previousElementSibling) el.style.display = "none";
  if (at === "footer") $("#main").style.display = "none";
  if (from && from.classList.contains("sec")) from.style.paddingTop = "72px";
}
