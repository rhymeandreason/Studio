// Image geometry and utility helpers (pure; no shared mutable state).

// Width/height of an image source (HTMLImageElement or canvas).
export function srcW(s) {
  return s.naturalWidth || s.width;
}
export function srcH(s) {
  return s.naturalHeight || s.height;
}

// Load an image from a URL, returning a Promise<HTMLImageElement>.
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// A downscaled copy of `img` (longest side ≤ max) for fast preview rendering.
// Returns the image itself when it's already small enough. Derived from the
// clean data-URL image, so it stays WebGL/export-safe.
export function makePreview(img, max = 2048) {
  const w = srcW(img);
  const h = srcH(img);
  const scale = Math.min(1, max / Math.max(w, h));
  if (scale === 1) return img;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Minimum uniform scale so rotating a w×h frame by `deg` leaves no empty corners.
export function coverScale(w, h, deg) {
  const r = (Math.abs(deg) * Math.PI) / 180;
  if (!r) return 1;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return Math.max((w * cos + h * sin) / w, (w * sin + h * cos) / h);
}

// Render the oriented (rotate + flip + straighten) image (HTMLImageElement or
// canvas) at its source resolution.
export function renderOriented(img, edits) {
  const iw = srcW(img);
  const ih = srcH(img);
  const rot = (((edits.rotate || 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const ow = swap ? ih : iw;
  const oh = swap ? iw : ih;

  const canvas = document.createElement("canvas");
  canvas.width = ow;
  canvas.height = oh;
  const ctx = canvas.getContext("2d");

  // Straighten: rotate around center, scaled to cover the frame.
  const sdeg = edits.straighten || 0;
  if (sdeg) {
    const s = coverScale(ow, oh, sdeg);
    ctx.translate(ow / 2, oh / 2);
    ctx.rotate((sdeg * Math.PI) / 180);
    ctx.scale(s, s);
    ctx.translate(-ow / 2, -oh / 2);
  }
  // Orientation: 90° rotation + flips, image drawn centered.
  ctx.translate(ow / 2, oh / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(edits.flipH ? -1 : 1, edits.flipV ? -1 : 1);
  ctx.drawImage(img, -iw / 2, -ih / 2);

  return canvas;
}

// Default edit state (no adjustments applied).
export function defaultEdits() {
  return {
    version: 1,
    rotate: 0,
    flipH: false,
    flipV: false,
    straighten: 0,
    crop: null, // { x, y, w, h } as fractions of the oriented image; null = full
    cropAspect: null, // width/height ratio for locked resizing; null = free
    // Tonal adjustments, each -100..100 (0 = no change).
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    highlights: 0,
    shadows: 0,
  };
}
