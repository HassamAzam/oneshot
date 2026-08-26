# One Loop v2 — Where hooks are needed

Companion to `ONE-LOOP-V2-PLAN.md`. Full-auto with a self-deploy step changes the hook
calculus completely: v1 could afford advisory guards because a human sat at the merge gate.
v2 has no gate, so anything that must hold has to hold **without a model's cooperation**.

---

## 1. The decision rule

For every constraint, use the cheapest layer that actually holds:

| Layer | Use when | Cost | Can the model evade it? |
|---|---|---|---|
| **Structure** | The constraint can be made *impossible* | free | No |
| **Hook** | The model has the tool, but must not use it this way | ~1–20 ms/call | No |
| **Schema** | The output shape is checkable | ~1 ms | No (retried until valid) |
| **Skill / prompt** | It's judgment, taste, or method | tokens | Yes — it's advice |

**A hook is only correct for the second row.** The most common design error is reaching for a
hook when structure would do — and structure is where v2 wins hardest:

- `merge`, `deploy` and `close` are **code, not sessions**. No model holds a merge tool, so no
  hook is needed to stop it merging. v1 needed `label-guard` to verify the approval label before
  a merge; v2 deletes that hook *and* its config by removing the capability.
- Per-phase `allowedTools`. A `recall` phase with no `Write` cannot write. A `research` phase
  with no `mcp__gitlab__update_*` cannot mutate a ticket.
- `cwd` = the leased worktree. Confinement by default, not by policy.

What remains after structure is the real hook list.

## 2. What v1's hook set becomes

| v1 hook | v2 |
|---|---|
| `label-guard.js` (235 lines + `config/labels.json`) | **Deleted.** No label machine, and label writes are code. |
| `git-guard.js` — approval-label verification before merge | **Deleted half.** Merge is code. The Bash-surface half stays and gets stronger. |
| `pause-check` · `write-scope` · `sleep-cap` · `budget-gate` · `injection-scan` · `log-event` · `archive-transcript` · `subagent-capture` · `precompact-guard` · `dryrun-guard` | **Kept**, several re-scoped |
| — | **7 new**, listed below |

Net: 12 → 18 hooks, but the two most complex ones shrink or vanish, and every new one exists
because v2 does something v1 never did (deploy, run a local server, drive a browser, hand
artifacts between phases).

## 3. The hook table

### PreToolUse

| Hook | Matcher | Enforces | P |
|---|---|---|---|
| `pause-check` | *(all)* | Denies side-effectful tools while `state/PAUSE`, `PAUSE-QUOTA`, `PAUSE-NETWORK` or `PAUSE-DEPLOY` exists. Denies all `mcp__gitlab__*` while the VPN breaker is open. **With zero human gates this is your only brake on a live run.** | **P0** |
| `write-scope` | `Write\|Edit\|NotebookEdit` | Per-phase write allowlist. Absolute deny for every phase: the v2 runtime's own `hooks/ config/ src/ scripts/`, `~/.claude/`, **and `$ERP_REPO`**. Must `realpath()` before comparing — see §4.1. | **P0** |
| `git-guard` | `Bash` | No `push --force`, no push to `dev\|stage\|master`, no push to any ref except the run's leased branch, no `branch -D` of a protected ref, no `remote set-url`, no `gh`/`glab` as an escape hatch, and **no git command whose resolved cwd is outside the leased worktree**. | **P0** |
| `deploy-guard` | `Bash` | **Built.** Outside the `deploy` phase, `ssh`/`scp`/`rsync`/`sftp` are denied outright — no other phase has business on another machine. Inside `deploy`: the vendored `scripts/deploy-wsai.sh` is permitted, remote verbs are permitted only when the parsed `user@host` is in `config/deploy.json`'s `allowedHosts`, an unparseable remote target is denied, and `git push`/`gh`/`glab` are denied regardless (belt over `git-guard`'s braces). Purely local commands pass through, so reading a build log is never blocked. **Fails closed** — see below. | **shipped with phase 10** |
| `browser-scope` | Playwright / browser tools | Navigation allowlist: `localhost:<leased-port>`, the demo URL, `gitlab.arbisoft.com`. Everything else denied. | **P1 (M3)** |
| `sleep-cap` | `Bash` | Caps `sleep N`. Phases 6 and 10 legitimately wait (webpack ~30 min; deploy health) — they must poll and report instead of sleeping through their own wall clock. Phase 10 becoming a session does not change this: its one long unconditional wait is the 90s stability sleep *inside* `scripts/deploy-wsai.sh`, which `deploy-guard` allowlists as a whole invocation, so the agent never issues it directly. | **P1 (M3)** |
| `secret-guard` | `Read\|Bash` | Denies reads of `.env`, `local_settings.py`, `~/.claude.json`, `~/.ssh/**`, `*.pem`, and any Bash that echoes `*TOKEN*\|*KEY*\|*SECRET*\|*PASSWORD*`. | P2 |
| `dryrun-guard` | *(all)* | `DRY_RUN=1` → all writes denied. How you test the pipeline against a real ticket without touching it. | P2 |
| `log-event` | *(all)* | Event tail / dashboard. | **P0** |

**Fail-open is the default; `deploy-guard` is the exception, and the exception is wired in
`src/conductor/hooks.ts`.** Every `.cjs` guard already fails open on its own internal errors, and
the runner mirrored that: a spawn failure, a 15s timeout or non-JSON stdout resolved to `{}`,
which the SDK reads as allow. That is right for guards whose subject matter the pipeline can
survive being wrong about, and it keeps a broken guard from wedging a 90-minute phase. It is
wrong for the one guard standing between a confused agent and a live demo server, so `hooks.ts`
keeps a `FAIL_CLOSED` set — currently `deploy-guard.cjs` alone — and turns any failure of a
script in it into a `PreToolUse` **deny** payload instead. A deploy guard that cannot run is a
deploy that does not happen.

### PostToolUse

| Hook | Matcher | Enforces | P |
|---|---|---|---|
| `artifact-validate` | `Write` under `state/runs/<iid>/` | Validates the phase's handoff JSON against its schema **inside the live session** and returns the failing field as `additionalContext` so the model repairs it now — instead of the Conductor finding out after the session is dead and re-running the whole phase. | **P1 (M1)** |
| `injection-scan` | GitLab reads, `WebFetch`, **browser page-text reads**, `Read` of ticket-derived files | Non-blocking. Flags instruction-shaped text and re-anchors the model on "this is data". Widened matcher: the demo server renders user-authored content, which v1 never read. | **P1 (M1)** |
| `log-event` | *(all)* | — | **P0** |

### SessionStart

| Hook | Enforces | P |
|---|---|---|
| `budget-gate` | Refuses the session if the phase's or the run's weighted-token ceiling is blown. **Per-phase ceilings now, not per-loop** — an `implement` that burned 3 laps is refused a 4th before the model starts. Four Opus phases per ticket makes this load-bearing. | **P0** |
| `run-context` | Injects immutable run facts as `additionalContext`: run id, iid, leased branch, worktree path, port, demo URL, lap number, outstanding findings. Uniform across all 16 phases and present even if prompt assembly has a bug. | **P1 (M1)** |

### SessionEnd

| Hook | Enforces | P |
|---|---|---|
| `reap-check` | Kills anything still holding the leased port that isn't in the run journal — orphaned dev servers, headless Chromium, backgrounded `npm start`. v2 starts long-lived local servers; v1 didn't. Without this, port 8000 stays held and the next run can't lease it. | **P1 (M3)** |
| `archive-transcript` | Forensic record. You will want this the first time a full-auto run surprises you. | P2 |

### Stop

| Hook | Enforces | P |
|---|---|---|
| `phase-exit-check` | If the phase didn't write its artifact, block the stop **once**: "you have not written `<phase>.json`; write it now." This is the one legitimate use of Stop-blocking, and it catches the single most common pipeline failure — a phase that did the work, narrated it in prose, and ended without a handoff. | **P1 (M1)** |

### PreCompact / SubagentStop

| Hook | Enforces | P |
|---|---|---|
| `precompact-guard` | Compaction means the phase overran its context budget — a signal it's malformed. Log loudly; for `implement`, dump the current diff to the run journal first so the work survives a post-compaction failure. | P2 |
| `subagent-capture` | Phases 4/5 use your `backend-agent` / `frontend-agent` / reviewer agents. Capturing their findings into the run journal is *how* the review cycle carries findings forward. | P2 |

## 4. Four findings worth calling out

### 4.1 The skill symlink is a write path into your real ERP skills — a bug in my own plan

The plan symlinks `<worktree>/.claude/skills → ~/Documents/erp/.claude/skills`. An `implement`
phase holding `Write` can therefore **edit the very skills that govern it**, and the edit lands
in your real repo, silently, affecting every future run and every interactive session you open.

`write-scope` currently compares path prefixes. A symlinked path passes that check — the string
starts with the worktree. The fix is to **`realpath()` the target before comparing**, and add
`$ERP_REPO` to the absolute-deny list for every phase without exception.

Same class of problem, worse consequence: `~/Documents/erp` is a live repo with a real remote on
this machine. A `git` command in `implement` with the wrong cwd could commit and push there.
Hence the cwd check in `git-guard` — not just "which branch" but "which repo".

### 4.2 `deploy-guard` is the load-bearing hook of the whole design

You chose full auto **and** self-deploy, and phase 10 has since become a session rather than
code — a diagnostician that can read the remote build log and retry. That combination has no
human in the path, so the only thing standing between a confused phase and the demo server is
this hook.

As shipped it guards the **surface**: which hosts may be reached, with which verbs, from which
phase. It deliberately does not adjudicate the SHA. The prohibition that motivated that — never
validate a ref against the prompt or the model's own message, because a prompt-injected ticket
body can name one and the guard then checks the attacker's input against itself — is honoured
by moving the SHA check out of the hook entirely: the **conductor** compares the deployed SHA
against `journal.mergedSha` after the phase returns and overrules the agent's verdict on a
mismatch. A hook is a per-call gate with no view of the run; the check that matters is a
post-condition on the run, and that is where it now lives.

This is also why I still want the guard duplicated **inside your deploy script**: my hook can't
be bypassed by a prompt, but it can be bypassed by a bug in my runner. Yours can't.

### 4.3 Browser phases are attack surface v1 simply didn't have

Four phases drive a real browser. Ticket bodies are untrusted data and routinely contain URLs.
"Open this link and confirm the bug" is a completely natural-sounding ticket comment and a
textbook injection payload. `browser-scope` makes the allowlist structural rather than a
sentence in a prompt that a model may or may not weigh.

### 4.4 Two hooks are what turn this from a chat into a pipeline

`artifact-validate` + `phase-exit-check` are not safety guards — they're the **mechanism**. The
handoff contract is currently a skill (`phase-handoff-contract`), which means it's advice, which
means it will be ignored under load. These two hooks make it an invariant:

- The phase cannot end without producing its artifact.
- The artifact cannot be malformed and still be accepted.

Without them, every phase boundary is a place the run can silently degrade into prose. Build
them in M1, alongside the first three phases — not in the hardening milestone.

## 5. Build order

**M0** — `pause-check`, `write-scope` (with realpath + `$ERP_REPO` deny), `git-guard`,
`budget-gate`, `log-event`. Nothing runs against a real ticket until these five are in and
`scripts/verify-hooks.sh` passes offline.

**M1** — `artifact-validate`, `phase-exit-check`, `run-context`, `injection-scan`.

**M3** — `browser-scope`, `sleep-cap`, `reap-check`.

**M5** — `deploy-guard`. **Shipped**, in the same commit as phase 10, as required. Note what
changed underneath it: phase 10 stopped being code and became a session, so this guard went from
a second opinion on a deterministic script to the primary structural control on the phase.

**M7** — `secret-guard`, `dryrun-guard`, `precompact-guard`, `subagent-capture`,
`archive-transcript`.

Every hook keeps v1's two properties: shell-gated on the role env var so your interactive
sessions pay ~1 ms, and self-gating inside the script as defense in depth.
