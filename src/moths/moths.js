// Studio moths — procedural butterflies & moths, drawn as flat vector SVG.
//
// Pure functions, no DOM: any Studio page (or a Node script) can import this.
//
//   import { specimen, specimenSVG, describe } from "../moths/moths.js";
//   const spec = specimen({ seed: 42 });           // resolve every field
//   const svg  = specimenSVG(spec, { fit: "tight" });
//   const { name, latin } = describe(spec);
//
// A spec is small plain JSON — { seed, family, recipe, palette, colors,
// shapeSeed, patternSeed, colorSeed, size } — so it can be stored anywhere and
// re-rendered identically. Pass any subset to specimen(); the rest is derived
// from `seed`. Shape, pattern and colors draw from separate seeds, so changing
// one (e.g. family) leaves the others alone.
//
// How a wing is drawn: each wing is a "fan" from its root at the body. A
// margin function r(t) gives the outer edge for t ∈ [0,1] (apex → tornus), and
// fan(t, f) maps (position along the margin, fraction out from the root) to a
// point. Every pattern layer (veins, bands, eyespots, borders…) is written in
// those fan coordinates and clipped to the wing, so any pattern fits any
// silhouette. Right wings are drawn once and mirrored.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ---------- random ---------------------------------------------------------- */

const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const mixSeed = (seed, k) => (Math.imul((seed ^ (k * 0x9e3779b1)) | 0, 0x85ebca6b) ^ k) >>> 0;
export const randomSeed = () => (Math.random() * 2 ** 31) >>> 0;

const range = (r, a, b) => a + (b - a) * r();
const rr = (r, v) => (Array.isArray(v) ? range(r, v[0], v[1]) : v ?? 0);
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function weighted(r, weights) {
    const entries = Object.entries(weights);
    let n = r() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) if ((n -= w) <= 0) return k;
    return entries[0][0];
}

/* ---------- color ------------------------------------------------------------ */

function rgb(hex) {
    let h = String(hex).replace("#", "");
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
export function mix(a, b, t) {
    const A = rgb(a), B = rgb(b);
    return toHex(A.map((v, i) => v + (B[i] - v) * t));
}
function lum(hex) {
    const [r, g, b] = rgb(hex).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
function hsl(hex) {
    const [r, g, b] = rgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}
const vividness = (hex) => { const [, s, l] = hsl(hex); return s * (1 - Math.abs(l - 0.55) * 1.4); };

/* ---------- palettes -------------------------------------------------------- */

export const PALETTES = {
    sorbet:   { label: "Sorbet",    colors: ["#9fd8cf", "#f4a3a8", "#e8506a", "#f7c9b6", "#2f4b4f", "#fff4ec"] },
    riso:     { label: "Riso",      colors: ["#f0a830", "#4a63d9", "#f6b3c6", "#1f5b3a", "#ef6a4c", "#1c1c1c"] },
    specimen: { label: "Specimen",  colors: ["#1f5f5b", "#d9344a", "#f2c14e", "#f4ead3", "#7fb3a6", "#1a1a1e"] },
    lagoon:   { label: "Lagoon",    colors: ["#1b8a9a", "#7fd3d6", "#0f4f5e", "#f5f1e6", "#e8b04b", "#10181e"] },
    dusk:     { label: "Dusk",      colors: ["#c9a27e", "#8a5a44", "#efe1c6", "#e07a5f", "#9c8ab4", "#33241f"] },
    luna:     { label: "Luna",      colors: ["#a8dcc3", "#f3a490", "#f7e7c1", "#d9665b", "#5f8a73", "#2e3b34"] },
    ochre:    { label: "Ochre",     colors: ["#f0a64a", "#e3c07a", "#9e7bd1", "#7a3b1d", "#fbe7bf", "#2e1d14"] },
    tiger:    { label: "Tiger",     colors: ["#e8452c", "#f7b52c", "#fff2dc", "#2b5aa8", "#f28aa0", "#191717"] },
    blossom:  { label: "Blossom",   colors: ["#f7a6c9", "#e05697", "#fbe0ea", "#9b5c9c", "#f6c177", "#2a1f2d"] },
    seaglass: { label: "Sea Glass", colors: ["#7bc4b8", "#3b7f8c", "#f2d0a4", "#e87c6b", "#f8efe2", "#1e3340"] },
    plum:     { label: "Plum",      colors: ["#5b2a4e", "#d7a43b", "#f2e3c2", "#b4436c", "#8fb3a3", "#1f0f1b"] },
    meadow:   { label: "Meadow",    colors: ["#9bbf6a", "#f2c14e", "#e76f51", "#f7efd9", "#2a6f63", "#1f2a24"] },
};

/** The color roles a spec carries (editable in the tool). */
export const COLOR_ROLES = [
    ["ground", "Forewing"],
    ["ground2", "Hindwing"],
    ["accent", "Accent"],
    ["accent2", "Accent 2"],
    ["dark", "Dark"],
    ["light", "Light"],
    ["body", "Body"],
];

/* ---------- families (silhouettes) ------------------------------------------ */
/* Wing params (degrees / units, [min,max] ranges):
 *   a0/a1   angle of the apex / tornus ray from the root (y down, so negative = up)
 *   L       length of the apex ray; tornus = r at t=1 as a fraction of L
 *   bulge   outer-margin convexity; falcate = hooked apex; costa/inner = edge bow
 *   scallop + scallopN = wavy margin; tail = { t, len, w } a lobe on the margin
 *   round   smoothing passes (1 = crisp moth corners, 3 = soft pierid) */

const BUTTERFLY_BODY = { thW: 4, thH: 8, abLen: [30, 38], abW: 3.1, headR: 3.4, fuzzy: false, antenna: ["club"], antLen: [34, 42], antSpread: [12, 18] };
const MOTH_BODY = { thW: 6.5, thH: 9, abLen: [26, 34], abW: 5.4, headR: 4.4, fuzzy: true, antenna: ["feather"], antLen: [18, 26], antSpread: [12, 18] };

export const FAMILIES = {
    brushfoot: {
        label: "Brush-foot", moth: false, weight: 3,
        fw: { a0: [-44, -32], a1: [16, 30], L: [78, 90], tornus: [0.58, 0.68], bulge: [0, 0.08], costa: [0.03, 0.07], falcate: [0, 0.04], inner: [0, 0.04], round: 2 },
        hw: { a0: [-8, 4], a1: [92, 106], L: [50, 60], tornus: [0.62, 0.78], bulge: [0.06, 0.14], scallop: [0, 0.035], scallopN: [5, 8], round: 2 },
        body: BUTTERFLY_BODY,
        recipes: { monarch: 3, eyed: 2, bordered: 3, twotone: 2, banded: 2, spotted: 2 },
        nouns: ["Admiral", "Fritillary", "Lady", "Emperor", "Checkerspot", "Buckeye", "Brush-foot"],
        genus: ["Vanes", "Nymph", "Junon", "Limen", "Aglai", "Melit"],
    },
    swallowtail: {
        label: "Swallowtail", moth: false, weight: 2,
        fw: { a0: [-40, -30], a1: [12, 22], L: [86, 96], tornus: [0.52, 0.6], bulge: [-0.02, 0.04], costa: [0.03, 0.06], falcate: [0, 0.02], inner: [0, 0.03], round: 1 },
        hw: { a0: [6, 16], a1: [98, 108], L: [50, 58], tornus: [0.78, 0.9], bulge: [0.02, 0.07], scallop: [0.04, 0.07], scallopN: [5, 7], tail: { t: [0.52, 0.62], len: [0.4, 0.6], w: [0.03, 0.042] }, round: 1 },
        body: BUTTERFLY_BODY,
        recipes: { monarch: 2, bordered: 3, banded: 2, twotone: 1, eyed: 1 },
        nouns: ["Swallowtail", "Kite", "Birdwing"],
        genus: ["Papil", "Iphicl", "Graph", "Troid", "Ornith"],
    },
    morpho: {
        label: "Morpho", moth: false, weight: 1.5,
        fw: { a0: [-40, -34], a1: [22, 32], L: [88, 98], tornus: [0.66, 0.74], bulge: [0.04, 0.09], costa: [0.05, 0.08], round: 2 },
        hw: { a0: [0, 8], a1: [94, 104], L: [56, 64], tornus: [0.66, 0.78], bulge: [0.1, 0.16], scallop: [0.01, 0.03], scallopN: [6, 9], round: 2 },
        body: BUTTERFLY_BODY,
        recipes: { morpho: 4, bordered: 1, eyed: 1, spotted: 1 },
        nouns: ["Morpho", "Blue", "Glasswing"],
        genus: ["Morph", "Caligo", "Heli", "Menel"],
    },
    pierid: {
        label: "White & Sulphur", moth: false, weight: 1.5,
        fw: { a0: [-46, -38], a1: [24, 34], L: [66, 76], tornus: [0.66, 0.76], bulge: [0.08, 0.14], costa: [0.04, 0.07], round: 3 },
        hw: { a0: [0, 10], a1: [96, 106], L: [44, 52], tornus: [0.7, 0.82], bulge: [0.12, 0.18], round: 3 },
        body: { ...BUTTERFLY_BODY, abLen: [26, 32], antLen: [30, 36] },
        recipes: { tip: 3, spotted: 2, bordered: 2, monarch: 1 },
        nouns: ["White", "Sulphur", "Orangetip", "Jezebel", "Brimstone"],
        genus: ["Pier", "Colia", "Delia", "Gonept", "Antho"],
    },
    silk: {
        label: "Silk Moth", moth: true, weight: 2,
        fw: { a0: [-24, -12], a1: [30, 42], L: [84, 96], tornus: [0.62, 0.72], bulge: [-0.02, 0.05], costa: [0.02, 0.05], falcate: [0.04, 0.1], round: 1 },
        hw: { a0: [8, 20], a1: [100, 112], L: [58, 68], tornus: [0.66, 0.8], bulge: [0.08, 0.16], round: 2 },
        body: MOTH_BODY,
        recipes: { eyed: 4, banded: 2, twotone: 2 },
        nouns: ["Emperor", "Silk Moth", "Atlas", "Royal Moth"],
        genus: ["Anthera", "Hyaloph", "Saturn", "Attac", "Automer"],
    },
    luna: {
        label: "Moon Moth", moth: true, weight: 1.5,
        fw: { a0: [-26, -16], a1: [26, 36], L: [70, 80], tornus: [0.62, 0.72], bulge: [0, 0.05], costa: [0.02, 0.04], falcate: [0.03, 0.08], round: 1 },
        hw: { a0: [14, 24], a1: [88, 98], L: [46, 54], tornus: [0.62, 0.72], bulge: [0.04, 0.1], tail: { t: [0.7, 0.8], len: [1.1, 1.5], w: [0.07, 0.1] }, round: 2 },
        body: MOTH_BODY,
        recipes: { eyed: 3, bordered: 2, banded: 1 },
        nouns: ["Moon Moth", "Comet Moth", "Luna"],
        genus: ["Actia", "Argem", "Graell", "Selen"],
    },
    tiger: {
        label: "Tiger Moth", moth: true, weight: 3,
        fw: { a0: [30, 42], a1: [72, 82], L: [78, 90], tornus: [0.82, 0.92], bulge: [0.02, 0.08], costa: [0.02, 0.05], round: 1 },
        hw: { a0: [12, 22], a1: [70, 84], L: [56, 66], tornus: [0.8, 0.9], bulge: [0.06, 0.12], round: 2 },
        body: { ...MOTH_BODY, antenna: ["feather", "thread"] },
        recipes: { tiger: 4, ermine: 2, squiggle: 2, dashes: 2, banded: 1 },
        nouns: ["Tiger Moth", "Footman", "Ermine", "Arctiid", "Tussock"],
        genus: ["Arcti", "Callimor", "Spilos", "Utethe", "Hypsid"],
    },
    hawk: {
        label: "Hawk-moth", moth: true, weight: 2,
        fw: { a0: [38, 50], a1: [60, 70], L: [80, 92], tornus: [0.55, 0.64], bulge: [0.02, 0.06], costa: [0.03, 0.05], falcate: [0, 0.04], round: 1 },
        hw: { a0: [30, 40], a1: [78, 90], L: [44, 52], tornus: [0.72, 0.85], bulge: [0.06, 0.12], round: 2 },
        body: { ...MOTH_BODY, thW: 8, thH: 11, abLen: [44, 52], abW: 7.5, headR: 5, antenna: ["thread"], antLen: [22, 28] },
        recipes: { rays: 3, banded: 2, twotone: 2, dashes: 1 },
        nouns: ["Hawk-moth", "Sphinx", "Hummingbird Moth"],
        genus: ["Sphin", "Daphn", "Delleph", "Hyle", "Manduc"],
    },
    geometer: {
        label: "Geometer", moth: true, weight: 2,
        fw: { a0: [-12, 0], a1: [28, 38], L: [72, 84], tornus: [0.55, 0.66], bulge: [0.02, 0.06], costa: [0.03, 0.05], falcate: [0, 0.04], round: 1 },
        hw: { a0: [28, 38], a1: [98, 108], L: [44, 52], tornus: [0.72, 0.84], bulge: [0.06, 0.12], scallop: [0, 0.03], scallopN: [7, 10], round: 2 },
        body: { ...MOTH_BODY, thW: 5, abW: 4.2, antenna: ["feather", "thread"] },
        recipes: { banded: 3, squiggle: 2, ermine: 1, eyed: 1, spotted: 1 },
        nouns: ["Carpet", "Wave", "Looper", "Emerald", "Pug"],
        genus: ["Geomet", "Xanthor", "Idae", "Epirr", "Campae"],
    },
};

/* ---------- geometry --------------------------------------------------------- */

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const f1 = (n) => Math.round(n * 10) / 10;
const quad = (a, c, b, n) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
    return out;
};
function chaikin(pts, passes, closed = true) {
    for (let p = 0; p < passes; p++) {
        const out = [], n = pts.length;
        for (let i = 0; i < (closed ? n : n - 1); i++) {
            const a = pts[i], b = pts[(i + 1) % n];
            out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
            out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
        }
        if (!closed) { out.unshift(pts[0]); out.push(pts[n - 1]); }
        pts = out;
    }
    return pts;
}
/** Drop points closer than `min` to the last kept one (smoothing makes many). */
function thin(pts, min) {
    const out = [pts[0]];
    for (const p of pts) {
        const q = out[out.length - 1];
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p);
    }
    return out;
}
const poly = (pts, close = true) => "M" + pts.map((p) => f1(p[0]) + " " + f1(p[1])).join("L") + (close ? "Z" : "");

/** Build one wing: outline path + the fan() coordinate map patterns use. */
function makeWing(o) {
    const A0 = o.a0 * DEG, A1 = o.a1 * DEG, L = o.L;
    const ang = (t) => A0 + (A1 - A0) * t;
    const baseR = (t) => {
        const tc = clamp01(t);
        let r = L * lerp(1, o.tornus, tc) + o.bulge * L * Math.sin(Math.PI * tc);
        if (o.falcate && tc < 0.5) r -= o.falcate * L * Math.pow(Math.sin(Math.PI * tc / 0.5), 1.4);
        return r;
    };
    const detailR = (t) => {
        let r = baseR(t);
        if (o.scallop) r += o.scallop * L * (Math.pow(Math.abs(Math.sin(o.scallopN * Math.PI * t)), 0.6) - 0.7) * Math.pow(Math.sin(Math.PI * t), 0.3);
        if (o.tail) {
            const d = (t - o.tail.t) / o.tail.w;
            if (Math.abs(d) < 1) r += o.tail.len * L * Math.pow(1 - d * d, 0.45);
        }
        return r;
    };
    const [ox, oy] = o.origin;
    const at = (t, r) => [ox + Math.cos(ang(t)) * r, oy + Math.sin(ang(t)) * r];
    const fan = (t, f) => at(t, baseR(t) * f);

    const apex = at(0, detailR(0)), tornus = at(1, detailR(1));
    const rf = o.rootFront, rb = o.rootBack;
    const bow = (a, b, k) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
        return [(a[0] + b[0]) / 2 + (dy / len) * k * L, (a[1] + b[1]) / 2 - (dx / len) * k * L];
    };
    const margin = [];
    const N = o.tail || o.scallop ? 140 : 70;
    for (let i = 1; i < N; i++) margin.push(at(i / N, detailR(i / N)));
    let outline = [
        ...quad(rf, bow(rf, apex, o.costa), apex, 12),
        ...margin,
        ...quad(tornus, bow(tornus, rb, o.inner), rb, 12),
    ];
    outline = thin(chaikin(outline, o.round), 1.1);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of outline) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { L, fan, ang, d: poly(outline), bounds: { minX, maxX, minY, maxY } };
}

function resolveWing(ranges, r, isFw) {
    const o = {};
    for (const k of ["a0", "a1", "L", "tornus", "bulge", "falcate", "costa", "inner", "scallop"]) o[k] = rr(r, ranges[k]);
    o.scallopN = Math.round(rr(r, ranges.scallopN) || 6);
    o.round = ranges.round ?? 2;
    if (ranges.tail) o.tail = { t: rr(r, ranges.tail.t), len: rr(r, ranges.tail.len), w: rr(r, ranges.tail.w) };
    o.origin = isFw ? [2, -4] : [2, 3];
    o.rootFront = isFw ? [1.5, -9] : [1.5, -2];
    o.rootBack = isFw ? [1.5, 0] : [1.5, 9];
    return o;
}

/* ---------- pattern layers (all in fan coordinates, clipped to the wing) ----- */

const val = (v, t) => (typeof v === "function" ? v(t) : v);
const fill = (d, c, extra = "") => `<path d="${d}" fill="${c}"${extra}/>`;
const stroke = (d, c, w) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${f1(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
const circle = (x, y, r, c) => `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${c}"/>`;
const ellipse = (x, y, rx, ry, rotDeg, c) =>
    `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(rx)}" ry="${f1(ry)}" transform="rotate(${f1(rotDeg)} ${f1(x)} ${f1(y)})" fill="${c}"/>`;
const tri = (x) => { const u = x - Math.floor(x); return 1 - 4 * Math.abs(u - 0.5); };
function wave(mode, freq, ph) {
    if (mode === "zig") return (t) => tri(freq * t + ph);
    if (mode === "scallop") return (t) => Math.abs(Math.sin((freq * t + ph) * Math.PI)) * 2 - 1;
    return (t) => Math.sin((freq * t + ph) * TAU);
}

/** A band between two fan radii (numbers or t → f functions), with wavy edges. */
function band(w, color, f0, f1v, { wob = 0, wob0 = wob, freq = 3, ph = 0, mode = "sin", t0 = -0.25, t1 = 1.25 } = {}) {
    const wv = wave(mode, freq, ph), top = [], bot = [], N = 48;
    for (let i = 0; i <= N; i++) {
        const t = lerp(t0, t1, i / N);
        top.push(w.fan(t, val(f1v, t) + wob * wv(t)));
        bot.push(w.fan(t, Math.max(0, val(f0, t) + wob0 * wv(t))));
    }
    return fill(poly([...top, ...bot.reverse()]), color);
}

/** Veins radiate from the end of the discal cell (a loop out from the root),
 *  not from the root itself, the way real venation does. */
function veins(w, color, width, n, { converge = 0.45, cell = 0.3, to = 1.1 } = {}) {
    let s = "";
    const bend = (tt, f) => w.fan(lerp(0.5, tt, converge + (1 - converge) * Math.min(1, f)), f);
    const starts = [];
    for (let i = 0; i < n; i++) {
        const tt = lerp(0.03, 0.97, n === 1 ? 0.5 : i / (n - 1)), pts = [];
        const f0 = cell * (0.75 + 0.25 * Math.sin(Math.PI * tt));
        for (let k = 0; k <= 10; k++) pts.push(bend(tt, lerp(f0, to, k / 10)));
        starts.push(pts[0]);
        s += stroke(poly(pts, false), color, width);
    }
    const root = w.fan(0.5, 0.02);
    s += stroke(poly([root, ...starts, root], false), color, width * 0.9);
    return s;
}

function marginDots(w, color, n, f, size, { shape = "dot", t0 = 0.04, t1 = 0.96 } = {}) {
    let s = "";
    const R = size * w.L;
    for (let i = 0; i < n; i++) {
        const t = lerp(t0, t1, n === 1 ? 0.5 : i / (n - 1)), [x, y] = w.fan(t, f);
        if (shape === "lune") s += ellipse(x, y, R * 0.55, R * 1.2, w.ang(t) / DEG, color);
        else if (shape === "chevron") {
            const dt = 0.45 / n;
            s += stroke(poly([w.fan(t - dt, f + 0.035), w.fan(t, f - 0.02), w.fan(t + dt, f + 0.035)], false), color, R * 0.9);
        } else s += circle(x, y, R, color);
    }
    return s;
}

function eye(w, t, f, size, rings, { hl, squash = 1 } = {}) {
    const [x, y] = w.fan(t, f), R = size * w.L, rot = w.ang(t) / DEG;
    let s = "";
    for (const [c, k] of rings) s += ellipse(x, y, R * k, R * k * squash, rot, c);
    if (hl) s += circle(x - R * 0.14, y - R * 0.16, R * 0.1, hl);
    return s;
}

function scatter(w, r, n, sMin, sMax, { fMin = 0.18, fMax = 0.95, tMin = 0, tMax = 1, gap = 1.15 } = {}) {
    const placed = [];
    for (let tries = 0; tries < n * 14 && placed.length < n; tries++) {
        const t = range(r, tMin, tMax), f = range(r, fMin, fMax);
        const [x, y] = w.fan(t, f), rad = range(r, sMin, sMax) * w.L * (0.55 + 0.45 * f);
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) > (p.rad + rad) * gap)) placed.push({ x, y, rad, t, f });
    }
    return placed;
}
function spots(w, r, color, n, sMin, sMax, opts) {
    return scatter(w, r, n, sMin, sMax, opts).map((p) => circle(p.x, p.y, p.rad, color)).join("");
}
function blobPath(x, y, rad, r, k = 9, jit = 0.4) {
    const pts = [];
    const a0 = r() * TAU;
    for (let i = 0; i < k; i++) {
        const a = a0 + (i / k) * TAU + (r() - 0.5) * 0.4, rr2 = rad * (1 - jit / 2 + jit * r());
        pts.push([x + Math.cos(a) * rr2, y + Math.sin(a) * rr2]);
    }
    return poly(chaikin(pts, 2));
}
function blotches(w, r, color, ring, n, sMin, sMax, ringW, opts) {
    const extra = ring ? ` stroke="${ring}" stroke-width="${f1(ringW * w.L)}" stroke-linejoin="round" paint-order="stroke"` : "";
    return scatter(w, r, n, sMin, sMax, { gap: 1.05, ...opts })
        .map((p) => fill(blobPath(p.x, p.y, p.rad, r), color, extra)).join("");
}
/** Short strokes along the vein direction (tiger-moth dashes). */
function dashes(w, r, color, n, width, { fMin = 0.15, fMax = 0.98, per = [1, 3], len = [0.08, 0.2] } = {}) {
    let s = "";
    for (let i = 0; i < n; i++) {
        const t = lerp(0.04, 0.96, i / (n - 1)) + (r() - 0.5) * 0.04;
        const k = Math.round(range(r, per[0], per[1]));
        for (let j = 0; j < k; j++) {
            const a = lerp(fMin, fMax, (j + r() * 0.5) / k), b = Math.min(fMax + 0.1, a + range(r, len[0], len[1]));
            const tt = (f) => lerp(0.5, t, 0.55 + 0.45 * f);
            s += stroke(poly([w.fan(tt(a), a), w.fan(tt((a + b) / 2), (a + b) / 2), w.fan(tt(b), b)], false), color, width * w.L);
        }
    }
    return s;
}
function squiggles(w, r, colors, k, { amp = 0.04, freq = [3, 7], width = 0.03, fMin = 0.22, fMax = 0.95 } = {}) {
    let s = "";
    for (let j = 0; j < k; j++) {
        const f = lerp(fMin, fMax, k === 1 ? 0.5 : j / (k - 1)), fq = range(r, freq[0], freq[1]), ph = r();
        const pts = [];
        for (let i = 0; i <= 70; i++) {
            const t = lerp(-0.2, 1.2, i / 70);
            pts.push(w.fan(t, f + amp * Math.sin((fq * t + ph) * TAU)));
        }
        s += stroke(poly(pts, false), colors[j % colors.length], width * w.L);
    }
    return s;
}
/** Dark apex patch with a curved inner edge, optional light spots inside. */
function apex(w, r, color, spotColor, { tEnd = 0.36, fStart = 0.62, nSpots = 0 } = {}) {
    const pts = [];
    for (let i = 0; i <= 16; i++) pts.push(w.fan(lerp(-0.3, tEnd, i / 16), 3));
    const wob = range(r, 0, 0.04), ph = r();
    for (let i = 0; i <= 24; i++) {
        const u = i / 24, e = u * u * (3 - 2 * u);
        pts.push(w.fan(lerp(tEnd, -0.3, u), lerp(1.08, fStart, e) + wob * Math.sin((u * 2.5 + ph) * TAU)));
    }
    let s = fill(poly(pts), color);
    for (let i = 0; i < nSpots; i++) {
        const u = nSpots === 1 ? 0.5 : i / (nSpots - 1);
        const [x, y] = w.fan(lerp(0.05, tEnd * 0.7, u), lerp(0.9, fStart + 0.16, u) + (r() - 0.5) * 0.05);
        s += circle(x, y, range(r, 0.018, 0.03) * w.L, spotColor);
    }
    return s;
}
/** Radial wedges from the root, widening toward the margin. */
function rays(w, colors, n, width, { fMin = 0.12, fMax = 1.2 } = {}) {
    let s = "";
    for (let i = 0; i < n; i++) {
        const t = lerp(0.06, 0.94, i / (n - 1)), a = [], b = [];
        for (let k = 0; k <= 8; k++) {
            const f = lerp(fMin, fMax, k / 8), hw = width * (0.3 + f);
            a.push(w.fan(t - hw, f)); b.push(w.fan(t + hw, f));
        }
        s += fill(poly([...a, ...b.reverse()]), colors[i % colors.length]);
    }
    return s;
}
function discal(w, r, color, ground, { t = 0.5, f = 0.52, size = 0.06, kind = "crescent" } = {}) {
    const [x, y] = w.fan(t, f), R = size * w.L;
    if (kind === "dot") return circle(x, y, R * 0.7, color);
    if (kind === "ring") return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(R * 0.8)}" fill="none" stroke="${color}" stroke-width="${f1(R * 0.35)}"/>`;
    if (kind === "window") {
        const d = blobPath(x, y, R, r, 5, 0.25);
        return fill(d, ground, ` stroke="${color}" stroke-width="${f1(R * 0.3)}" paint-order="stroke"`);
    }
    const [x2, y2] = w.fan(t, f + 0.05);
    return circle(x, y, R, color) + circle(x2, y2, R * 0.78, ground);
}

/* ---------- recipes (coherent pattern stacks) --------------------------------
 * draw(fw, hw, c, r) returns { fw, hw } markup. Each wing object carries its
 * own .ground / .ink (contrasting line color) / .pale for that wing's ground.
 * `prefs` nudge color-role assignment toward what the recipe needs. */

export const RECIPES = {
    monarch: {
        label: "Veined", adj: ["Veined", "Stained-glass", "Leaded"], latin: ["venosa", "plexippa", "reticulata"],
        draw(fw, hw, c, r) {
            const vw = range(r, 0.016, 0.028), bd = range(r, 0.09, 0.15), wav = r() < 0.5, twoRows = r() < 0.55;
            const wing = (w, n) => {
                let s = veins(w, w.ink, vw * w.L, n, { converge: range(r, 0.35, 0.55) });
                s += band(w, w.ink, 1 - bd, 4, { wob: 0, wob0: wav ? 0.02 : 0, freq: n * 0.9, mode: "scallop" });
                s += marginDots(w, w.pale, n + 1, 1 - bd * 0.42, 0.017);
                if (twoRows) s += marginDots(w, w.pale, n, 1 - bd * 0.78, 0.011, { t0: 0.1, t1: 0.9 });
                return s;
            };
            let F = wing(fw, 8), H = wing(hw, 7);
            if (r() < 0.85) F += apex(fw, r, fw.ink, fw.pale, { tEnd: range(r, 0.28, 0.42), fStart: range(r, 0.55, 0.7), nSpots: Math.round(range(r, 0, 4)) });
            if (r() < 0.45) H += band(hw, hw.ink, 0, range(r, 0.14, 0.24), { wob: 0.02, freq: 3 });
            return { fw: F, hw: H };
        },
    },
    eyed: {
        label: "Eyespot", adj: ["Eyed", "Peacock", "Ringed", "Owl-eyed"], latin: ["ocellata", "argus", "pavonia", "oculata"],
        draw(fw, hw, c, r) {
            let F = "", H = "";
            const freq = range(r, 1.5, 3.5), ph = r();
            if (r() < 0.65) {
                const f0 = range(r, 0.26, 0.36);
                F += band(fw, fw.pale, f0, f0 + 0.035, { wob: 0.03, freq, ph });
                H += band(hw, hw.pale, f0, f0 + 0.035, { wob: 0.03, freq, ph });
            }
            const pm = range(r, 0.7, 0.8);
            const outer = r() < 0.6 ? mix(c.ground, c.accent2, 0.55) : null;
            if (outer) {
                F += band(fw, outer, pm + 0.04, 4, { wob: 0.02, freq, ph });
                H += band(hw, mix(c.ground2, c.accent2, 0.55), pm + 0.04, 4, { wob: 0.02, freq, ph });
            }
            F += band(fw, c.accent2, pm, pm + 0.05, { wob: 0.02, freq, ph });
            H += band(hw, c.accent2, pm, pm + 0.05, { wob: 0.02, freq, ph });
            const rings = r() < 0.5
                ? [[hw.ink, 1], [c.accent, 0.8], [hw.pale, 0.52], [hw.ink, 0.38]]
                : [[c.accent, 1], [hw.ink, 0.72], [c.accent2, 0.48]];
            const sq = range(r, 0.78, 1);
            H += eye(hw, range(r, 0.42, 0.58), range(r, 0.5, 0.58), range(r, 0.15, 0.21), rings, { hl: c.light, squash: sq });
            if (r() < 0.7) F += eye(fw, range(r, 0.45, 0.6), range(r, 0.48, 0.58), range(r, 0.07, 0.1), rings, { hl: c.light, squash: sq });
            else F += discal(fw, r, fw.ink, fw.ground, { kind: pick(r, ["crescent", "window"]), size: 0.07 });
            if (r() < 0.4) F += marginDots(fw, fw.pale, 1, 0.9, 0.025, { t0: 0.08, t1: 0.08 });
            return { fw: F, hw: H };
        },
    },
    bordered: {
        label: "Bordered", adj: ["Bordered", "Edged", "Lace-edged", "Hemmed"], latin: ["marginata", "limbata", "cincta"],
        draw(fw, hw, c, r) {
            const bd = range(r, 0.12, 0.22), mode = r() < 0.5 ? "scallop" : "sin", wob = range(r, 0, 0.03);
            const vein = r() < 0.7, edge = r() < 0.5, dotShape = pick(r, ["dot", "lune"]), dotInk = r() < 0.5;
            const wing = (w, n) => {
                let s = vein ? veins(w, mix(w.ground, w.pale, 0.6), range(r, 0.01, 0.018) * w.L, n) : "";
                const opts = { wob0: wob, wob: 0, freq: n * 0.8, mode };
                if (edge) s += band(w, w.ink, 1 - bd - 0.03, 4, opts);
                s += band(w, c.accent, 1 - bd, 4, opts);
                s += marginDots(w, dotInk ? w.ink : w.pale, n, 1 - bd * 0.5, bd * 0.16, { shape: dotShape });
                return s;
            };
            let F = wing(fw, 8), H = wing(hw, 7);
            if (r() < 0.55) F += dashes(fw, r, fw.ink, 5, 0.03, { fMin: 0.25, fMax: 0.75, per: [1, 2] });
            if (r() < 0.5) H += spots(hw, r, hw.ink, Math.round(range(r, 3, 7)), 0.03, 0.05, { fMin: 0.3, fMax: 0.72 });
            return { fw: F, hw: H };
        },
    },
    twotone: {
        label: "Two-tone", adj: ["Dipped", "Dusky", "Half-dipped", "Twilight"], latin: ["bicolor", "dimidiata", "crepuscula"],
        draw(fw, hw, c, r) {
            const split = range(r, 0.38, 0.58), wob = range(r, 0.02, 0.06), freq = range(r, 1.5, 4), ph = r();
            const tone = (w) => (c.accent === w.ground ? c.accent2 : c.accent);
            const wing = (w) => band(w, tone(w), 0, split, { wob, freq, ph }) + band(w, w.pale, split, split + 0.028, { wob, freq, ph });
            let F = wing(fw), H = wing(hw);
            const sub = range(r, 0.8, 0.88);
            F += band(fw, fw.ink, sub, sub + 0.02, { wob: 0.015, freq: 7, mode: "zig" });
            if (r() < 0.5) H += eye(hw, 0.5, range(r, 0.6, 0.7), 0.1, [[hw.ink, 1], [c.accent2, 0.65], [hw.pale, 0.3]]);
            else H += marginDots(hw, hw.ink, 7, 0.86, 0.022);
            if (r() < 0.5) F += discal(fw, r, fw.ink, fw.ground, { kind: "dot", f: split + 0.15 });
            return { fw: F, hw: H };
        },
    },
    banded: {
        label: "Banded", adj: ["Banded", "Barred", "Wave-lined", "Sashed"], latin: ["fasciata", "zonata", "undulata"],
        draw(fw, hw, c, r) {
            const k = 2 + (r() < 0.5 ? 1 : 0), mode = pick(r, ["sin", "zig", "scallop"]), edged = r() < 0.6;
            const cols = [c.accent, c.accent2, c.dark === c.ground ? c.light : c.dark].filter((x) => x !== c.ground);
            let F = "", H = "";
            for (let i = 0; i < k; i++) {
                const f0 = lerp(0.24, 0.76, i / (k - 1)) + (r() - 0.5) * 0.06, bw = range(r, 0.05, 0.11);
                const o = { wob: range(r, 0.015, 0.04), freq: range(r, 2, 6), ph: r(), mode };
                const col = cols[i % cols.length];
                for (const w of [fw, hw]) {
                    let s = "";
                    if (edged) s += band(w, w.pale, f0 - 0.022, f0 + bw + 0.022, o);
                    s += band(w, col, f0, f0 + bw, o);
                    if (w === fw) F += s; else H += s;
                }
            }
            const chev = r() < 0.5;
            F += marginDots(fw, fw.ink, 9, 0.93, 0.018, { shape: chev ? "chevron" : "dot" });
            H += marginDots(hw, hw.ink, 8, 0.92, 0.02, { shape: chev ? "chevron" : "dot" });
            if (r() < 0.6) F += discal(fw, r, fw.ink, fw.ground, { kind: pick(r, ["dot", "ring", "crescent"]), f: 0.5, size: 0.05 });
            return { fw: F, hw: H };
        },
    },
    spotted: {
        label: "Spotted", adj: ["Spotted", "Dappled", "Pearl-spotted", "Clouded"], latin: ["punctata", "guttata", "maculosa"],
        draw(fw, hw, c, r) {
            const clusters = r() < 0.6;
            const wing = (w, n) => {
                if (!clusters) return spots(w, r, r() < 0.5 ? c.accent : w.pale, n + 4, 0.025, 0.05, { fMin: 0.25 });
                // pale clouds with ink freckles inside
                return scatter(w, r, n, 0.07, 0.12, { fMin: 0.3, fMax: 0.9, gap: 0.95 }).map((p) => {
                    let s = fill(blobPath(p.x, p.y, p.rad, r, 8, 0.5), c.accent === w.ground ? w.pale : c.accent);
                    const k = 2 + Math.floor(r() * 3);
                    for (let i = 0; i < k; i++) {
                        const a = r() * TAU, d = r() * p.rad * 0.5;
                        s += circle(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, p.rad * range(r, 0.14, 0.24), w.ink);
                    }
                    return s;
                }).join("");
            };
            let F = wing(fw, 7), H = wing(hw, 6);
            if (r() < 0.5) {
                F += band(fw, fw.ink, 0.95, 4); H += band(hw, hw.ink, 0.94, 4);
            }
            return { fw: F, hw: H };
        },
    },
    tip: {
        label: "Tipped", adj: ["Tipped", "Ink-tipped", "Dipped"], latin: ["apicalis", "cardamines", "tincta"], prefs: { ground: "light" },
        draw(fw, hw, c, r) {
            let F = "", H = "";
            const orange = r() < 0.4;
            F += apex(fw, r, orange ? c.accent : fw.ink, fw.pale, { tEnd: range(r, 0.45, 0.6), fStart: range(r, 0.45, 0.6) });
            F += apex(fw, r, fw.ink, fw.pale, { tEnd: range(r, 0.22, 0.34), fStart: orange ? 0.8 : range(r, 0.62, 0.72), nSpots: orange ? 0 : Math.round(range(r, 0, 3)) });
            F += discal(fw, r, fw.ink, fw.ground, { kind: "dot", t: 0.62, f: 0.55, size: 0.05 });
            H += veins(hw, mix(hw.ground, hw.ink, 0.22), 0.012 * hw.L, 7);
            if (r() < 0.5) H += marginDots(hw, hw.ink, 7, 0.95, 0.018);
            if (r() < 0.35) H += band(hw, mix(hw.ground, c.accent2, 0.5), 0, 0.3, { wob: 0.03 });
            return { fw: F, hw: H };
        },
    },
    morpho: {
        label: "Shining", adj: ["Shining", "Glass", "Mirror", "Iridescent"], latin: ["splendens", "nitida", "speculum"], prefs: { ground: "vivid", ground2: "same" },
        draw(fw, hw, c, r) {
            const sheen = mix(c.ground, c.light, range(r, 0.2, 0.35));
            const wing = (w, n, bd) => {
                let s = band(w, sheen, 0, range(r, 0.3, 0.45), { wob: 0.05, freq: 1.5, ph: r() });
                s += veins(w, mix(w.ground, w.ink, 0.35), 0.008 * w.L, n);
                s += band(w, w.ink, 1 - bd, 4, { wob0: 0.02, wob: 0, freq: n, mode: "scallop" });
                return s;
            };
            let F = wing(fw, 8, range(r, 0.2, 0.3)), H = wing(hw, 7, range(r, 0.08, 0.14));
            F += marginDots(fw, fw.pale, 4, 0.86, 0.02, { t0: 0.08, t1: 0.4 });
            H += marginDots(hw, hw.pale, 7, 0.95, 0.012);
            return { fw: F, hw: H };
        },
    },
    tiger: {
        label: "Blotched", adj: ["Blotched", "Garden", "Leopard", "Harlequin"], latin: ["caja", "maculata", "tigrina"], prefs: { ground2: "vivid" },
        draw(fw, hw, c, r) {
            let F = "";
            if (r() < 0.55) {
                F += blotches(fw, r, fw.ink, r() < 0.6 ? fw.pale : c.accent, Math.round(range(r, 7, 12)), 0.09, 0.15, 0.03, { fMin: 0.2, fMax: 0.95 });
            } else {
                F += dashes(fw, r, fw.ink, Math.round(range(r, 5, 7)), range(r, 0.06, 0.09), { per: [2, 3], len: [0.12, 0.24] });
                F += spots(fw, r, r() < 0.5 ? fw.pale : c.accent, Math.round(range(r, 4, 9)), 0.02, 0.04);
            }
            let H = spots(hw, r, hw.ink, Math.round(range(r, 3, 6)), 0.05, 0.09, { fMin: 0.35, fMax: 0.9 });
            if (r() < 0.5) H += band(hw, hw.ink, 0.9, 4, { wob0: 0.03, freq: 5, mode: "scallop" });
            return { fw: F, hw: H };
        },
    },
    ermine: {
        label: "Speckled", adj: ["Speckled", "Ermine", "Pepper-dot", "Freckled"], latin: ["lubricipeda", "conspersa", "sparsa"], prefs: { ground: "light", body: "accent" },
        draw(fw, hw, c, r) {
            const vein = r() < 0.5;
            const wing = (w, n) => {
                let s = vein ? veins(w, mix(w.ground, w.ink, 0.18), 0.01 * w.L, 8) : "";
                s += spots(w, r, w.ink, n, 0.012, 0.028, { fMin: 0.12, fMax: 0.98, gap: 1.6 });
                return s;
            };
            let F = wing(fw, Math.round(range(r, 14, 26))), H = wing(hw, Math.round(range(r, 4, 10)));
            if (r() < 0.4) H = band(hw, c.accent, 0, range(r, 0.3, 0.5), { wob: 0.04 }) + H;
            return { fw: F, hw: H };
        },
    },
    squiggle: {
        label: "Scribbled", adj: ["Scribbled", "Marbled", "Labyrinth", "Vermiculate"], latin: ["marmorata", "vermiculata", "labyrinthica"],
        draw(fw, hw, c, r) {
            const k = Math.round(range(r, 4, 6)), amp = range(r, 0.025, 0.05), width = range(r, 0.025, 0.04);
            const wing = (w) => squiggles(w, r, [c.accent === w.ground ? c.accent2 : c.accent, w.pale], k, { amp, width });
            let F = wing(fw), H = wing(hw);
            if (r() < 0.45) { F += band(fw, fw.ink, 0.95, 4); H += band(hw, hw.ink, 0.94, 4); }
            return { fw: F, hw: H };
        },
    },
    dashes: {
        label: "Streaked", adj: ["Streaked", "Dashed", "Pinstriped"], latin: ["striata", "lineata", "virgata"],
        draw(fw, hw, c, r) {
            let F = veins(fw, mix(fw.ground, fw.ink, 0.25), 0.01 * fw.L, 9);
            F += dashes(fw, r, fw.ink, Math.round(range(r, 6, 9)), range(r, 0.02, 0.035), { per: [2, 4], len: [0.05, 0.14] });
            if (r() < 0.5) F += spots(fw, r, c.accent, 5, 0.015, 0.03);
            let H = veins(hw, mix(hw.ground, hw.ink, 0.2), 0.01 * hw.L, 7);
            if (r() < 0.6) H += dashes(hw, r, hw.ink, 5, 0.025, { fMin: 0.5, per: [1, 2] });
            return { fw: F, hw: H };
        },
    },
    rays: {
        label: "Rayed", adj: ["Rayed", "Sunburst", "Striped"], latin: ["radiata", "nerii", "elpenor"], prefs: { ground2: "vivid" },
        draw(fw, hw, c, r) {
            const n = Math.round(range(r, 5, 8));
            let F = rays(fw, [fw.pale, c.accent2], n, range(r, 0.012, 0.025));
            const a = range(r, 0.85, 0.95), b = range(r, 0.3, 0.45), bw = range(r, 0.07, 0.12);
            F += band(fw, fw.ink, (t) => lerp(a, b, t), (t) => lerp(a, b, t) + bw, { wob: 0.01, freq: 4 });
            F += band(fw, c.accent, 0, 0.14, { wob: 0.02 });
            let H = band(hw, hw.ink, 0, range(r, 0.25, 0.4), { wob: 0.03, freq: 2 });
            H += band(hw, hw.ink, range(r, 0.82, 0.9), 4, { wob0: 0.02, freq: 6 });
            return { fw: F, hw: H };
        },
    },
};

/* ---------- colors → roles --------------------------------------------------- */

function assignColors(paletteKey, recipeKey, r) {
    const cols = [...(PALETTES[paletteKey] || PALETTES.sorbet).colors].sort((a, b) => lum(a) - lum(b));
    const dark = cols[0], light = cols[cols.length - 1], mids = cols.slice(1, -1);
    const prefs = RECIPES[recipeKey]?.prefs || {};
    const byVivid = [...mids].sort((a, b) => vividness(b) - vividness(a));

    let ground = pick(r, mids);
    if (prefs.ground === "light") ground = r() < 0.7 ? light : cols[cols.length - 2];
    else if (prefs.ground === "vivid") ground = byVivid[Math.floor(r() * 2)];
    else if (r() < 0.1) ground = light;
    else if (r() < 0.06) ground = dark;

    let ground2;
    if (prefs.ground2 === "same") ground2 = ground;
    else if (prefs.ground2 === "vivid") ground2 = byVivid.find((x) => x !== ground) || ground;
    else ground2 = r() < 0.45 ? ground : pick(r, cols.filter((x) => x !== ground && x !== dark));

    const byContrast = cols.filter((x) => x !== ground && x !== ground2 && x !== dark && x !== light)
        .sort((a, b) => contrast(b, ground) + hueGap(b, ground) - (contrast(a, ground) + hueGap(a, ground)));
    const accent = byContrast[Math.floor(r() * Math.min(2, byContrast.length))] || cols.find((x) => x !== ground) || light;
    const rest = cols.filter((x) => x !== ground && x !== accent && x !== dark);
    const accent2 = pick(r, rest.length ? rest : [light]);

    let body = r() < 0.55 ? dark : pick(r, [ground, accent, ground2]);
    if (prefs.body === "accent") body = accent;
    return { ground, ground2, accent, accent2, dark, light, body };
}
function hueGap(a, b) {
    const d = Math.abs(hsl(a)[0] - hsl(b)[0]);
    return (Math.min(d, 360 - d) / 180) * 2;
}

/* ---------- resolve --------------------------------------------------------- */

/** Fill in every field of a spec. Anything given is kept; the rest is derived
 *  from `seed`, so the same input always resolves to the same specimen. */
export function specimen(input = {}) {
    const seed = (input.seed ?? randomSeed()) >>> 0;
    const r = mulberry32(seed);
    const familyWeights = Object.fromEntries(Object.entries(FAMILIES).map(([k, f]) => [k, f.weight]));
    const family = FAMILIES[input.family] ? input.family : weighted(r, familyWeights);
    const recipe = RECIPES[input.recipe] ? input.recipe : weighted(mulberry32(mixSeed(seed, 11)), FAMILIES[family].recipes);
    const palette = PALETTES[input.palette] || input.palette === "custom" ? input.palette : pick(mulberry32(mixSeed(seed, 12)), Object.keys(PALETTES));
    const shapeSeed = input.shapeSeed ?? mixSeed(seed, 1);
    const patternSeed = input.patternSeed ?? mixSeed(seed, 2);
    const colorSeed = input.colorSeed ?? mixSeed(seed, 3);
    const colors = input.colors ? { ...input.colors } : assignColors(palette, recipe, mulberry32(colorSeed));
    const size = input.size ?? Math.round(range(mulberry32(mixSeed(seed, 13)), 0.86, 1.06) * 100) / 100;
    return { seed, family, recipe, palette, colors, shapeSeed, patternSeed, colorSeed, size };
}

/** Re-derive colors for a palette (used when the palette or color dice change). */
export function paletteColors(spec, paletteKey = spec.palette, colorSeed = spec.colorSeed) {
    return assignColors(paletteKey, spec.recipe, mulberry32(colorSeed));
}

/* ---------- body ------------------------------------------------------------ */

function drawBody(fam, c, r, S) {
    const b = fam.body;
    const thW = b.thW, thH = b.thH, abLen = rr(r, b.abLen), abW = b.abW, headR = b.headR;
    const antenna = pick(r, b.antenna), antLen = rr(r, b.antLen), spread = rr(r, b.antSpread);
    const ink = contrast(c.body, c.dark) < 1.6 ? mix(c.dark, c.light, 0.25) : c.dark;
    const thorax = b.fuzzy ? pick(r, [c.body, c.ground, c.accent]) : c.body;
    let s = "";

    // antennae
    const baseY = -thH - headR * 1.4;
    const antCol = b.fuzzy ? ink : c.body === c.light ? c.dark : c.body;
    for (const side of [1, -1]) {
        const p0 = [side * headR * 0.45, baseY], p2 = [side * spread, baseY - antLen], p1 = [side * spread * 0.15, baseY - antLen * 0.75];
        const pts = quad(p0, p1, p2, 14);
        if (antenna === "club") {
            s += stroke(poly(pts, false), antCol, 0.9);
            s += ellipse(p2[0], p2[1], 1.3, 2.3, (Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) / DEG) + 90, antCol);
        } else if (antenna === "feather") {
            const combW = range(r, 2.6, 3.8);
            for (let i = 2; i < pts.length - 1; i++) {
                const [x, y] = pts[i], [nx, ny] = pts[i + 1];
                const dx = nx - x, dy = ny - y, len = Math.hypot(dx, dy) || 1;
                const k = combW * Math.sin(Math.PI * (i / (pts.length - 1))) ** 0.8;
                const px = (-dy / len) * k, py = (dx / len) * k, bx = (dx / len) * k * 0.6, by = (dy / len) * k * 0.6;
                s += stroke(`M${f1(x + px + bx)} ${f1(y + py + by)}L${f1(x)} ${f1(y)}L${f1(x - px + bx)} ${f1(y - py + by)}`, antCol, 0.55);
            }
            s += stroke(poly(pts, false), antCol, 0.8);
        } else {
            const curl = [p2[0] + side * 3, p2[1] + 2.5];
            s += stroke(poly([...pts, curl], false), antCol, 0.8);
        }
    }

    // abdomen: tapered, slightly bulging then pointed
    const top = thH * 0.5, right = [], left = [];
    for (let i = 0; i <= 12; i++) {
        const u = i / 12, y = top + u * abLen;
        const w = abW * (u < 0.18 ? lerp(0.8, 1, u / 0.18) : Math.pow(Math.max(0, 1 - (u - 0.18) / 0.82), 0.65) * 0.9 + 0.1);
        right.push([w, y]); left.push([-w, y]);
    }
    const abd = poly(chaikin([...right, ...left.reverse()], 2));
    const abCol = b.fuzzy ? pick(r, [c.body, c.ground2, c.accent]) : c.body;
    s += fill(abd, abCol);
    if (b.fuzzy && r() < 0.65) {
        const n = Math.round(range(r, 4, 7)), sc = abCol === ink ? c.accent : ink;
        let st = "";
        for (let i = 1; i <= n; i++) {
            const u = i / (n + 1), y = top + u * abLen;
            const w = abW * (Math.pow(Math.max(0, 1 - Math.max(0, u - 0.18) / 0.82), 0.65) * 0.9 + 0.1);
            st += `M${f1(-w)} ${f1(y)}L${f1(w)} ${f1(y)}`;
        }
        s += `<path d="${st}" stroke="${sc}" stroke-width="${f1(abLen / (n * 3.2))}" stroke-linecap="round" clip-path="url(#${S}-ab)"/>`;
        s = `<defs><clipPath id="${S}-ab"><path d="${abd}"/></clipPath></defs>` + s;
    }

    // thorax + head
    s += ellipse(0, 0, thW, thH, 0, thorax);
    if (b.fuzzy && r() < 0.6) s += ellipse(0, -thH * 0.55, thW * 0.8, thH * 0.35, 0, thorax === c.accent ? ink : c.accent);
    s += circle(0, -thH - headR * 0.55, headR, b.fuzzy ? pick(r, [thorax, ink]) : c.body);
    return { svg: s, top: baseY - antLen - 3, bottom: top + abLen };
}

/* ---------- render ---------------------------------------------------------- */

let uid = 0;
/** Box (specimen units) for fit: "plate" — tiles should use this aspect. */
export const PLATE = { w: 220, h: 185 };

function build(spec) {
    const fam = FAMILIES[spec.family] || FAMILIES.brushfoot;
    const sr = mulberry32(spec.shapeSeed), pr = mulberry32(spec.patternSeed);
    const c = spec.colors;
    const fwo = resolveWing(fam.fw, sr, true), hwo = resolveWing(fam.hw, sr, false);
    const fw = makeWing(fwo), hw = makeWing(hwo);
    const inkFor = (g) => (contrast(g, c.dark) >= contrast(g, c.light) ? c.dark : c.light);
    const paleFor = (g) => (inkFor(g) === c.dark ? (contrast(c.light, g) > 1.25 ? c.light : mix(g, "#ffffff", 0.6)) : mix(g, c.dark, 0.55));
    fw.ground = c.ground; fw.ink = inkFor(c.ground); fw.pale = paleFor(c.ground);
    hw.ground = c.ground2; hw.ink = inkFor(c.ground2); hw.pale = paleFor(c.ground2);

    const recipe = RECIPES[spec.recipe] || RECIPES.bordered;
    const layers = recipe.draw(fw, hw, c, pr);

    // shared finishing touches
    if (fam.moth && pr() < 0.5) {
        const hair = mix(c.body, c.ground, 0.35), e = range(pr, 0.1, 0.2);
        layers.fw += band(fw, hair, 0, e, { wob: 0.03, freq: 3 });
        layers.hw += band(hw, mix(c.body, c.ground2, 0.35), 0, e + 0.04, { wob: 0.03, freq: 3 });
    }
    let outline = pr() < 0.32 ? { color: pr() < 0.6 ? fw.ink : c.accent, w: range(pr, 0.012, 0.022) } : null;
    if (!outline && (lum(c.ground) > 0.72 || lum(c.ground2) > 0.72)) outline = { color: mix(c.ground, c.dark, 0.3), w: 0.009 };
    return { fam, fw, hw, layers, outline };
}

/**
 * Render a spec to an SVG string.
 *   fit: "tight" (default) crops to the specimen; "plate" uses a fixed box so
 *        specimens keep their relative sizes side by side.
 *   background: CSS color, or omit for transparent.
 *   padding: extra room around a tight fit (specimen units).
 */
export function specimenSVG(spec, { fit = "tight", background, padding = 8, className = "" } = {}) {
    const g = build(spec);
    const S = "mo" + (uid++).toString(36);
    const body = drawBody(g.fam, spec.colors, mulberry32(mixSeed(spec.shapeSeed, 7)), S);
    const { fw, hw, layers, outline } = g;

    const wing = (w, id, ground, pat) =>
        `<path d="${w.d}" fill="${ground}"/><g clip-path="url(#${S}-${id})">${pat}</g>` +
        (outline ? `<path d="${w.d}" fill="none" stroke="${outline.color}" stroke-width="${f1(outline.w * w.L)}" stroke-linejoin="round"/>` : "");
    const side = `<g class="wing">${wing(hw, "hw", hw.ground, layers.hw)}${wing(fw, "fw", fw.ground, layers.fw)}</g>`;

    const k = spec.size || 1;
    const xMax = Math.max(fw.bounds.maxX, hw.bounds.maxX) * k;
    const yMin = Math.min(fw.bounds.minY, hw.bounds.minY, body.top) * k;
    const yMax = Math.max(fw.bounds.maxY, hw.bounds.maxY, body.bottom) * k;
    let vb;
    if (fit === "plate") {
        // Fixed scale so sizes compare; grow (keeping aspect) only if it doesn't fit.
        const s = Math.max(1, (xMax * 2 + 16) / PLATE.w, (yMax - yMin + 16) / PLATE.h);
        const w = PLATE.w * s, h = PLATE.h * s;
        vb = [-w / 2, (yMin + yMax) / 2 - h / 2, w, h];
    } else {
        vb = [-xMax - padding, yMin - padding, (xMax + padding) * 2, yMax - yMin + padding * 2];
    }
    vb = vb.map(f1);
    const bg = background ? `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${background}"/>` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}"${className ? ` class="${className}"` : ""}>` +
        `<defs><clipPath id="${S}-fw"><path d="${fw.d}"/></clipPath><clipPath id="${S}-hw"><path d="${hw.d}"/></clipPath></defs>` +
        bg +
        `<g transform="scale(${k})">` +
        `<g class="side side-r">${side}</g>` +
        `<g transform="scale(-1 1)"><g class="side side-l">${side}</g></g>` +
        `<g class="body">${body.svg}</g>` +
        `</g></svg>`;
}

/* ---------- names ------------------------------------------------------------ */

function colorWord(hex, r) {
    const [h, s, l] = hsl(hex);
    if (s < 0.14 || (l > 0.9 && s < 0.5)) return l > 0.8 ? pick(r, ["Ivory", "Pearl", "Chalk"]) : l < 0.25 ? pick(r, ["Sable", "Ink", "Charcoal"]) : pick(r, ["Ash", "Dove", "Pewter"]);
    const light = l > 0.72, dark = l < 0.3;
    const bands = [
        [12, ["Scarlet", "Cinnabar", "Crimson"], ["Rose", "Blush"], ["Oxblood", "Garnet"]],
        [38, ["Coral", "Persimmon", "Tangerine"], ["Peach", "Apricot"], ["Rust", "Umber"]],
        [55, ["Marigold", "Saffron", "Ochre"], ["Butter", "Cream"], ["Bronze", "Tawny"]],
        [75, ["Sulphur", "Citron"], ["Primrose", "Lemon"], ["Olive"]],
        [160, ["Moss", "Jade", "Fern"], ["Mint", "Celadon"], ["Forest", "Pine"]],
        [200, ["Teal", "Lagoon"], ["Seafoam", "Aqua"], ["Deep-sea", "Spruce"]],
        [250, ["Cobalt", "Azure", "Cornflower"], ["Sky", "Powder"], ["Indigo", "Midnight"]],
        [290, ["Violet", "Iris"], ["Lilac", "Wisteria"], ["Aubergine"]],
        [340, ["Fuchsia", "Orchid"], ["Pink", "Blossom"], ["Plum", "Mulberry"]],
        [361, ["Raspberry", "Rose"], ["Blush", "Shell"], ["Claret", "Wine"]],
    ];
    const band = bands.find(([max]) => h < max);
    return pick(r, light ? band[2] : dark ? band[3] : band[1]);
}
function colorLatin(hex, r) {
    const [h, s, l] = hsl(hex);
    if (s < 0.14) return l > 0.75 ? pick(r, ["alba", "lactea", "nivea"]) : l < 0.3 ? pick(r, ["nigra", "atra"]) : "cinerea";
    if (h < 15 || h >= 345) return pick(r, ["rubra", "sanguinea", "coccinea"]);
    if (h < 40) return l > 0.7 ? "rosacea" : pick(r, ["aurantia", "fulva"]);
    if (h < 70) return pick(r, ["flava", "lutea", "aurea"]);
    if (h < 165) return pick(r, ["viridis", "prasina"]);
    if (h < 250) return pick(r, ["caerulea", "cyanea", "thalassina"]);
    if (h < 295) return pick(r, ["violacea", "ianthina"]);
    return pick(r, ["rosea", "purpurea"]);
}

/** Common + Latin name, derived from the spec (so they follow color edits). */
export function describe(spec) {
    const r = mulberry32(mixSeed(spec.seed, 21));
    const fam = FAMILIES[spec.family] || FAMILIES.brushfoot;
    const rec = RECIPES[spec.recipe] || RECIPES.bordered;
    const col = colorWord(spec.colors.ground, r), adj = pick(r, rec.adj), noun = pick(r, fam.nouns);
    const forms = [`${col} ${noun}`, `${adj} ${noun}`, `${col}-${adj.toLowerCase()} ${noun}`, `${adj} ${col} ${noun}`];
    const name = pick(r, forms);
    const genus = pick(r, fam.genus) + pick(r, ["a", "ia", "ina", "ops", "odes", "ura", "phora", "ptera", "morpha", "is"]);
    const species = r() < 0.5 ? colorLatin(spec.colors.ground, r) : pick(r, rec.latin);
    return { name, latin: `${genus} ${species}` };
}
