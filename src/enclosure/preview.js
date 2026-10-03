// Static SVG thumbnail of an enclosure artifact: plan (top) + front elevation,
// side by side. Used by the Artifacts panel; pure string output, no WASM.

import { normalize, layout, faceSize, resolveCutouts, cutoutPolys, roundedRectPoly, polyPath } from "./model.js";

export function enclosureSvg(data) {
  const doc = normalize(data);
  const L = layout(doc);
  const cuts = resolveCutouts(doc, L);
  const gap = Math.max(L.W, L.D) * 0.18;
  const views = ["top", "front"].map((f) => ({ f, ...faceSize(f, L) }));
  const W = views[0].w + gap + views[1].w, H = Math.max(views[0].h, views[1].h);
  const pad = W * 0.06;
  const ink = `fill="none" stroke="var(--text)" stroke-width="1" vector-effect="non-scaling-stroke"`;
  let x = 0, s = "";
  for (const v of views) {
    const y = H - v.h;                       // bottom-align the two drawings
    const body = v.f === "top" ? polyPath([roundedRectPoly(0, 0, v.w, v.h, L.radius)], v.h) : `M0 0H${v.w}V${v.h}H0Z`;
    s += `<g transform="translate(${x} ${y})"><path d="${body}" fill="var(--elevated)"/>`;
    if (v.f === "top") s += `<path d="${polyPath([roundedRectPoly(L.bx, L.by, L.board.w, L.board.d, L.board.r)], v.h)}" fill="var(--sage-soft)" stroke="var(--sage)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    else if (L.style !== "slide") s += `<line x1="0" x2="${v.w}" y1="${v.h - L.baseH}" y2="${v.h - L.baseH}" stroke="var(--text-muted)" vector-effect="non-scaling-stroke"/>`;
    for (const c of cuts) if (c.face === v.f) s += `<path d="${polyPath(cutoutPolys(c), v.h)}" fill="var(--text)" fill-opacity=".8"/>`;
    s += `<path d="${body}" ${ink}/></g>`;
    x += v.w + gap;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}" preserveAspectRatio="xMidYMid meet">${s}</svg>`;
}
