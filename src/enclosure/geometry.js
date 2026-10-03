// Enclosure solids via manifold-3d (WASM CSG): base + lid as watertight
// meshes, plus a binary STL writer. Geometry rules live here; the numbers
// (sizes, positions) all come from model.js `layout()` / `resolveCutouts()`.

import Module from "../vendor/manifold/manifold.js";
import { roundedRectPoly, cutoutPolys, faceBasis, faceToWorld } from "./model.js";

let wasmP = null;
export function loadManifold() {
  return (wasmP ||= Module().then((w) => {
    w.setup();
    w.setMinCircularAngle(5);
    w.setMinCircularEdgeLength(0.4);
    return w;
  }));
}

const E = 0.01;

/** Build both parts. Returns plain typed arrays (WASM objects are freed). */
export function buildParts(wasm, L, cuts) {
  const { Manifold, CrossSection } = wasm;
  const trash = [];
  const k = (x) => (trash.push(x), x);

  const rrect = (x0, y0, w, h, r) => k(CrossSection.ofPolygons([roundedRectPoly(x0, y0, w, h, r)], "NonZero"));
  const prism = (cs, z0, h) => k(k(cs.extrude(h)).translate([0, 0, z0]));
  const cyl = (x, y, z0, h, r, r2) => k(k(Manifold.cylinder(h, r, r2 ?? r)).translate([x, y, z0]));
  const cube = (x0, y0, z0, x1, y1, z1) => k(k(Manifold.cube([x1 - x0, y1 - y0, z1 - z0])).translate([x0, y0, z0]));
  const union = (list) => (list.length ? k(Manifold.union(list)) : null);
  const minus = (a, list) => { const u = union(list); return u ? k(a.subtract(u)) : a; };

  try {
    const { W, D, wall, floor, iw, id, baseH, H, z0, lidT, fit, board: B } = L;
    const R = L.radius, Ri = Math.max(0.5, R - wall);
    const outer = prism(rrect(0, 0, W, D, R), 0, baseH);

    // ---- base: shell, standoffs, lid features ---------------------------
    let base = k(outer.subtract(prism(rrect(wall, wall, iw, id, Ri), floor, baseH - floor + 1)));
    const adds = [], holes = [];
    const st = +L.standoff;
    if (st > 0.2) {
      for (const [hx, hy] of B.holes) {
        const x = L.bx + hx, y = L.by + hy;
        adds.push(cyl(x, y, floor - E, st + E, L.standoffDia / 2));
        holes.push(cyl(x, y, floor + 0.6, st, L.standoffHole / 2));
      }
    }
    if (L.style === "screw") {
      const s = L.screw, depth = Math.min(baseH - floor - 1, 10);
      const bosses = union(L.bosses.map(([x, y]) => cyl(x, y, floor - E, baseH - floor + E, s.R)));
      adds.push(k(bosses.intersect(outer)));
      for (const [x, y] of L.bosses) holes.push(cyl(x, y, baseH - depth, depth + 1, s.pilot));
    }
    if (adds.length) base = k(Manifold.union([base, ...adds]));
    if (L.style === "slide") {
      const g = L.grooveDepth;
      holes.push(cube(wall - g, -1, z0, W - wall + g, D - wall + g, z0 + lidT + fit));   // rails
      holes.push(cube(wall - g, -1, z0, W - wall + g, wall + E, baseH + 1));              // open front
    }

    // ---- lid (in its assembled position) ---------------------------------
    let lid;
    if (L.style === "slide") {
      const g = L.grooveDepth;
      lid = k(Manifold.union([
        cube(wall - g + fit, 0, z0, W - wall + g - fit, D - wall + g - fit, z0 + lidT),
        cube(wall - g + fit, 0, z0, W - wall + g - fit, wall - fit, baseH),               // front cap = pull
      ]));
    } else {
      lid = prism(rrect(0, 0, W, D, R), baseH, lidT);
      const lipH = L.style === "lip" ? L.lipHeight : 1.5;
      const ring = k(rrect(wall + fit, wall + fit, iw - 2 * fit, id - 2 * fit, Math.max(0.3, Ri - fit))
        .subtract(rrect(wall + fit + 1.2, wall + fit + 1.2, iw - 2 * fit - 2.4, id - 2 * fit - 2.4, Math.max(0.3, Ri - fit - 1.2))));
      let lip = prism(ring, baseH - lipH, lipH + E);
      if (L.style === "screw") {
        lip = minus(lip, L.bosses.map(([x, y]) => cyl(x, y, baseH - lipH - 1, lipH + 2, L.screw.R + fit + 0.3)));
        const s = L.screw, cut = [];
        for (const [x, y] of L.bosses) {
          cut.push(cyl(x, y, baseH - 1, lidT + 2, s.clear));
          if (L.countersink) {
            const ch = Math.min(s.head - s.clear, lidT - 0.4);
            cut.push(cyl(x, y, baseH + lidT - ch, ch + E, s.clear, s.clear + ch + E));
          }
        }
        lid = minus(lid, cut);
      }
      lid = k(Manifold.union([lid, lip]));
    }

    // ---- cutouts ----------------------------------------------------------
    const sideCuts = [], topCuts = [], bottomCuts = [];
    for (const c of cuts) {
      const f = faceBasis(c.face, L);
      const depth = c.face === "top" ? H - z0 + 0.5 : c.face === "bottom" ? floor + 0.3 : wall + 1.5;
      const out = 0.5;
      const cs = k(CrossSection.ofPolygons(cutoutPolys(c), "NonZero"));
      // n runs from just outside the face to `depth` inside; keep n = z + n0
      // (never mirrored) so the cutter stays right-side out.
      const n0 = f.out > 0 ? -depth : -out;
      const cutter = k(k(cs.extrude(depth + out)).warp((v) => {
        const p = faceToWorld(f, v[0], v[1], v[2] + n0);
        v[0] = p[0]; v[1] = p[1]; v[2] = p[2];
      }));
      (c.face === "top" ? topCuts : c.face === "bottom" ? bottomCuts : sideCuts).push(cutter);
    }
    base = minus(base, [...holes, ...sideCuts, ...bottomCuts]);
    lid = minus(lid, [...sideCuts, ...topCuts]);

    return { base: meshOut(base), lid: meshOut(lid) };
  } finally {
    for (const x of trash) { try { x.delete(); } catch {} }
  }
}

function meshOut(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties;
  const n = vp.length / np;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { positions[i * 3] = vp[i * np]; positions[i * 3 + 1] = vp[i * np + 1]; positions[i * 3 + 2] = vp[i * np + 2]; }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

/** Lid flipped / dropped onto the print bed; base is already print-ready. */
export function lidForPrint(lid, L) {
  const p = new Float32Array(lid.positions);
  if (L.style === "slide") {
    for (let i = 2; i < p.length; i += 3) p[i] -= L.z0;
  } else {
    // 180° about X (rigid, so triangle winding stays outward), then back onto z = 0.
    const top = L.baseH + L.lidT;
    for (let i = 0; i < p.length; i += 3) { p[i + 1] = L.D - p[i + 1]; p[i + 2] = top - p[i + 2]; }
  }
  return { positions: p, indices: lid.indices };
}

/** Binary STL. */
export function toSTL({ positions: p, indices: t }, label = "studio enclosure") {
  const nt = t.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(label.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(head);
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let i = 0; i < nt; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) { dv.setFloat32(o, v, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}
