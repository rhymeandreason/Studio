// Shared presentation slide renderer.
//
// Builds a 1280×720 `.slide` element for a slide + theme. Pure: image refs are
// looked up in the `resolved` map ({ projectRelPath|dataURL → url }) the caller
// provides — no I/O here. Consumers must:
//   • load `window.marked` (vendored marked.min.js) for markdown bodies, and
//   • link `deck/render.css` so the `.slide` styles apply.
//
// Used by the Slides editor, the Theme editor, and the Artifacts panel preview.

// ⟶ TUNE ME: size multipliers for the S/M/L/XL selects. M = 1 = the theme's
//   base size (theme.headingSize / theme.bodySize); the rest scale from it.
export const HEADING_SCALES = { s: 0.7, m: 1, l: 1.5, xl: 2 };
export const BODY_SCALES    = { s: 0.8, m: 1, l: 1.2 };

// Default heading size level per layout (overridable per slide via headingSize).
export const HEADING_DEFAULT = {
  "title": "l", "section": "l", "title-body": "m", "two-col": "m",
  "three-col": "m", "image-text": "m", "quote": "m",
};

export const SCHEMES = ["light", "soft", "dark", "accent", "accent2"];

// Derive a slide's { bg, surface, text, muted, accent } palette from the theme's
// 6-color palette and the chosen scheme.
export function colorScheme(c, scheme) {
  // light   — the palette as-is.
  // soft    — `surface` becomes the background; panels fall back to base bg.
  // dark    — invert onto the dark `text` color: text becomes the bg, the
  //           light bg becomes the text, `muted` carries over, surface = muted
  //           as a subtle dark panel, accent stays.
  // accent  — the `accent` color fills the slide; `bg` is the text.
  // accent2 — same, with the second accent color.
  if (scheme === "soft")    return { bg: c.surface, surface: c.bg,      text: c.text, muted: c.muted,   accent: c.accent };
  if (scheme === "dark")    return { bg: c.text,    surface: c.muted,   text: c.bg,   muted: c.surface, accent: c.accent };
  if (scheme === "accent")  return { bg: c.accent,  surface: c.accent,  text: c.bg,   muted: c.bg,      accent: c.bg };
  if (scheme === "accent2") return { bg: c.accent2, surface: c.accent2, text: c.bg,   muted: c.bg,      accent: c.bg };
  return { bg: c.bg, surface: c.surface, text: c.text, muted: c.muted, accent: c.accent };
}

const md = (s) => window.marked.parse(s || "", { breaks: true });
const esc = (s) => (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function renderSlide(slide, theme, resolved = {}) {
  const t = theme;
  const el = document.createElement("div");
  el.className = "slide";
  // Per-slide color scheme; background painted on the slide root so it always
  // fills the frame.
  const scheme = slide.colorScheme || (slide.layout === "section" ? "accent" : "light");
  el.dataset.scheme = scheme;
  const pal = colorScheme(t.colors, scheme);
  el.style.setProperty("--deck-bg", pal.bg);
  el.style.setProperty("--deck-surface", pal.surface);
  el.style.setProperty("--deck-text", pal.text);
  el.style.setProperty("--deck-muted", pal.muted);
  el.style.setProperty("--deck-accent", pal.accent);
  el.style.setProperty("--deck-heading", `"${t.fonts.heading.family}", serif`);
  el.style.setProperty("--deck-heading-w", t.fonts.heading.weight);
  el.style.setProperty("--deck-body", `"${t.fonts.body.family}", sans-serif`);
  el.style.setProperty("--deck-body-w", t.fonts.body.weight);
  el.style.setProperty("--body-base", (t.bodySize || 24) + "px");
  el.style.setProperty("--body-scale", BODY_SCALES[slide.bodySize || "m"]);
  el.style.setProperty("--heading-base", (t.headingSize || 56) + "px");
  el.style.setProperty("--heading-scale", HEADING_SCALES[slide.headingSize || HEADING_DEFAULT[slide.layout] || "m"]);
  el.style.background = pal.bg;
  el.style.color = pal.text;

  const fit = slide.imageFit || "cover";
  const bodyCls = slide.listStyle === "cards" ? "deck-body cards" : "deck-body";
  const img = (ref, ph) => {
    const url = resolved[ref];
    return url ? `<img src="${url}" style="object-fit:${fit}">` : `<div class="img-placeholder">${ph}</div>`;
  };

  // data-slot tags an editable text region (used for click-to-edit on the
  // canvas); harmless on thumbnails/preview/export where it's ignored.
  let inner = "";
  switch (slide.layout) {
    case "title":
      inner = `<div class="slide__inner l-title"><h1 data-slot="title">${esc(slide.title)}</h1>${slide.subtitle?`<div class="subtitle" data-slot="subtitle">${esc(slide.subtitle)}</div>`:""}</div>`; break;
    case "section":
      { const url = resolved[slide.image];
        const bg = url ? `<img class="section-bg" src="${url}"><div class="section-scrim"></div>` : "";
        inner = `<div class="slide__inner l-section${url?' has-bg':''}">${bg}<h1 data-slot="title">${esc(slide.title)}</h1>${slide.caption?`<div class="section-cap" data-slot="caption">${esc(slide.caption)}</div>`:""}</div>`; }
      break;
    case "title-body":
      { const cols = slide.columns === 2 ? ` style="column-count:2;column-gap:56px"` : "";
        inner = `<div class="slide__inner l-title-body"><h1 data-slot="title">${esc(slide.title)}</h1><div class="${bodyCls}" data-slot="body"${cols}>${md(slide.body)}</div></div>`; }
      break;
    case "two-col":
      inner = `<div class="slide__inner l-two-col"><h1 data-slot="title">${esc(slide.title)}</h1><div class="cols"><div class="${bodyCls}" data-slot="left">${md(slide.left)}</div><div class="${bodyCls}" data-slot="right">${md(slide.right)}</div></div></div>`; break;
    case "three-col":
      inner = `<div class="slide__inner l-two-col l-three-col"><h1 data-slot="title">${esc(slide.title)}</h1><div class="cols"><div class="${bodyCls}" data-slot="left">${md(slide.left)}</div><div class="${bodyCls}" data-slot="middle">${md(slide.middle)}</div><div class="${bodyCls}" data-slot="right">${md(slide.right)}</div></div></div>`; break;
    case "quote":
      inner = `<div class="slide__inner l-quote"><blockquote data-slot="quote">${esc(slide.quote)}</blockquote>${slide.attribution?`<div class="attr">— <span data-slot="attribution">${esc(slide.attribution)}</span></div>`:""}</div>`; break;
    case "image-full":
      { const url = resolved[slide.image];
        inner = `<div class="slide__inner l-image-full" style="position:absolute;inset:0;">${url?`<img class="full-img" src="${url}" style="object-fit:${fit}">`:`<div class="img-placeholder" style="height:100%">No image</div>`}${slide.caption?`<div class="cap" data-slot="caption">${esc(slide.caption)}</div>`:""}</div>`; }
      break;
    case "image-text":
      inner = `<div class="slide__inner l-image-text"><div class="split"><div class="split-media">${img(slide.image,"No image").replace("<img","<img class=\"split-img\"")}${slide.caption?`<div class="split-cap" data-slot="caption">${esc(slide.caption)}</div>`:""}</div><div class="split-text"><h1 data-slot="title">${esc(slide.title)}</h1><div class="${bodyCls}" data-slot="body">${md(slide.body)}</div></div></div></div>`; break;
    default:
      inner = `<div class="slide__inner"><h1>${esc(slide.title||"")}</h1></div>`;
  }
  el.innerHTML = inner;
  return el;
}

// Representative slides (one per layout) for theme previews.
export const PREVIEW_SLIDES = [
  { layout: "title", title: "Presentation Title", subtitle: "A subtitle goes here" },
  { layout: "section", title: "1. A Section" },
  { layout: "title-body", title: "Title + Body", body: "Body copy with a **bold** phrase and a short list:\n\n- First point worth making\n- Second supporting point\n- A third for good measure" },
  { layout: "two-col", title: "Two Column", left: "**Left column**\n\n- Point one\n- Point two", right: "**Right column**\n\n- Point three\n- Point four" },
  { layout: "quote", quote: "A memorable line that captures the idea.", attribution: "Someone notable" },
  { layout: "image-text", title: "Image + Text", body: "Supporting copy sits beside the image, explaining what it shows." },
];
