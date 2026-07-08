// GET /api/pull?tree=<treeId>[&peek=1]
//   Default: returns the tree's submissions AND clears them (consume) — the
//   Studio tool has now taken ownership. Pass peek=1 to read without clearing
//   (used by the live /inbox viewer).
import { listSubmissions, clearSubmissions } from "../lib/store.js";

export default async function handler(req, res) {
  try {
    const treeId = String(req.query.tree || "").trim();
    if (!treeId) return res.status(400).json({ error: "missing tree" });
    const subs = await listSubmissions(treeId);
    if (req.query.peek !== "1" && subs.length) await clearSubmissions(treeId);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(subs);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
