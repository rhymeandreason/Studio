// GET /api/qr?t=<treeId>  — SVG QR code of the intake link for that tree.
import QRCode from "qrcode";

export default async function handler(req, res) {
  try {
    const t = String(req.query.t || "").trim();
    if (!t) return res.status(400).json({ error: "missing t" });
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${proto}://${host}/?t=${encodeURIComponent(t)}`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 320 });
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send(svg);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
