---
name: journal
description: Write a concise end-of-day journal entry summarizing today's work, based on git history and conversation context. Use when the user asks to journal, log today's work, or write a daily summary.
---

# Daily journal

Summarize today's work into `journal/YYYY-MM-DD.md` (today's date), creating the `journal/` folder if needed.

Steps:
1. Check `git log` for today's commits (and the current diff/conversation) to see what was done.
2. If `journal/YYYY-MM-DD.md` already exists, merge new items into it (don't duplicate or discard existing bullets) rather than overwriting.
3. Write/update the summary in `journal/YYYY-MM-DD.md` — bullet points, Slack-message tone, written for a semi-technical, non-engineer colleague. No jargon, no file paths, just what changed and why it matters.
3. Keep it brief: a few bullets is plenty. Ask the user if anything important is missing before finalizing.
