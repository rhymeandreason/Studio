// POST /api/submit  — intake page posts a contact submission here.
// Body: { treeId, name, contacts:[{type,value,label?}], note? }
import { addSubmission } from "../lib/store.js";

const TYPES = ["phone", "email", "linkedin", "instagram", "x", "website", "other"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const treeId = String(body.treeId || "").trim();
    if (!treeId) return res.status(400).json({ error: "missing treeId" });

    const contacts = (Array.isArray(body.contacts) ? body.contacts : [])
      .map((c) => ({
        type: TYPES.includes(c.type) ? c.type : "other",
        label: typeof c.label === "string" ? c.label.slice(0, 40) : undefined,
        value: String(c.value || "").trim().slice(0, 300),
      }))
      .filter((c) => c.value);

    const name = String(body.name || "").trim().slice(0, 120);
    if (!name && !contacts.length) return res.status(400).json({ error: "empty submission" });

    const sub = {
      id: "sub_" + Math.random().toString(36).slice(2, 10),
      treeId,
      createdAt: new Date().toISOString(),
      name,
      contacts,
      note: String(body.note || "").trim().slice(0, 300),
      consumed: false,
    };
    await addSubmission(treeId, sub);
    return res.status(200).json({ ok: true, id: sub.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
