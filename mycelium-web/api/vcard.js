// GET /api/vcard — returns your card (from /me.json) as a downloadable vCard.
// Tapping a link to this on iOS/Android opens the native "Add Contact" screen.

// Turn a stored contact value into a full URL where it makes sense.
function socialUrl(type, v) {
  const handle = v.replace(/^@/, "").trim();
  const bare = v.replace(/^https?:\/\//, "");
  switch (type) {
    case "instagram": return `https://instagram.com/${handle}`;
    case "x":         return `https://x.com/${handle}`;
    case "linkedin":  return `https://${bare}`;
    case "website":   return /^https?:\/\//.test(v) ? v : `https://${bare}`;
    default:          return v;
  }
}

// vCard escaping: backslash, comma, semicolon, newline.
const esc = (s) => String(s).replace(/([\\,;])/g, "\\$1").replace(/\n/g, "\\n");

export default async function handler(req, res) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const me = await fetch(`${proto}://${host}/me.json`).then((r) => (r.ok ? r.json() : null));
    if (!me) return res.status(404).json({ error: "no me.json" });

    const name = (me.name || "").trim();
    const [given, ...rest] = name.split(/\s+/);
    const family = rest.join(" ");

    const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${esc(family)};${esc(given || "")};;;`, `FN:${esc(name)}`];
    for (const c of me.contacts || []) {
      const v = String(c.value || "").trim();
      if (!v) continue;
      switch (c.type) {
        case "phone": lines.push(`TEL;TYPE=CELL:${esc(v)}`); break;
        case "email": lines.push(`EMAIL;TYPE=INTERNET:${esc(v)}`); break;
        case "instagram": case "x": case "linkedin":
          lines.push(`X-SOCIALPROFILE;TYPE=${c.type}:${esc(socialUrl(c.type, v))}`);
          lines.push(`URL:${esc(socialUrl(c.type, v))}`); break;
        case "website": lines.push(`URL:${esc(socialUrl(c.type, v))}`); break;
        default: lines.push(`NOTE:${esc(c.label ? c.label + ": " : "")}${esc(v)}`);
      }
    }
    lines.push("END:VCARD");

    const filename = (name || "contact").replace(/[^\w \-]/g, "") + ".vcf";
    res.setHeader("Content-Type", "text/vcard; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(lines.join("\r\n"));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
