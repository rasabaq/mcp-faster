// The heat look: the colour ramp from cold blue to hot cream, and the 0 to 100 heat score.

/** The 0 to 100 score shown for a server. */
export const heatScore = (server) => Math.round(server.heat * 100);

/* the ramp sits on a dark page, so the cold end stays a bright blue */
const STOPS = [[0, [58, 78, 236]], [.22, [118, 64, 220]], [.42, [196, 52, 168]], [.6, [255, 62, 88]], [.8, [255, 150, 78]], [1, [255, 240, 212]]];

/** The ramp as a CSS colour, for a heat from 0 to 1. */
export function heatCss(v) {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  for (let i = 1; i < STOPS.length; i++) {
    const [b, B] = STOPS[i];
    if (v > b) continue;
    const [a, A] = STOPS[i - 1], t = (v - a) / (b - a);
    return "rgb(" + A.map((c, k) => Math.round(c + (B[k] - c) * t)).join(",") + ")";
  }
  return "rgb(255,240,212)";
}
