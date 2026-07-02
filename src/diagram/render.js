// Shared diagram renderer.
//
// Builds a 1200×675 SVG for a `diagram` artifact + theme. Pure — no I/O. The
// returned <svg> carries a viewBox but no width/height, so it scales to its
// container everywhere (tool canvas, Artifacts preview, slide embeds);
// exporters add explicit dimensions when serializing. Text uses
// <foreignObject> so it wraps like HTML — fine in every browser context we
// render into; native SVG apps (Keynote, Figma import) won't show it.
//
// Used by the Diagram tool, the Slides tool (diagram refs in image slots),
// and the Artifacts panel preview.

import { colorScheme } from "../deck/render.js";

export const DW = 1200, DH = 675;

export const DIAGRAM_DEFAULT_THEME = {
  name: "Runes",
  fonts: { heading: { family: "Fraunces", weight: 600 }, body: { family: "Newsreader", weight: 400 } },
  colors: { bg: "#f7f5f0", surface: "#efece5", text: "#2a2a28", muted: "#6e6154", accent: "#a85a4a", accent2: "#3f5e5a" },
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Interpolate two #rrggbb colors (t = share of b). SVG has no color-mix().
export function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  return "#" + [16, 8, 0].map((sh) =>
    Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t).toString(16).padStart(2, "0")).join("");
}

// ---------- Templates ----------
export const TEMPLATES = {
  "flow":      { name: "Flow" },
  "compare":   { name: "Compare" },
  "matrix":    { name: "2×2 Matrix" },
  "venn":      { name: "Venn" },
  "timeline":  { name: "Timeline" },
  "hierarchy": { name: "Hierarchy" },
};

// Starter data for a new diagram of each template (also used for template
// previews in the tool). This is the contract Claude follows — mirrored in
// the studio-artifacts skill.
export const TEMPLATE_DEFAULTS = {
  "flow": {
    direction: "right",
    nodes: [
      { id: "a", label: "Research", detail: "Interviews, field notes" },
      { id: "b", label: "Synthesize", detail: "Patterns & insights" },
      { id: "c", label: "Prototype", detail: "Low fidelity first" },
      { id: "d", label: "Test", detail: "With real users" },
    ],
    links: [ { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "d", to: "c", label: "iterate" } ],
  },
  "compare": {
    items: [
      { title: "Option A", points: ["First quality", "Second quality", "Third quality"] },
      { title: "Option B", points: ["First quality", "Second quality", "Third quality"] },
    ],
  },
  "matrix": {
    x: { low: "Low effort", high: "High effort" },
    y: { low: "Low impact", high: "High impact" },
    items: [
      { label: "Quick win", x: 0.25, y: 0.75 },
      { label: "Big bet", x: 0.75, y: 0.8 },
      { label: "Fill-in", x: 0.2, y: 0.25 },
      { label: "Money pit", x: 0.78, y: 0.22 },
    ],
  },
  "venn": {
    sets: [ { label: "Desirable" }, { label: "Feasible" } ],
    overlapLabel: "Sweet spot",
  },
  "timeline": {
    events: [
      { time: "Week 1", label: "Kickoff", detail: "Brief & constraints" },
      { time: "Week 3", label: "Concepts", detail: "Three directions" },
      { time: "Week 6", label: "Refine", detail: "One direction deep" },
      { time: "Week 8", label: "Deliver", detail: "Final + rationale" },
    ],
  },
  "hierarchy": {
    root: {
      label: "Design",
      children: [
        { label: "Research", children: [{ label: "Interviews" }, { label: "Analysis" }] },
        { label: "Make", children: [{ label: "Sketch" }, { label: "Prototype" }] },
        { label: "Evaluate" },
      ],
    },
  },
};

// ---------- Core ----------

// Per-element nudge offset ({ dx, dy }) stored under diagram.offsets[id].
function off(ctx, id) {
  const o = ctx.off[id];
  return { dx: (o && o.dx) || 0, dy: (o && o.dy) || 0 };
}

// A wrapped-text block. foreignObject so long labels wrap; the inner div is
// a flex column so content centers vertically.
function fo(x, y, w, h, html, valign = "center") {
  const j = valign === "end" ? "flex-end" : valign === "start" ? "flex-start" : "center";
  return `<foreignObject x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:${j};gap:4px;box-sizing:border-box;overflow:hidden;">${html}</div></foreignObject>`;
}

function txt(ctx, text, { size = 20, color, weight = 600, family, align = "center", caps = false } = {}) {
  const capCss = caps ? "text-transform:uppercase;letter-spacing:.09em;" : "";
  return `<div style="font-family:${family || ctx.body};font-weight:${weight};font-size:${size}px;line-height:1.28;color:${color || ctx.pal.text};text-align:${align};${capCss}">${esc(text)}</div>`;
}

// A rounded node box centered at (cx,cy) with a label and optional detail line.
function nodeBox(ctx, id, cx, cy, w, h, label, detail, opts = {}) {
  const fill = opts.fill || ctx.pal.surface;
  const color = opts.color || ctx.pal.text;
  const detailColor = opts.fill ? mix(color, fill, 0.3) : ctx.pal.muted;
  const x = cx - w / 2, y = cy - h / 2;
  const inner = txt(ctx, label, { size: opts.size || 19, color, weight: 600 }) +
    (detail ? txt(ctx, detail, { size: 13.5, color: detailColor, weight: ctx.bodyW }) : "");
  ctx.parts.push(`<g data-el="${esc(id)}"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="${opts.rx ?? 14}" fill="${fill}" stroke="${opts.stroke || ctx.border}"/>${fo(x + 12, y, w - 24, h, inner)}</g>`);
}

function placeholder(ctx, rect, msg) {
  ctx.parts.push(fo(rect.x, rect.y, rect.w, rect.h, txt(ctx, msg, { size: 24, color: ctx.pal.muted, weight: ctx.bodyW })));
}

// Single-line SVG text with a bg-colored halo (paint-order) so it stays
// legible over lines — used for link labels.
function haloText(ctx, x, y, text, { size = 14, color } = {}) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family=${JSON.stringify(ctx.bodyFamily)} font-size="${size}" font-weight="600" fill="${color || ctx.pal.muted}" style="paint-order:stroke;stroke:${ctx.pal.bg};stroke-width:5px;stroke-linejoin:round;">${esc(text)}</text>`;
}

// ---------- flow ----------
function renderFlow(data, ctx, rect) {
  const nodes = (data.nodes || []).filter((n) => n && n.id != null);
  if (!nodes.length) return placeholder(ctx, rect, "Add steps to this flow");
  const links = (data.links || []).filter((l) => l && l.from != null && l.to != null);
  const down = data.direction === "down";
  const idx = new Map(nodes.map((n, i) => [String(n.id), i]));

  // Layer = longest path from a root (relaxation, capped so cycles terminate).
  const layer = new Array(nodes.length).fill(0);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const l of links) {
      const a = idx.get(String(l.from)), b = idx.get(String(l.to));
      if (a == null || b == null) continue;
      if (layer[a] + 1 > layer[b] && layer[a] + 1 < nodes.length) { layer[b] = layer[a] + 1; changed = true; }
    }
    if (!changed) break;
  }
  const L = Math.max(...layer) + 1;
  const cols = Array.from({ length: L }, () => []);
  nodes.forEach((n, i) => cols[layer[i]].push(i));
  const maxRow = Math.max(...cols.map((c) => c.length));

  // Node size adapts to layer count / row count so dense flows still fit.
  let nw, nh, gap = 22;
  if (down) {
    nh = Math.min(88, (rect.h - 40 * (L - 1)) / L);
    nw = Math.min(300, (rect.w - gap * (maxRow - 1)) / maxRow);
  } else {
    nw = Math.min(232, (rect.w - 56 * (L - 1)) / L);
    nh = Math.min(96, (rect.h - gap * (maxRow - 1)) / maxRow);
  }

  // Positions (with nudge offsets applied, so links track nudged nodes).
  const pos = new Array(nodes.length);
  cols.forEach((col, li) => {
    const main = L === 1
      ? (down ? rect.y + rect.h / 2 : rect.x + rect.w / 2)
      : (down ? rect.y + nh / 2 + li * (rect.h - nh) / (L - 1) : rect.x + nw / 2 + li * (rect.w - nw) / (L - 1));
    const crossSize = down ? nw : nh;
    const total = col.length * crossSize + (col.length - 1) * gap;
    col.forEach((ni, k) => {
      const cross = (down ? rect.x + rect.w / 2 : rect.y + rect.h / 2) - total / 2 + crossSize / 2 + k * (crossSize + gap);
      const o = off(ctx, "n:" + nodes[ni].id);
      pos[ni] = down ? { cx: cross + o.dx, cy: main + o.dy } : { cx: main + o.dx, cy: cross + o.dy };
    });
  });

  // Links under nodes. Bezier along the main axis; back-links bow outward.
  for (const l of links) {
    const a = idx.get(String(l.from)), b = idx.get(String(l.to));
    if (a == null || b == null || a === b) continue;
    const pa = pos[a], pb = pos[b];
    const back = layer[b] <= layer[a];
    let x1, y1, x2, y2, path;
    if (down) {
      const dir = pb.cy >= pa.cy ? 1 : -1;
      x1 = pa.cx; y1 = pa.cy + dir * nh / 2; x2 = pb.cx; y2 = pb.cy - dir * (nh / 2 + 7);
      const c = Math.max(28, Math.abs(y2 - y1) * 0.45) * dir;
      path = back
        ? `M ${x1 + nw / 2} ${pa.cy} C ${x1 + nw / 2 + 70} ${pa.cy}, ${pb.cx + nw / 2 + 70} ${pb.cy}, ${pb.cx + nw / 2 + 7} ${pb.cy}`
        : `M ${x1} ${y1} C ${x1} ${y1 + c}, ${x2} ${y2 - c}, ${x2} ${y2}`;
    } else {
      const dir = pb.cx >= pa.cx ? 1 : -1;
      x1 = pa.cx + dir * nw / 2; y1 = pa.cy; x2 = pb.cx - dir * (nw / 2 + 7); y2 = pb.cy;
      const c = Math.max(28, Math.abs(x2 - x1) * 0.45) * dir;
      path = back
        ? `M ${pa.cx} ${pa.cy + nh / 2} C ${pa.cx} ${pa.cy + nh / 2 + 64}, ${pb.cx} ${pb.cy + nh / 2 + 64}, ${pb.cx} ${pb.cy + nh / 2 + 7}`
        : `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
    }
    ctx.parts.push(`<path d="${path}" fill="none" stroke="${ctx.pal.accent}" stroke-width="2.5" marker-end="url(#${ctx.uid}-arr)"/>`);
    if (l.label) {
      const mx = back ? (down ? Math.max(pa.cx, pb.cx) + nw / 2 + 70 : (pa.cx + pb.cx) / 2)
                      : (x1 + x2) / 2;
      const my = back ? (down ? (pa.cy + pb.cy) / 2 : Math.max(pa.cy, pb.cy) + nh / 2 + 58)
                      : (y1 + y2) / 2 - 8;
      ctx.parts.push(haloText(ctx, mx, my, l.label));
    }
  }
  nodes.forEach((n, i) => nodeBox(ctx, "n:" + n.id, pos[i].cx, pos[i].cy, nw, nh, n.label ?? String(n.id), n.detail));
}

// ---------- compare ----------
function renderCompare(data, ctx, rect) {
  const items = (data.items || []).slice(0, 4);
  if (!items.length) return placeholder(ctx, rect, "Add items to compare");
  const n = items.length;
  const gap = n === 2 ? 96 : 44;
  const pw = (rect.w - gap * (n - 1)) / n;
  const ph = Math.min(rect.h, 470);
  const py = rect.y + (rect.h - ph) / 2;
  const titleColors = [ctx.pal.accent, ctx.pal.accent2 || ctx.pal.accent, ctx.pal.text, ctx.pal.muted];
  items.forEach((it, i) => {
    const x = rect.x + i * (pw + gap);
    const o = off(ctx, "c:" + i);
    const px = x + o.dx, pyy = py + o.dy;
    const points = (it.points || []).map((p) =>
      `<div style="display:flex;gap:12px;align-items:baseline;font-family:${ctx.body};font-weight:${ctx.bodyW};font-size:17px;line-height:1.4;color:${ctx.pal.text};text-align:left;"><span style="color:${titleColors[i]};font-weight:700;">—</span><span>${esc(p)}</span></div>`).join("");
    const inner =
      txt(ctx, it.title, { size: 26, family: ctx.head, weight: ctx.headW, color: titleColors[i], align: "left" }) +
      `<div style="height:1px;background:${ctx.border};margin:10px 0 14px;"></div>` +
      `<div style="display:flex;flex-direction:column;gap:12px;">${points}</div>`;
    ctx.parts.push(`<g data-el="c:${i}"><rect x="${px.toFixed(1)}" y="${pyy.toFixed(1)}" width="${pw.toFixed(1)}" height="${ph}" rx="18" fill="${ctx.pal.surface}" stroke="${ctx.border}"/>${fo(px + 34, pyy + 34, pw - 68, ph - 68, inner, "start")}</g>`);
  });
  if (n === 2) {
    const cx = rect.x + pw + gap / 2, cy = py + ph / 2;
    ctx.parts.push(`<g><circle cx="${cx}" cy="${cy}" r="33" fill="${ctx.pal.accent}"/>${fo(cx - 33, cy - 33, 66, 66, txt(ctx, "vs", { size: 21, color: ctx.pal.bg, family: ctx.head, weight: ctx.headW }))}</g>`);
  }
}

// ---------- matrix ----------
// The plot area for a matrix diagram (exported so the tool can convert canvas
// drags back into item x/y fractions without duplicating this geometry).
export function matrixInset(diagram) {
  const rect = contentRect(diagram);
  return { x: rect.x + 120, y: rect.y + 44, w: rect.w - 240, h: rect.h - 88 };
}

function renderMatrix(data, ctx, rect) {
  const inset = { x: rect.x + 120, y: rect.y + 44, w: rect.w - 240, h: rect.h - 88 };
  const cx = inset.x + inset.w / 2, cy = inset.y + inset.h / 2;
  const axis = mix(ctx.pal.text, ctx.pal.bg, 0.45);
  ctx.parts.push(
    `<line x1="${inset.x}" y1="${cy}" x2="${inset.x + inset.w}" y2="${cy}" stroke="${axis}" stroke-width="2" marker-end="url(#${ctx.uid}-arrm)" marker-start="url(#${ctx.uid}-arrm-r)"/>`,
    `<line x1="${cx}" y1="${inset.y + inset.h}" x2="${cx}" y2="${inset.y}" stroke="${axis}" stroke-width="2" marker-end="url(#${ctx.uid}-arrm)" marker-start="url(#${ctx.uid}-arrm-r)"/>`,
  );
  const axisLabel = (x, y, w, text, align) =>
    ctx.parts.push(fo(x, y, w, 44, txt(ctx, text, { size: 14, color: ctx.pal.muted, caps: true, align, weight: 600 })));
  axisLabel(inset.x - 116, cy - 22, 104, data.x?.low ?? "", "right");
  axisLabel(inset.x + inset.w + 12, cy - 22, 104, data.x?.high ?? "", "left");
  axisLabel(cx - 130, inset.y - 42, 260, data.y?.high ?? "", "center");
  axisLabel(cx - 130, inset.y + inset.h + 2, 260, data.y?.low ?? "", "center");

  (data.items || []).forEach((it, i) => {
    const label = it.label ?? "";
    const w = Math.min(280, Math.max(76, label.length * 9.4 + 34)), h = 40;
    const px = inset.x + (it.x ?? 0.5) * inset.w;
    const py = inset.y + (1 - (it.y ?? 0.5)) * inset.h;
    ctx.parts.push(`<g data-el="i:${i}"><rect x="${(px - w / 2).toFixed(1)}" y="${(py - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${ctx.pal.accent}"/>${fo(px - w / 2, py - h / 2, w, h, txt(ctx, label, { size: 16, color: ctx.pal.bg }))}</g>`);
  });
}

// ---------- venn ----------
function renderVenn(data, ctx, rect) {
  const sets = (data.sets || []).slice(0, 3);
  if (!sets.length) return placeholder(ctx, rect, "Add sets");
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const fills = [ctx.pal.accent, ctx.pal.accent2 || ctx.pal.muted, ctx.pal.muted];
  const r = sets.length === 3 ? Math.min(rect.h * 0.36, 210) : Math.min(rect.h * 0.42, 235);
  const d = r * 0.58;
  const centers = sets.length === 3
    ? [{ x: cx - d, y: cy - d * 0.62 }, { x: cx + d, y: cy - d * 0.62 }, { x: cx, y: cy + d * 0.92 }]
    : sets.length === 2
      ? [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]
      : [{ x: cx, y: cy }];
  // Label anchors sit in each circle's exclusive region (pushed outward).
  sets.forEach((s, i) => {
    const c = centers[i], o = off(ctx, "s:" + i);
    const px = c.x + o.dx, py = c.y + o.dy;
    const vx = px === cx && py === cy ? 0 : (px - cx), vy = (py - cy);
    const len = Math.hypot(vx, vy) || 1;
    const lx = px + (vx / len) * r * 0.42, ly = py + (vy / len) * r * 0.42;
    ctx.parts.push(`<g data-el="s:${i}"><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r.toFixed(1)}" fill="${fills[i]}" fill-opacity="0.5" style="mix-blend-mode:multiply"/>${fo(lx - 110, ly - 34, 220, 68, txt(ctx, s.label ?? "", { size: 22, family: ctx.head, weight: ctx.headW, color: mix(fills[i], ctx.pal.text, 0.55) }))}</g>`);
  });
  if (data.overlapLabel && sets.length > 1) {
    const oy = sets.length === 3 ? cy + r * 0.1 : cy;
    ctx.parts.push(`<g data-el="s:overlap">${fo(cx - 90, oy - 30, 180, 60, txt(ctx, data.overlapLabel, { size: 16, weight: 700, color: ctx.pal.text }))}</g>`);
  }
}

// ---------- timeline ----------
function renderTimeline(data, ctx, rect) {
  const events = data.events || [];
  if (!events.length) return placeholder(ctx, rect, "Add events");
  const n = events.length;
  const lineY = rect.y + rect.h / 2;
  const x0 = rect.x + 30, x1 = rect.x + rect.w - 10;
  const axis = mix(ctx.pal.text, ctx.pal.bg, 0.45);
  ctx.parts.push(`<line x1="${x0 - 20}" y1="${lineY}" x2="${x1}" y2="${lineY}" stroke="${axis}" stroke-width="2.5" marker-end="url(#${ctx.uid}-arrm)"/>`);
  const span = x1 - x0 - 50;
  const bw = Math.min(240, span / Math.max(1, n - 1) * 0.94);
  events.forEach((ev, i) => {
    const ex = n === 1 ? (x0 + x1) / 2 : x0 + i * span / (n - 1);
    const above = i % 2 === 0;
    const o = off(ctx, "e:" + i);
    const bh = 108, gap = 26;
    const by = above ? lineY - gap - bh + o.dy : lineY + gap + o.dy;
    const bx = ex - bw / 2 + o.dx;
    const inner =
      (ev.time ? txt(ctx, ev.time, { size: 12.5, color: ctx.pal.accent, caps: true, weight: 700 }) : "") +
      txt(ctx, ev.label ?? "", { size: 18.5, weight: 600 }) +
      (ev.detail ? txt(ctx, ev.detail, { size: 13.5, color: ctx.pal.muted, weight: ctx.bodyW }) : "");
    // Connector from the dot to the (possibly nudged) block edge.
    const edgeY = above ? by + bh - 6 : by + 6;
    ctx.parts.push(`<line x1="${ex}" y1="${lineY}" x2="${(bx + bw / 2).toFixed(1)}" y2="${edgeY.toFixed(1)}" stroke="${ctx.border}" stroke-width="1.5"/>`);
    ctx.parts.push(`<circle cx="${ex.toFixed(1)}" cy="${lineY}" r="8.5" fill="${ctx.pal.accent}" stroke="${ctx.pal.bg}" stroke-width="3"/>`);
    ctx.parts.push(`<g data-el="e:${i}">${fo(bx, by, bw, bh, inner, above ? "end" : "start")}</g>`);
  });
}

// ---------- hierarchy ----------
function renderHierarchy(data, ctx, rect) {
  const root = data.root;
  if (!root || !root.label) return placeholder(ctx, rect, "Add a root node");
  // Measure: leaf count + depth.
  const leaves = (n) => (n.children?.length ? n.children.reduce((a, c) => a + leaves(c), 0) : 1);
  const depth = (n) => (n.children?.length ? 1 + Math.max(...n.children.map(depth)) : 0);
  const totalLeaves = leaves(root), maxDepth = depth(root);
  const nh = 58;
  const nw = Math.min(196, rect.w / totalLeaves - 16);
  const levelY = (d) => maxDepth === 0 ? rect.y + rect.h / 2 : rect.y + nh / 2 + d * (rect.h - nh) / maxDepth;
  const slotW = rect.w / totalLeaves;

  // Assign positions bottom-up: leaves take slots left→right; parents center
  // over their children. Offsets apply per node id ("h:<path>").
  let slot = 0;
  const nodes = [], edges = [];
  const place = (n, d, path) => {
    let cx;
    if (n.children?.length) {
      const kids = n.children.map((c, k) => place(c, d + 1, path + "." + k));
      cx = (kids[0].bx + kids[kids.length - 1].bx) / 2;
      kids.forEach((k) => edges.push({ from: path, to: k.path }));
    } else {
      cx = rect.x + slotW * slot + slotW / 2;
      slot++;
    }
    const o = off(ctx, "h:" + path);
    const node = { path, n, d, bx: cx, x: cx + o.dx, y: levelY(d) + o.dy };
    nodes.push(node);
    return node;
  };
  place(root, 0, "0");
  const byPath = new Map(nodes.map((nd) => [nd.path, nd]));
  for (const e of edges) {
    const p = byPath.get(e.from), c = byPath.get(e.to);
    const midY = (p.y + nh / 2 + c.y - nh / 2) / 2;
    ctx.parts.push(`<path d="M ${p.x.toFixed(1)} ${(p.y + nh / 2).toFixed(1)} V ${midY.toFixed(1)} H ${c.x.toFixed(1)} V ${(c.y - nh / 2).toFixed(1)}" fill="none" stroke="${ctx.border}" stroke-width="2"/>`);
  }
  for (const nd of nodes) {
    const isRoot = nd.d === 0;
    nodeBox(ctx, "h:" + nd.path, nd.x, nd.y, isRoot ? Math.min(nw * 1.2, 230) : nw, nh, nd.n.label, nd.n.detail, {
      fill: isRoot ? ctx.pal.accent : nd.d === 1 ? ctx.pal.surface : ctx.pal.bg,
      color: isRoot ? ctx.pal.bg : ctx.pal.text,
      size: isRoot ? 20 : 17,
    });
  }
}

const RENDERERS = {
  "flow": renderFlow, "compare": renderCompare, "matrix": renderMatrix,
  "venn": renderVenn, "timeline": renderTimeline, "hierarchy": renderHierarchy,
};

let _uid = 0;

// The drawable area (canvas minus margins and the optional title strip).
export function contentRect(diagram) {
  const rect = { x: 64, y: 56, w: DW - 128, h: DH - 112 };
  if (diagram?.title) { rect.y += 78; rect.h -= 78; }
  return rect;
}

// Render a diagram artifact to an <svg> element.
// opts.theme — override the diagram's embedded theme (e.g. the deck theme when
//   embedding into slides). opts.scheme — override its colorScheme.
// opts.transparent — skip the background rect (for transparent exports).
export function renderDiagram(diagram, opts = {}) {
  const d = diagram || {};
  const theme = opts.theme || d.theme || DIAGRAM_DEFAULT_THEME;
  const scheme = opts.scheme || d.colorScheme || "light";
  // colorScheme() derives {bg,surface,text,muted,accent}; diagrams also use a
  // second accent (compare titles, venn circles), derived the same way accent is.
  const pal = {
    ...colorScheme(theme.colors, scheme),
    accent2: scheme === "accent" || scheme === "accent2"
      ? theme.colors.bg
      : (theme.colors.accent2 || theme.colors.accent),
  };
  const ctx = {
    pal,
    // Single-quoted: these land inside double-quoted style="…" attributes.
    head: `'${theme.fonts.heading.family}', serif`, headW: theme.fonts.heading.weight,
    body: `'${theme.fonts.body.family}', sans-serif`, bodyW: theme.fonts.body.weight,
    bodyFamily: `${theme.fonts.body.family}, sans-serif`,
    off: d.offsets || {},
    border: mix(pal.text, pal.bg, 0.86),
    // Unique marker ids per render — multiple inline SVGs on one page (slide
    // decks, previews) otherwise resolve url(#arr) to the first SVG's marker.
    uid: "d" + (_uid++),
    parts: [],
  };
  const rect = contentRect(d);
  if (d.title) {
    ctx.parts.push(fo(rect.x, 48, rect.w, 56, txt(ctx, d.title, { size: 33, family: ctx.head, weight: ctx.headW, align: "left" })));
  }
  (RENDERERS[d.template] || renderFlow)(d.data || {}, ctx, rect);

  const arrow = (id, fill, rev) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="${rev ? 2 : 8}" refY="5" markerWidth="6.5" markerHeight="6.5" orient="${rev ? "auto-start-reverse" : "auto"}"><path d="M0,0 L10,5 L0,10 z" fill="${fill}"/></marker>`;
  const axisColor = mix(pal.text, pal.bg, 0.45);
  const markup =
    `<svg viewBox="0 0 ${DW} ${DH}" xmlns="http://www.w3.org/2000/svg" font-family=${JSON.stringify(theme.fonts.body.family)}>` +
    `<defs>${arrow(ctx.uid + "-arr", pal.accent)}${arrow(ctx.uid + "-arrm", axisColor)}${arrow(ctx.uid + "-arrm-r", axisColor, true)}</defs>` +
    (opts.transparent ? "" : `<rect width="${DW}" height="${DH}" fill="${pal.bg}"/>`) +
    ctx.parts.join("") +
    `</svg>`;
  const wrap = document.createElement("div");
  wrap.innerHTML = markup;
  return wrap.firstElementChild;
}

// Serialize a rendered diagram for .svg export: explicit dimensions + a
// Google Fonts @import so the standalone file renders its theme fonts when
// opened in a browser / inlined in a page.
export function diagramSvgText(diagram, opts = {}) {
  const theme = opts.theme || diagram.theme || DIAGRAM_DEFAULT_THEME;
  const svg = renderDiagram(diagram, opts);
  svg.setAttribute("width", DW);
  svg.setAttribute("height", DH);
  const f = [theme.fonts.heading, theme.fonts.body];
  const href = "https://fonts.googleapis.com/css2?family=" +
    f.map((x) => x.family.replace(/ /g, "+") + ":wght@" + x.weight).join("&family=") + "&display=swap";
  svg.insertAdjacentHTML("afterbegin", `<style>@import url('${href}');</style>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + svg.outerHTML;
}
