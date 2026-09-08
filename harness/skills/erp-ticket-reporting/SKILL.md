---
name: erp-ticket-reporting
description: >-
  Phase 5 of ERP ticket testing — report results with calibrated confidence and, only when asked, post
  findings to the gitlab.arbisoft.com/arbisoft/erp ticket. Use standalone when the user says "write up
  the results", "post these findings as a bug", "make the QA report", "move the ticket label", or as the
  final step invoked by the test-erp-ticket orchestrator. Produces the results table, severity buckets,
  and paste-ready ticket comment.
---

# Phase 5 — Reporting

**Goal:** report results honestly with calibrated confidence, and (only when asked) publish findings to the ticket.

> Shared env/token live in `test-erp-ticket/SKILL.md`.

## Results table

`Test Case | Steps | Expected | Actual | Status | Evidence` — status ✅ / ❌ / ⚠️ / ⏳.
- **Evidence** references the per-scenario screenshot — the `/tmp/erp-<IID>/` path for a locally-driven browser, or the inline transcript image for `Claude in Chrome` (don't cite a `/tmp` path you didn't actually write).
- Mark clearly which rows are **code-verified** vs **need a UI run**.
- List the test data created and where; offer a cleanup/restore step.

## Confidence wrap-up

End with a *verified / not-yet-verified / needs-human-review* breakdown — not a blanket "good to go." Separate what you **proved** (reproduced/derived) from what you **assumed**. Leave the final ship/no-ship call to the human.

## Severity buckets (when summarizing many issues)

🔴 Critical/Breaking · 🟠 Major · 🟡 Minor/polish. Call out **regressions / lost features vs the current version** separately.

## Post to the ticket — PUBLISH GATE (only when the user asks)

```bash
curl -s --request POST --header "PRIVATE-TOKEN: $TOKEN" \
  --data-urlencode "body@/tmp/comment.md" \
  "https://gitlab.arbisoft.com/api/v4/projects/arbisoft%2Ferp/issues/<IID>/notes"
```
- Concise bug reports: what/where, repro steps, expected vs actual (with the exact error/status), root cause if known, one-line suggested fix. Offer a "human-worded" version for a group/chat.
- Keep the file ASCII-only to avoid stray non-breaking spaces (U+00A0) breaking things.

## Move labels (when asked)

```bash
curl -s --request PUT --header "PRIVATE-TOKEN: $TOKEN" \
  --data-urlencode "add_labels=QA Issues" --data-urlencode "remove_labels=In QA" \
  "https://gitlab.arbisoft.com/api/v4/projects/arbisoft%2Ferp/issues/<IID>"
```

## Never expose secrets

In anything shared with devs, use `{TOKEN}` placeholders and tell them to generate their own. Never paste real auth tokens.
