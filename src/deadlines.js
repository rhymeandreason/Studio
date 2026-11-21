// Deadlines — opportunities (grants, open calls, residencies…) with a due date
// and a link, kept in ONE global list instead of scattered across project
// notes. Store: `~/Projects/deadlines.json` via the `deadlines` store
// (read_store / save_store). Shown in the Tasks window; captured from any
// project note's right-click menu ("Add to Deadlines"). See docs/deadlines.md.
//
// Item shape:
//   { id, title, due: "YYYY-MM-DD" | null, url, memo, project, noteId,
//     done: bool, createdAt }
// `due` is a plain local date (no time) — an opportunity closes on a day.
// `project` / `noteId` point back at the note it came from (optional).

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
// "Nov 20", "November 20th, 2026", "20 Nov", "1/20/2027", "2027-01-20".
const DATE_RES = [
  { re: new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), m: 1, d: 2, y: 3 },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}(?:,?\\s+(\\d{4}))?\\b`, "gi"), m: 2, d: 1, y: 3 },
  { re: /\b(20\d\d)-(\d\d)-(\d\d)\b/g, iso: true },
  { re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, num: true },
];
const CUE_RE = /deadline|due|apply by|closes?|by\b|submit|loi|letter of intent/i;
const URL_RE = /https?:\/\/[^\s)]+/i;

const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "YYYY-MM-DD" → local Date at midnight.
export function dueDate(due) {
  if (!due) return null;
  const [y, m, d] = due.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Whole days from today to `due` (negative = passed).
export function daysLeft(due, now = new Date()) {
  const d = dueDate(due);
  if (!d) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d - today) / 86400000);
}

/** Find a due date in free text. A date without a year takes the first
 *  occurrence on/after `ref` (when the note was written), with two weeks of
 *  slack so "June 16" written on June 20 still means this June. A date near a
 *  cue word ("deadline", "apply by"…) wins over one that isn't.
 *  Returns { due: "YYYY-MM-DD", match } or null. */
export function parseDue(text, ref = new Date()) {
  if (!text) return null;
  const hits = [];
  for (const spec of DATE_RES) {
    spec.re.lastIndex = 0;
    for (const mm of text.matchAll(spec.re)) {
      let y, m, d;
      if (spec.iso) [y, m, d] = [+mm[1], +mm[2], +mm[3]];
      else if (spec.num) [m, d, y] = [+mm[1], +mm[2], mm[3] ? +mm[3] : null];
      else {
        m = MONTHS.indexOf(mm[spec.m].slice(0, 3).toLowerCase()) + 1;
        d = +mm[spec.d];
        y = mm[spec.y] ? +mm[spec.y] : null;
      }
      if (y && y < 100) y += 2000;
      if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) continue;
      if (!y) {
        y = ref.getFullYear();
        const slack = new Date(ref.getTime() - 14 * 86400000);
        if (new Date(y, m - 1, d) < slack) y += 1;
      }
      const before = text.slice(Math.max(0, mm.index - 24), mm.index);
      const after = text.slice(mm.index, mm.index + mm[0].length + 12);
      hits.push({ due: `${y}-${pad(m)}-${pad(d)}`, match: mm[0], index: mm.index,
        cued: CUE_RE.test(before) || CUE_RE.test(after) });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (b.cued - a.cued) || (a.index - b.index));
  return hits[0];
}

/** A deadline item seeded from a project note (title, link, parsed date). The
 *  caller saves it — or opens it for editing first. */
export function deadlineFromNote(note, project = "") {
  const body = note.body || "";
  const text = `${note.title || ""}\n${body}`;
  const ref = note.createdAt ? new Date(note.createdAt) : new Date();
  const hit = parseDue(text, ref);
  const firstLine = (s) => (s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  let title = firstLine(note.title) || firstLine(body);
  // A title that's only the date ("Oct 7 deadline!") → the body names the thing.
  const bare = hit ? title.replace(hit.match, "").replace(/deadline|due|[!.:,-]/gi, "").trim() : title;
  if (bare.length < 3 && firstLine(body)) title = firstLine(body);
  const url = note.links?.[0] || (text.match(URL_RE) || [])[0] || "";
  return {
    id: "dl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title.slice(0, 140) || "Untitled",
    due: hit?.due || null,
    url,
    memo: "",
    project,
    noteId: note.id || "",
    done: false,
    createdAt: new Date().toISOString(),
  };
}

// --- store -----------------------------------------------------------------

export async function loadDeadlines(invoke) {
  try {
    const data = JSON.parse(await invoke("read_store", { name: "deadlines" }) || "{}");
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    console.warn("deadlines read failed", e);
    return [];
  }
}

export async function saveDeadlines(invoke, items) {
  await invoke("save_store", {
    name: "deadlines",
    data: JSON.stringify({ version: 1, items }),
  });
}

/** Add (or, for a note already captured, update) one item. Returns the item
 *  as stored. Re-capturing a note keeps its done flag and any hand edits to
 *  the title/date only where the note gave nothing. */
export async function addDeadline(invoke, item) {
  const items = await loadDeadlines(invoke);
  const i = item.noteId ? items.findIndex((x) => x.noteId === item.noteId) : -1;
  if (i >= 0) {
    const prev = items[i];
    items[i] = { ...prev, url: item.url || prev.url, due: item.due || prev.due };
    await saveDeadlines(invoke, items);
    return { item: items[i], existed: true };
  }
  items.push(item);
  await saveDeadlines(invoke, items);
  return { item, existed: false };
}
