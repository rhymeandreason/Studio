// Brand icons for recognizable link targets — returns inline SVG markup so it
// stays offline (no favicon fetches, per the vendored/offline rule). Currently
// covers Google Workspace products, whose doc/sheet/slide/folder names aren't
// in the URL, so the product glyph is the only at-a-glance cue. Reusable: any
// list of URLs (Workspace cards today) can call brandIconFor(url).

// Official Google Drive mark (the tri-fold tricolor triangle).
const DRIVE = `<svg viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
<path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
<path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
<path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
<path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.3c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
<path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
<path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
</svg>`;

// Docs/Sheets/Slides share a folded-corner page; only the color + inner marks
// differ. Build them from one template to keep the set tidy.
function page(body, corner, inner) {
  return `<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
<path fill="${body}" d="M5 1.5h6l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z"/>
<path fill="${corner}" d="M11 1.5l4 4h-4z"/>${inner}</svg>`;
}

const DOCS = page(
  "#4285f4",
  "#a1c2fa",
  `<g fill="#fff"><rect x="6" y="8" width="7" height="1" rx="0.4"/><rect x="6" y="10.3" width="7" height="1" rx="0.4"/><rect x="6" y="12.6" width="5" height="1" rx="0.4"/></g>`,
);

const SHEETS = page(
  "#0f9d58",
  "#87ceac",
  `<rect x="6" y="8.3" width="8" height="5.8" rx="0.3" fill="#fff"/>
<g fill="#0f9d58"><rect x="6" y="10.1" width="8" height="0.7"/><rect x="6" y="11.9" width="8" height="0.7"/><rect x="9.6" y="8.3" width="0.7" height="5.8"/></g>`,
);

const SLIDES = page(
  "#f4b400",
  "#fada80",
  `<rect x="6.3" y="9" width="7.4" height="5" rx="0.6" fill="#fff"/>`,
);

// Map a URL to its brand SVG, or "" when there's no match.
export function brandIconFor(url) {
  let host = "";
  let path = "";
  try {
    const u = new URL(url.trim());
    host = u.hostname;
    path = u.pathname;
  } catch {
    return "";
  }
  if (host === "docs.google.com") {
    if (path.startsWith("/document")) return DOCS;
    if (path.startsWith("/spreadsheets")) return SHEETS;
    if (path.startsWith("/presentation")) return SLIDES;
    // Other docs.google.com paths (forms, drawings) fall back to Drive.
    return DRIVE;
  }
  if (host === "sheets.google.com") return SHEETS;
  if (host === "slides.google.com") return SLIDES;
  if (host === "drive.google.com") return DRIVE;
  return "";
}
