---
name: erp-ticket-requirements
description: >-
  Phase 1 of ERP ticket testing — review & analyze a gitlab.arbisoft.com/arbisoft/erp ticket and
  verify its MR is actually deployed. Use standalone when the user says "analyze this ticket",
  "what does this ticket ask for", "is the fix deployed on dev/stage", "check the MR for this ticket",
  or as the first step invoked by the test-erp-ticket orchestrator. Fetches the ticket + all comments,
  derives expected behavior from business logic, and confirms deployment per server.
---

# Phase 1 — Ticket Requirements Review & Analysis

**Goal:** understand what the ticket asks for and confirm the fix is testable on a server. Output a short written understanding. Do NOT plan or execute here.

> Shared env/credentials/servers and the cross-cutting testing principles live in `test-erp-ticket/SKILL.md`. When run standalone, read that file first if you need them.

## 1. Fetch the ticket + ALL comments

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.claude/.mcp.json'))['mcpServers']['gitlab']['env']['GITLAB_PERSONAL_ACCESS_TOKEN'])")
curl -s --header "PRIVATE-TOKEN: $TOKEN" "https://gitlab.arbisoft.com/api/v4/projects/arbisoft%2Ferp/issues/<IID>"
curl -s --header "PRIVATE-TOKEN: $TOKEN" "https://gitlab.arbisoft.com/api/v4/projects/arbisoft%2Ferp/issues/<IID>/notes?sort=asc&per_page=100"
```

Capture title, description, labels, milestone, assignee, and **every non-system note** — comments often carry the dev's QA guide, repro curls, test-data hints, and strike-through "fixed" markers.

**VPN:** if any call returns empty/HTML/unparseable, STOP and remind the user to check VPN.

## 2. Review the MR and VERIFY it is deployed (do NOT trust "MR merged")

The #1 source of false results.

- Find the MR from the notes (`mentioned in merge request !NNNNN`). Get `state`, `target_branch`, `merged_at`, `merge_commit_sha`.
- Confirm it is on the target branch, not just "merged":
  ```bash
  cd /Users/anosha.saeed/Documents/erp && git fetch origin dev --quiet   # or stage/master
  git merge-base --is-ancestor <merge_commit_sha> origin/dev && echo "ON DEV" || echo "NOT ON DEV"
  ```
- **Revert→reapply cycles:** `git log --oneline --all --grep="Revert\|Reapply\|!NNNNN"`. A merged MR may have been reverted and reapplied via a *different* commit; test the version that is live.
- **Read the changed files** (`/merge_requests/NNNNN/changes`) and the real logic in the repo. Flag **scope discrepancies** (ticket says "refactor" but diff adds models/endpoints → needs full functional testing).
- If the MR is **open / not deployed**, say so plainly — the bug still reproduces there; only the "before" state is testable.

## Output

A short summary: what the bug/feature is; the **expected behavior derived from business logic** (not from reading the code's output); MR number/state/target and deployment status per server; any scope or revert caveat.

Next in the pipeline: `erp-ticket-test-plan`.
