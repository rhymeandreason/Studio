// Enclosure model: the saved `enclosure` artifact shape, its defaults, and the
// pure layout math every consumer shares (the tool's 2D face editor + 3D
// preview, the manifold geometry builder, the Artifacts-panel thumbnail).
// No DOM, no WASM: importable anywhere.
//
// World frame (mm): X = width (left → right), Y = depth (front → back),
// Z = up, origin at the outer bottom-front-left corner. The board sits with
// its front edge toward -Y.
//
// Face frame: each face is a 2D drawing seen from OUTSIDE, u to the right,
// v up, origin at the face's bottom-left outer corner. Top and bottom are
// both drawn as seen from above (so they line up with the board drawing).

import { BOARDS } from "./boards.js";

export const FACES = ["front", "back", "left", "right", "top", "bottom"];
export const FACE_LABEL = { front: "Front", back: "Back", left: "Left", right: "Right", top: "Top", bottom: "Bottom" };
export const LID_STYLES = ["screw", "slide", "lip"];
export const SHAPES = ["rect", "slot", "circle", "vent"];

export const DEFAULT_BOX = { wall: 2, floor: 2, clearance: 1, height: 24, radius: 3, standoff: 4, standoffDia: 6, standoffHole: 2.2 };
export const DEFAULT_LID = { style: "screw", thickness: 2, fit: 0.2, screw: 2.5, countersink: true, lipHeight: 3 };

/** The slicer Studio hands exported STLs to (`open -a <SLICER>`). */
export const SLICER = { app: "BambuStudio", label: "Bambu Studio" };

export const uid = () => Math.random().toString(36).slice(2, 8);

/** A fresh enclosure for a preset, with a cutout for every default-on port. */
export function newEnclosure(preset = "pi5") {
  const doc = {
    kind: "enclosure", version: 1,
    name: (BOARDS[preset]?.name || "Custom board") + " case",
    board: { preset, portMargin: 1 },
    box: { ...DEFAULT_BOX },
    lid: { ...DEFAULT_LID },
    cutouts: [],
  };
  doc.cutouts = defaultPortCutouts(resolveBoard(doc.board));
  return doc;
}

export function defaultPortCutouts(board) {
  return board.ports.filter((p) => !p.off).map((p) => ({ id: uid(), port: p.id }));
}

/** Lenient read: fill whatever's missing so hand- or Claude-written files work. */
export function normalize(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  return {
    kind: "enclosure", version: 1,
    name: d.name || "Untitled enclosure",
    board: { preset: "pi5", portMargin: 1, ...(d.board || {}) },
    box: { ...DEFAULT_BOX, ...(d.box || {}) },
    lid: { ...DEFAULT_LID, ...(d.lid || {}) },
    cutouts: Array.isArray(d.cutouts) ? d.cutouts.map((c) => ({ id: c.id || uid(), ...c })) : [],
    ...(d.exports ? { exports: d.exports } : {}),
  };
}

/** Board spec: a preset, or `preset: "custom"` with its own w/d/t/r/holes/ports. */
export function resolveBoard(board = {}) {
  const base = board.preset && board.preset !== "custom" ? BOARDS[board.preset] : null;
  const src = base || board;
  return {
    name: base ? base.name : "Custom board",
    w: +src.w || 60, d: +src.d || 40, t: +src.t || 1.6, r: src.r != null ? +src.r : 2,
    holeDia: +src.holeDia || 3,
    holes: Array.isArray(src.holes) ? src.holes : [],
    ports: Array.isArray(src.ports) ? src.ports : [],
  };
}

// --- ports --------------------------------------------------------------

/** How deep a connector reaches onto the board (only used for collision + preview). */
const portDepth = (p) => p.depth ?? Math.min(21, Math.max(6, p.w));

/** A port's box relative to the board origin; z relative to the board's top surface. */
export function portBox(p, B) {
  const half = p.w / 2, dep = portDepth(p), oh = p.overhang || 0;
  const z0 = p.z || 0;
  switch (p.edge) {
    case "front": return { x0: p.at - half, x1: p.at + half, y0: -oh, y1: dep, z0, z1: z0 + p.h };
    case "back": return { x0: p.at - half, x1: p.at + half, y0: B.d - dep, y1: B.d + oh, z0, z1: z0 + p.h };
    case "left": return { x0: -oh, x1: dep, y0: p.at - half, y1: p.at + half, z0, z1: z0 + p.h };
    case "right": return { x0: B.w - dep, x1: B.w + oh, y0: p.at - half, y1: p.at + half, z0, z1: z0 + p.h };
    case "top": return { x0: p.x - p.w / 2, x1: p.x + p.w / 2, y0: p.y - p.h / 2, y1: p.y + p.h / 2, z0: 0, z1: p.height || 3 };
  }
  return null;
}

/** Lid screw geometry for a nominal screw diameter (self-tapping into a printed boss). */
export function screwSpec(d) {
  const R = d * 1.3;
  return { R, inset: R * 0.55, pilot: (d * 0.85) / 2, clear: (d + 0.4) / 2, head: d };
}

// --- layout -------------------------------------------------------------

/** Everything derived from the doc: outer size, board placement, face sizes… */
export function layout(doc) {
  const { box, lid } = doc;
  const B = resolveBoard(doc.board);
  const wall = +box.wall, floor = +box.floor;

  // How far ports stick out past each board edge — the interior grows to fit.
  const ext = { left: 0, right: 0, front: 0, back: 0 };
  for (const p of B.ports) if (ext[p.edge] != null) ext[p.edge] = Math.max(ext[p.edge], p.overhang || 0);

  const screw = screwSpec(+lid.screw || 2.5);
  const place = (c) => {
    const iw = ext.left + B.w + ext.right + 2 * c, id = ext.front + B.d + ext.back + 2 * c;
    const bx = wall + c + ext.left, by = wall + c + ext.front;
    const W = iw + 2 * wall, D = id + 2 * wall;
    const i = screw.inset;
    const bosses = [[wall + i, wall + i], [W - wall - i, wall + i], [wall + i, D - wall - i], [W - wall - i, D - wall - i]];
    return { iw, id, bx, by, W, D, bosses };
  };

  // Screw bosses stand in the interior corners: push the walls out until they
  // clear the board (and any connector reaching into a corner).
  let clearance = +box.clearance, bumped = false;
  if (lid.style === "screw") {
    for (let k = 0; k < 200 && bossesCollide(place(clearance), B, screw.R); k++) { clearance += 0.1; bumped = true; }
    clearance = Math.round(clearance * 10) / 10;
  }
  const P = place(clearance);

  const bz = floor + +box.standoff, boardTop = bz + B.t;
  const lidT = +lid.thickness, fit = +lid.fit;
  const z0 = floor + +box.height;                        // lid underside
  const topLip = Math.max(1.2, wall * 0.6);              // slide: rail above the groove
  const baseH = lid.style === "slide" ? z0 + lidT + fit + topLip : z0;
  const H = lid.style === "slide" ? baseH : baseH + lidT;

  let tallest = 0;
  for (const p of B.ports) { const b = portBox(p, B); if (b) tallest = Math.max(tallest, b.z1); }
  const minHeight = Math.ceil((+box.standoff + B.t + tallest + 1 + (lid.style === "lip" ? +lid.lipHeight : 0)) * 2) / 2;

  return {
    board: B, ext, wall, floor, clearance, clearanceBumped: bumped,
    ...P, bz, boardTop, z0, baseH, H, lidT, fit, topLip,
    radius: Math.max(0, Math.min(+box.radius, P.W / 2 - 0.1, P.D / 2 - 0.1)),
    screw, minHeight, style: lid.style,
    grooveDepth: wall * 0.5,
    standoff: +box.standoff, standoffDia: +box.standoffDia, standoffHole: +box.standoffHole,
    countersink: !!lid.countersink, lipHeight: +lid.lipHeight,
  };
}

function bossesCollide(P, B, R) {
  const rb = Math.min(B.r, B.w / 2, B.d / 2);
  // Board as a rounded rect: distance to its core rect minus the corner radius.
  const rects = [{ x0: P.bx + rb, x1: P.bx + B.w - rb, y0: P.by + rb, y1: P.by + B.d - rb, pad: rb }];
  for (const p of B.ports) {
    const b = portBox(p, B);
    if (b && p.edge !== "top") rects.push({ x0: P.bx + b.x0, x1: P.bx + b.x1, y0: P.by + b.y0, y1: P.by + b.y1, pad: 0 });
  }
  for (const [cx, cy] of P.bosses) {
    for (const r of rects) {
      const dx = Math.max(r.x0 - cx, 0, cx - r.x1), dy = Math.max(r.y0 - cy, 0, cy - r.y1);
      if (Math.hypot(dx, dy) - r.pad < R + 0.3) return true;
    }
  }
  return false;
}

// --- faces --------------------------------------------------------------

export function faceSize(face, L) {
  if (face === "top" || face === "bottom") return { w: L.W, h: L.D };
  if (face === "left" || face === "right") return { w: L.D, h: L.H };
  return { w: L.W, h: L.H };
}

/** Face basis in world space: point = O + u·U + v·V + n·N, with N = U × V
 *  (always right-handed, so warping a cutter by it never turns it inside out).
 *  `out` is +1 when N points out of the box, −1 when it points in. */
export function faceBasis(face, L) {
  const { W, D, H } = L;
  switch (face) {
    case "front": return { O: [0, 0, 0], U: [1, 0, 0], V: [0, 0, 1], N: [0, -1, 0], out: 1 };
    case "back": return { O: [W, D, 0], U: [-1, 0, 0], V: [0, 0, 1], N: [0, 1, 0], out: 1 };
    case "left": return { O: [0, D, 0], U: [0, -1, 0], V: [0, 0, 1], N: [-1, 0, 0], out: 1 };
    case "right": return { O: [W, 0, 0], U: [0, 1, 0], V: [0, 0, 1], N: [1, 0, 0], out: 1 };
    case "top": return { O: [0, 0, H], U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1], out: 1 };
    case "bottom": return { O: [0, 0, 0], U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1], out: -1 };
  }
}

export function faceToWorld(f, u, v, n = 0) {
  return [0, 1, 2].map((i) => f.O[i] + u * f.U[i] + v * f.V[i] + n * f.N[i]);
}

/** Which face a world-space point is nearest to (for clicking the 3D view). */
export function nearestFace(p, L) {
  const d = { left: p[0], right: L.W - p[0], front: p[1], back: L.D - p[1], bottom: p[2], top: L.H - p[2] };
  return Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

/** World point → face (u, v). */
export function worldToFace(f, p) {
  const r = [p[0] - f.O[0], p[1] - f.O[1], p[2] - f.O[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [dot(r, f.U), dot(r, f.V)];
}

/** A port's centre + size on its face. */
export function portOnFace(p, L) {
  const B = L.board;
  if (p.edge === "top") return { face: "top", cx: L.bx + p.x, cy: L.by + p.y, w: p.w, h: p.h };
  const along = p.edge === "front" || p.edge === "back" ? L.bx + p.at : L.by + p.at;
  const cy = L.boardTop + (p.z || 0) + p.h / 2;
  const cx = { front: along, back: L.W - along, left: L.D - along, right: along }[p.edge];
  return { face: p.edge, cx, cy, w: p.shape === "circle" ? p.h : p.w, h: p.h, circle: p.shape === "circle" };
}

/** Cutouts with absolute face coordinates. Port-linked ones follow their port. */
export function resolveCutouts(doc, L) {
  const m = +doc.board.portMargin || 0;
  const out = [];
  for (const c of doc.cutouts) {
    if (c.port) {
      const p = L.board.ports.find((q) => q.id === c.port);
      if (!p) continue;
      const pf = portOnFace(p, L);
      const shape = c.shape || (pf.circle ? "circle" : "rect");
      const w = c.w ?? pf.w + 2 * m;
      out.push({
        ...c, face: pf.face, shape, linked: true, label: c.label || p.label,
        cx: pf.cx + (c.dx || 0), cy: pf.cy + (c.dy || 0),
        w, h: shape === "circle" ? w : c.h ?? pf.h + 2 * m, r: c.r ?? 1,
      });
    } else {
      const shape = c.shape || "rect";
      const w = +c.w || 10;
      out.push({
        ...c, face: c.face || "front", shape, linked: false,
        cx: +c.x || 0, cy: +c.y || 0, w, h: shape === "circle" ? w : +c.h || w, r: c.r ?? 1,
      });
    }
  }
  return out;
}

// --- 2D outlines (shared by the SVG editor and the manifold cutters) ----

/** Counter-clockwise rounded rectangle polygon. */
export function roundedRectPoly(x0, y0, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 0.01) return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  const seg = Math.max(3, Math.min(14, Math.ceil(r * 2.5)));
  const corners = [[x0 + w - r, y0 + r, -90], [x0 + w - r, y0 + h - r, 0], [x0 + r, y0 + h - r, 90], [x0 + r, y0 + r, 180]];
  const pts = [];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
      const pt = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last[0] - pt[0], last[1] - pt[1]) > 1e-6) pts.push(pt);
    }
  }
  const [a, b] = [pts[0], pts[pts.length - 1]];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
  return pts;
}

export function circlePoly(cx, cy, r) {
  const n = Math.max(24, Math.min(96, Math.ceil((2 * Math.PI * r) / 0.5)));
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
}

/** Vent grille: slots run across the short side, repeated along the long one. */
export function ventSlots(c) {
  const slot = +c.slot || 2, gap = +c.gap || 2;
  const horiz = c.w >= c.h;                  // repeat along u when wider than tall
  const L = horiz ? c.w : c.h, S = horiz ? c.h : c.w;
  const n = Math.max(1, Math.floor((L + gap) / (slot + gap)));
  const span = n * slot + (n - 1) * gap;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -span / 2 + i * (slot + gap);
    out.push(horiz
      ? { x0: c.cx + a, y0: c.cy - S / 2, w: slot, h: S }
      : { x0: c.cx - S / 2, y0: c.cy + a, w: S, h: slot });
  }
  return out;
}

/** A resolved cutout as polygons in face (u, v) coordinates. */
export function cutoutPolys(c) {
  switch (c.shape) {
    case "circle": return [circlePoly(c.cx, c.cy, c.w / 2)];
    case "slot": return [roundedRectPoly(c.cx - c.w / 2, c.cy - c.h / 2, c.w, c.h, Math.min(c.w, c.h) / 2)];
    case "vent": return ventSlots(c).map((s) => roundedRectPoly(s.x0, s.y0, s.w, s.h, Math.min(s.w, s.h) / 2));
    default: return [roundedRectPoly(c.cx - c.w / 2, c.cy - c.h / 2, c.w, c.h, c.r)];
  }
}

export const polyPath = (polys, flipH) =>
  polys.map((p) => "M" + p.map(([u, v]) => `${u.toFixed(2)} ${(flipH - v).toFixed(2)}`).join("L") + "Z").join("");
