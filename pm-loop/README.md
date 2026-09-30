# pm-loop — Plane → GitLab tooling in front of Oneshot

The PM side of the delivery loop, versioned here so changes get review and history:

```
Plane ticket ─▶ triage (Loop A) ─▶ grooming (Loop B) ─▶ arbisoft/erp issue ─▶ Oneshot (AI + Loop)
                 zone + route        groom.py + Jev          labels, docs          zone guard
```

Design: `docs/superpowers/specs/2026-09-30-single-board-zones-design.md` on erp `triage/board-router`.
Tracking ticket: arbisoft/erp#8777.

## Layout

| Path | What |
|---|---|
| `skills/ticket-grooming/SKILL.md` | Grooming skill. The model writes title and body; `groom.py` owns every rule |
| `skills/ticket-triage/SKILL.md` | Triage skill (its code lives in the erp repo, `scripts/triage/`, MR !11017) |
| `scripts/groom.py` | Grooming CLI: `resolve`, `context`, `create`, `attach`, `mr`, `sweep`, `ensure-labels` |
| `scripts/groom_gitlab.py` | Labels (allow-list), issues, the yellow tests-first flow, MRs, sweep |
| `scripts/resolve_plane_ticket.py` | Plane lookup, eligibility (fails closed), back-link |
| `scripts/collect_documents.py` | Attaches the original documents behind a ticket |
| `scripts/search_gitlab_context.py` | Previous-context search |
| `scripts/sprint_plan_append.py` | Sprint sheet, one atomic append per batch |
| `scripts/jev_layers.py` | Jev (TypeSafe) decides backend / frontend / migration from title + description |
| `scripts/jev_heartbeat.py` | Re-scores Jev every 50 finished tickets; history table in `~/Documents/ai/jev-findings/heartbeat/` |
| `scripts/pm_http.py`, `scripts/pm_secrets.py` | HTTP with timeouts and retries; credentials |
| `scripts/*_cron.sh` | Cron entry points: triage 11:00 and 17:00, sync + sweep hourly, heartbeat 10:30 |
| `scripts/test_groom.py` | `python3 -m pytest pm-loop/scripts -q` |

The zone map, label allow-list and Jev facts are **not** here. They live in the erp repo
(`.claude/zones.json`, `.claude/labels.json`, `.claude/erp-facts.json`) and are read from
`origin/dev` only. To trial an unmerged draft, set `PM_LOOP_MAP_DIR` to a checkout's `.claude/`.

## Setup

1. **Credentials.** Scripts never hold secrets. Put them in `~/.config/pm-loop/secrets.env` (`chmod 600`):
   ```
   GITLAB_TOKEN=…
   PLANE_API_KEY=…
   TYPESAFE_API_KEY=…
   ```
   Check with `python3 scripts/pm_secrets.py --check`, which reports sources, never values.
   Slack posting reads `~/.claude/.secrets.env` (see `slack_post.py`). The sprint sheet needs a
   service-account key at `~/.claude/service-accounts/workstream-sprint-plan.json` and `pip install cryptography`.
2. **Install.** Claude Code loads skills from `~/.claude/skills` and the skills call scripts in
   `~/.claude/scripts`. Link them to this checkout so the repo is the source of truth:
   ```sh
   ln -sfn "$PWD/pm-loop/skills/ticket-grooming" ~/.claude/skills/ticket-grooming
   ln -sfn "$PWD/pm-loop/skills/ticket-triage"   ~/.claude/skills/ticket-triage
   for f in pm-loop/scripts/*; do ln -sfn "$PWD/$f" ~/.claude/scripts/"$(basename "$f")"; done
   ```
3. **Allow-list** `Bash(python3 ~/.claude/scripts/groom.py:*)` in `~/.claude/settings.json`.

## Data leaving the machine

- **TypeSafe:** each groomed ticket's title and plain-text description (never comments,
  attachments or names), to decide its layers. The heartbeat re-sends past tickets' text when scoring.
- **GitLab (arbisoft/erp):** documents collected for a ticket are uploaded there. Direct-file links
  are fetched only over https from gitlab/projects.arbisoft.com and Google hosts.

## Rules that live in code (don't re-add them to the skills)

- **Labels:** only from the allow-list; the GitLab API would otherwise create any typo.
- **Duplicate protection:** eligibility needs a readable Plane back-link check, plus a GitLab search for the ticket ID.
- **Routes:**
  - green → `AI` + `Loop`
  - yellow → a person's `Characterization Tests` issue first; the sweep adds `Loop` only after a
    person-written, tests-only MR merges
  - red → people
- **Mandatory ACs:** the frontend dark-theme AC must name its screen; filler ACs are refused on AI routes.
- **Jev fallback:** when Jev is unavailable, every layer is kept, and the output says so.
