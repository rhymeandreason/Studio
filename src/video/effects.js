// Text-effect registry for the video editor. Every effect is authored ONCE
// here and used by both the live preview and the export pipeline — export
// renders overlay frames with this exact code in the same webview, so what you
// see is what gets baked (see docs/video.md).
//
// An effect entry:
//   label   — inspector display name
//   unit    — "layer" | "word" | "char": the granularity it animates at
//   timing  — for unit effects: "stagger" (units enter with offsets) or
//             "span" (units switch on across the layer's duration; uses real
//             word timings when the layer has a matching `words` array)
//   state(u, l) — visual state of one unit. u = { i, n, lt, dur, p, on,
//             active }: p is the unit's raw 0..1 enter progress, on = its
//             window has started, active = playhead is inside its window.
//             Returns { a, dx, dy, scale, blur, fill } — dx/dy/blur in em.
//   layer(lt, dur, l) — whole-layer state ({ a, dx, dy }), also applied to
//             the background box. Optional; defaults to fully visible.
//
// Word timing: a layer may carry `words: [{ t, start, end }]` (absolute
// seconds, e.g. from a transcript). "span"-timed word effects (words,
// karaoke) and staggered word effects use those windows when the count
// matches the layer's words; otherwise timing is auto-spread.

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOutCubic = (p) => 1 - (1 - p) ** 3;
const easeOutBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};

// Shared envelope windows, all clamped so short layers still animate.
const IN = (dur) => Math.min(0.4, dur / 3); // fade/slide enter
const OUT = (dur) => Math.min(0.25, dur / 4); // shared outro fade

// Most unit effects share this layer-level outro so they don't hard-cut.
const outroFade = (lt, dur) => ({
  a: lt > dur - OUT(dur) ? clamp01((dur - lt) / OUT(dur)) : 1,
});

export const TEXT_EFFECTS = {
  none: { label: "None", unit: "layer" },

  fade: {
    label: "Fade",
    unit: "layer",
    layer(lt, dur) {
      const into = IN(dur);
      const a = lt < into ? lt / into : lt > dur - into ? clamp01((dur - lt) / into) : 1;
      return { a };
    },
  },

  slide: {
    label: "Slide",
    unit: "layer",
    layer(lt, dur, l) {
      const p = easeOutCubic(clamp01(lt / IN(dur)));
      const off = (1 - p) * 1.2; // em
      const dir = l.from || "bottom";
      return {
        a: p,
        dx: dir === "left" ? -off : dir === "right" ? off : 0,
        dy: dir === "top" ? -off : dir === "bottom" ? off : 0,
      };
    },
  },

  words: {
    label: "Words",
    unit: "word",
    timing: "span",
    state: (u) => ({ a: u.on ? 1 : 0 }),
  },

  typewriter: {
    label: "Typewriter",
    unit: "char",
    timing: "span",
    state: (u) => ({ a: u.on ? 1 : 0 }),
  },

  "word-pop": {
    label: "Word pop",
    unit: "word",
    timing: "stagger",
    layer: outroFade,
    state: (u) => ({ a: u.p, scale: 0.5 + 0.5 * easeOutBack(u.p) }),
  },

  "word-rise": {
    label: "Word rise",
    unit: "word",
    timing: "stagger",
    layer: outroFade,
    state: (u) => ({ a: easeOutCubic(u.p), dy: (1 - easeOutCubic(u.p)) * 0.6 }),
  },

  "char-cascade": {
    label: "Letter cascade",
    unit: "char",
    timing: "stagger",
    layer: outroFade,
    state: (u) => ({ a: easeOutCubic(u.p), dy: (1 - easeOutCubic(u.p)) * 0.35 }),
  },

  "blur-in": {
    label: "Blur in",
    unit: "word",
    timing: "stagger",
    layer: outroFade,
    state: (u) => ({ a: u.p, blur: (1 - u.p) * 0.18, dy: (1 - easeOutCubic(u.p)) * 0.15 }),
  },

  // Spoken-word highlight: said words solid, upcoming dim, the active word
  // pops and takes the layer's highlight color (`hi`, default warm yellow).
  karaoke: {
    label: "Karaoke",
    unit: "word",
    timing: "span",
    layer: outroFade,
    state: (u, l) =>
      u.active
        ? { a: 1, scale: 1.08, fill: l.hi || "#ffd23f" }
        : { a: u.on ? 1 : 0.45 },
  },
};

// ── Layout (measure once, draw every frame) ─────────────────────────────────
const CAP = { weight: 700, padXEm: 0.4, padYEm: 0.26, radiusEm: 0.2 };
const scratch = document.createElement("canvas").getContext("2d");
const layoutCache = new Map(); // sig -> layout

// Measure a caption at a font size: box size + per-word and per-char positions
// (x from box left, y = line vertical center from box top).
export function captionLayout(l, fontPx) {
  const family = `"${l.font || "Futura"}", "Avenir Next", system-ui, sans-serif`;
  const fontStr = `${CAP.weight} ${fontPx}px ${family}`;
  const sig = [l.text, Math.round(fontPx * 4), family].join("|");
  const hit = layoutCache.get(sig);
  if (hit) return hit;

  const ctx = scratch;
  ctx.font = fontStr;
  const lines = String(l.text ?? "").split("\n");
  const lineH = fontPx * 1.2;
  const padX = fontPx * CAP.padXEm;
  const padY = fontPx * CAP.padYEm;
  let textW = 0;
  for (const ln of lines) textW = Math.max(textW, ctx.measureText(ln || " ").width);
  const w = Math.max(1, Math.ceil(textW + padX * 2));
  const h = Math.max(1, Math.ceil(lineH * lines.length + padY * 2));

  const spaceW = ctx.measureText(" ").width;
  const words = [];
  const chars = [];
  lines.forEach((ln, li) => {
    const y = padY + lineH * (li + 0.5);
    const lineW = ctx.measureText(ln || " ").width;
    let x = (w - lineW) / 2; // centered line
    for (const word of ln.split(" ")) {
      if (word) {
        const ww = ctx.measureText(word).width;
        words.push({ text: word, x, y, w: ww });
        let cx = x;
        for (const ch of word) {
          const cw = ctx.measureText(ch).width;
          chars.push({ text: ch, x: cx, y, w: cw });
          cx += cw;
        }
        x += ww;
      }
      x += spaceW;
    }
  });

  const layout = { w, h, padX, padY, lineH, fontStr, words, chars };
  if (layoutCache.size > 120) layoutCache.clear();
  layoutCache.set(sig, layout);
  return layout;
}

// Per-unit on-windows (seconds, relative to layer start).
function unitWindows(eff, l, n, dur, unitKind) {
  if (
    unitKind === "word" &&
    Array.isArray(l.words) &&
    l.words.length === n &&
    l.words.every((w) => typeof w.start === "number")
  ) {
    const s = l.start ?? 0;
    return l.words.map((w) => [
      Math.max(0, w.start - s),
      Math.max(0, (w.end ?? w.start) - s),
    ]);
  }
  if (eff.timing === "stagger") {
    // Tight cascade: the whole group is in by half the duration at most.
    const span = Math.min(dur * 0.5, 0.08 * n + 0.001);
    return Array.from({ length: n }, (_, i) => [n > 1 ? (i / n) * span : 0, dur]);
  }
  // "span": divide the whole duration evenly.
  return Array.from({ length: n }, (_, i) => [(i / n) * dur, ((i + 1) / n) * dur]);
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const canFilter = "filter" in scratch; // canvas 2d filter (blur) support

// Draw one caption layer into a 2D context sized FW×FH. `lt` is local time in
// [0, dur]; `fontPx` is the font size in the context's pixels.
export function drawCaption(ctx, l, lt, dur, FW, FH, fontPx) {
  const eff = TEXT_EFFECTS[l.anim] || TEXT_EFFECTS.none;
  const lay = captionLayout(l, fontPx);
  const cx = (l.x ?? 0.5) * FW;
  const cy = (l.y ?? 0.85) * FH;
  const L = eff.layer ? eff.layer(lt, dur, l) : { a: 1 };
  const ga = L.a ?? 1;
  if (ga <= 0) return;

  ctx.save();
  ctx.globalAlpha = ga;
  ctx.translate(cx - lay.w / 2 + (L.dx || 0) * fontPx, cy - lay.h / 2 + (L.dy || 0) * fontPx);

  if (l.bg) {
    roundRectPath(ctx, 0, 0, lay.w, lay.h, fontPx * CAP.radiusEm);
    ctx.fillStyle = l.bg;
    ctx.fill();
  }
  ctx.font = lay.fontStr;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const baseFill = l.color || "#ffffff";

  if (eff.unit === "layer" || !eff.state) {
    ctx.fillStyle = baseFill;
    for (const u of lay.words) ctx.fillText(u.text, u.x, u.y);
    ctx.restore();
    return;
  }

  const units = eff.unit === "char" ? lay.chars : lay.words;
  const wins = unitWindows(eff, l, units.length, dur, eff.unit);
  const enter = Math.min(0.3, dur / 4); // stagger enter duration per unit
  units.forEach((u, i) => {
    const [t0, t1] = wins[i];
    const st = eff.state(
      {
        i,
        n: units.length,
        lt,
        dur,
        p: clamp01((lt - t0) / enter),
        on: lt >= t0,
        active: lt >= t0 && lt < t1,
      },
      l
    );
    const a = st?.a ?? 1;
    if (!st || a <= 0) return;
    ctx.save();
    ctx.globalAlpha = ga * Math.min(1, a);
    ctx.translate(u.x + u.w / 2 + (st.dx || 0) * fontPx, u.y + (st.dy || 0) * fontPx);
    if (st.scale && st.scale !== 1) ctx.scale(st.scale, st.scale);
    if (st.blur && canFilter) ctx.filter = `blur(${(st.blur * fontPx).toFixed(1)}px)`;
    ctx.fillStyle = st.fill || baseFill;
    ctx.fillText(u.text, -u.w / 2, 0);
    ctx.restore();
  });
  ctx.restore();
}

export function clearCaptionCache() {
  layoutCache.clear();
}
