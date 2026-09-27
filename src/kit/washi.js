// Studio kit — washi tints.
//
// Project colors are saved vivid: they read well as small swatches (the Mode
// switcher, letter avatars, accent text). Anything that fills an *area* with a
// project color — the main header, tool title bars, tinted windows, the Git
// commit card — paints washi(color) instead: the color mixed into warm paper,
// so the chrome recedes and the stickers carry the color.
//
// Same result as CSS `color-mix(in oklch, color 42%, #f4efe4)`, computed here
// so it comes back as a plain hex (usable for native window backgrounds too).

const PAPER = "#f4efe4";
const AMOUNT = 0.42; // share of the project color; the rest is paper

export function washi(color) {
    const a = hexToOklch(color);
    const b = hexToOklch(PAPER);
    if (!a) return color || "";
    // Paper is near-grey, so (as the browser does) its hue counts as powerless:
    // keep the color's hue and mix only lightness and chroma.
    return oklchToHex(
        a[0] + (b[0] - a[0]) * (1 - AMOUNT),
        a[1] + (b[1] - a[1]) * (1 - AMOUNT),
        a[2],
    );
}

// --- sRGB hex <-> OKLCH (Björn Ottosson's OKLab) ----------------------------

function hexToOklch(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
    return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function oklchToHex(L, C, H) {
    const A = C * Math.cos((H * Math.PI) / 180);
    const B = C * Math.sin((H * Math.PI) / 180);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return "#" + rgb.map((c) => Math.round(clamp(toGamma(c)) * 255).toString(16).padStart(2, "0")).join("");
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c) => Math.min(1, Math.max(0, c));
