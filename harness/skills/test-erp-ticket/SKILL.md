---
name: test-erp-ticket
description: >-
  Test an Arbisoft ERP GitLab ticket end-to-end. Use whenever the user shares a
  gitlab.arbisoft.com/arbisoft/erp ticket and asks to test/verify it — e.g. "test this ticket <url>",
  "verify this ticket on dev/stage", "review the MR and test this ticket", "run happy/negative/edge
  cases". Orchestrator: runs the full 5-phase pipeline by invoking the standalone phase skills in order
  (erp-ticket-requirements → erp-ticket-test-plan → erp-ticket-test-data → erp-ticket-execution →
  erp-ticket-reporting), enforcing the confirmation gates. Any single phase can also be triggered on its
  own via its own skill.
---

# Testing an Arbisoft ERP Ticket — Orchestrator

Runs the QA workflow for `arbisoft/erp` as a **fixed pipeline of 5 phase skills**. Each phase is a standalone skill that can also be invoked on its own; this orchestrator runs them in order and enforces the gates.

## How to run the pipeline

Invoke each phase skill **in order** using the Skill tool, carrying the previous phase's output into the next. Stop at every gate.

1. **`erp-ticket-requirements`** — fetch the ticket + comments, verify the MR is deployed.
2. **`erp-ticket-test-plan`** — plan scenarios. → **GATE 1:** show the plan and WAIT for explicit go-ahead before continuing.
3. **`erp-ticket-test-data`** — create fresh test data. → **GATE 2:** ask which server (dev/stage) and let the user log in manually before any write.
4. **`erp-ticket-execution`** — run scenarios one at a time, screenshot each (uses GATE 2's server/login).
5. **`erp-ticket-reporting`** — results table + confidence wrap-up. → **PUBLISH GATE:** post to the ticket only when the user asks.

Run 1→2 automatically; then hold at each gate. Never assume a server, never enter credentials, never skip a gate. If a phase can't complete (blocked step, data can't be created, flow can't be driven), pause and ask the user rather than guessing.

> **Triggering a single phase:** each phase skill above works standalone (e.g. "plan test cases for this ticket" → `erp-ticket-test-plan`; "set up test data on stage" → `erp-ticket-test-data`). Use this orchestrator only when running the whole flow.

## Shared environment & credentials (used across all phases)

- **GitLab:** `https://gitlab.arbisoft.com`, project `arbisoft/erp` (URL-encoded `arbisoft%2Ferp`, numeric id `304`).
  - Token: read `GITLAB_PERSONAL_ACCESS_TOKEN` from `~/.claude/.mcp.json` (never hardcode/echo it in anything shared).
  - API header: `PRIVATE-TOKEN: <token>`.
- **Servers:** dev = `https://dev-workstream.arbisoft.com` · stage = `https://workstream-staging.arbisoft.com`.
- **Django webshell:** `/admin/webshell/script/<id>/change/` — runs Python in the app context (paste script into `source`).
- **API auth:** DRF token — header `Authorization: Token <token>` (NOT `Bearer`).
- **Local repo (read for code review):** `/Users/anosha.saeed/Documents/erp`.
- **VPN:** if any GitLab/server call returns empty/HTML/unparseable, STOP and remind the user to check VPN before continuing.

## Critical testing principles (cross-cutting — apply in every phase)

1. **Never use the implementation as its own oracle.** Compute the expected value independently from the ticket's requirements, THEN compare. If "expected" comes from the same code path, a systematic bug passes silently.
2. **Sanity-check magnitude & units.** "Is this number plausible?" (a value labelled USD that's actually a PKR magnitude; a limit that feels too low). Catches what equality checks miss.
3. **Test feature interactions, not just features in isolation.** Bugs hide where two mechanisms stack. Verify combinations explicitly.
4. **Watch for double-counting / stacked factors.** If two factors both encode the same reduction, multiplying them is wrong.
5. **"Reconciles across layers" ≠ "correct."** Backend = admin = dashboard agreeing only proves consistency, not correctness.
6. **Verify empirically; don't assert from reading alone.** Reproduce on the server. Don't capitulate to a claimed bug without verifying either.
7. **Calibrate confidence explicitly.** Separate "proven" (reproduced/derived) from "needs verification" (assumed/UI-dependent).
8. **You augment, you don't replace the reviewer.** Do the legwork fast; surface findings; leave the final ship/no-ship call to the human.

## Guardrails

- Run the phases in order; stop at every gate.
- Confirmation gate before executing; ask the server; never assume.
- Login is always manual — the user logs in; never type, request, or store credentials.
- Run browser scenarios one at a time; pause and ask for any step you can't perform. Never guess an unobserved outcome.
- Reading code = fine. Do not modify application source unless explicitly asked.
- Flag when the fix isn't deployed on the chosen server.
