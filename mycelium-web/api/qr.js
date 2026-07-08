// GET /api/qr — SVG QR code.
//   ?t=<treeId>   → encodes the intake link for that tree (what guests scan).
//   ?url=<url>    → encodes any URL (e.g. the desktop→phone presenter handoff).
import QRCode from "qrcode";

export default async function handler(req, res) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    let url = String(req.query.url || "").trim();
    if (!url) {
      const t = String(req.query.t || "").trim();
      if (!t) return res.status(400).json({ error: "missing t or url" });
      url = `${proto}://${host}/?t=${encodeURIComponent(t)}`;
    }
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 320 });
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(svg);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
