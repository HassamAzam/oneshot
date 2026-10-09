# One Loop v2 — Where hooks are needed

Companion to `ONE-LOOP-V2-PLAN.md`. Full auto changes the hook calculus completely: v1 could
afford advisory guards because a human sat at the merge gate. v2 has no gate, so anything that
must hold has to hold **without a model's cooperation**.

> **Historical note.** This document was written when the pipeline ended in a self-deploy step.
> `deploy`, `qa` and `demo` have since been removed — the pipeline now ends at the merge — and
> `deploy-guard` went with them. The reasoning below about *why* an irreversible action needs a
> fail-closed guard is kept deliberately: it is the argument that would have to be re-made
> before anything like it is added back.

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

- `merge` is **code, not a session**. No model holds a merge tool, so no
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
| `pause-check` · `write-scope` · `sleep-cap` · `budget-gate` · `injection-scan` · `log-event` · `archive-transcript` · `subagent-capture` · `precompact-guard` | **Kept**, several re-scoped |
| `dryrun-guard` | **Not built.** `DRY_RUN` cuts the tool list instead, and only partly — see its row in §3. |
| — | **7 new**, listed below |

Net: 12 → 17 hooks, but the two most complex ones shrink or vanish, and every new one exists
because v2 does something v1 never did (run a local server, drive a browser, hand artifacts
between phases).

## 3. The hook table

### PreToolUse

| Hook | Matcher | Enforces | P |
|---|---|---|---|
| `pause-check` | *(all)* | Denies side-effectful tools while `state/PAUSE`, `PAUSE-QUOTA`, `PAUSE-NETWORK` or `PAUSE-DEPLOY` exists. Denies all `mcp__gitlab__*` while the VPN breaker is open. **With zero human gates this is your only brake on a live run.** | **P0** |
| `write-scope` | `Write\|Edit\|NotebookEdit` | Per-phase write allowlist. Absolute deny for every phase: the v2 runtime's own `hooks/ config/ src/ scripts/`, `~/.claude/`, **and `$ERP_REPO`**. Must `realpath()` before comparing — see §4.1. | **P0** |
| `git-guard` | `Bash` | No `push --force`, no push to `dev\|stage\|master`, no push to any ref except the run's leased branch, no `branch -D` of a protected ref, no `remote set-url`, no `gh`/`glab` as an escape hatch, **no git command whose resolved cwd is outside the leased worktree**, and **no tree-changing git (`checkout`, `restore`, `stash`, `reset`, `commit`, …) from a phase that stands in the worktree without write scope on it** (research, plan, testcases, review, ui-evidence, mr — push stays allowed). For local tests it allows only read-only git in the workstream-automation clone and a run's `wsa` and `wsa-run` worktrees, from any phase (plus a plain `apply`/`add` in a run's `wsa`), and refuses starting Cypress or `scripts/localtests.cjs` from any session — see the local-tests rows below. | **P0** |
| `artifact-guard` | `Write\|Edit\|NotebookEdit\|Bash` | Refuses a write to any phase's handoff artifact, or to `run.json`, sitting directly in a run directory. `writes: ['run']` hands every session the whole directory, while the only files a prompt asks it to write there are the three `*-partial.json` backstops — so the permission is wider than the need by every handoff in it, plus the journal. It matters because the conductor reads those files back: `qualityGate()` decides the merge from `verify.json` and `findings.json`, and `run.json` carries the plan and test-case approvals a **human** gave on the ticket plus the digests meant to detect exactly this. `verify`, `ui-evidence` and `mr` all run after `review` and all hold the scope. Bash is matched as well as the write tools, because `write-scope` is blind to it and the transcripts show sessions already reaching these paths with `cat` and `python3 -c` — as often by `cd`-ing into the run directory as by absolute path, so relative paths resolve against the hook input's `cwd` and any `cd` earlier in the command. Moving a handoff out counts as writing it, and deleting or moving a whole run directory (or `state/runs`) is refused as well, since it takes the journal and every handoff at once. The local-tests step's own records in the run directory are protected the same way: `local-tests-resources.json` (what its crash recovery signals, frees, drops and removes), `local-tests-capture.json` and `local-tests-seq`. Reads are never refused. Fails OPEN. | **P0** |
| `frontend-test-guard` | `Write\|Edit\|NotebookEdit` | Denies authoring a frontend unit test, matching the app repo's own Jest `testMatch` exactly: a collected extension under `frontend/src`, either below a `__tests__/` directory or carrying a `.test.`/`.spec.` suffix. The Jest harness has rotted and CI never runs it, so such a test is unpassable by construction — `testcases` and `verify` say so in prose, and `implement` (which writes the files) did not. **Playwright is untouched** and must stay that way: it lives outside Jest's `roots` by construction — Oneshot's own install, `state/runs/<iid>/harness/`, `<worktree>/.verify-scratch/` — which is why the rule is anchored on the directory and never on the filename. Backend Python tests and Oneshot's own tests are unaffected. Fails OPEN. | **P0** |
| `browser-scope` | Playwright / browser tools | Navigation allowlist: `localhost:<leased-port>`, the GitLab host of `GITLAB_REPO_URL`. Everything else denied. | **P1 (M3)** |
| `sleep-cap` | `Bash` | Caps `sleep N`. Phase 6 legitimately waits (webpack ~30 min) — it must poll and report instead of sleeping through its own wall clock. | **P1 (M3)** |
| `secret-guard` | `Read\|NotebookRead\|Grep\|Glob\|Bash` | Denies reads **and writes** of this repo's own `.env` (`$ONESHOT_HOME/.env`) only: the Read/Grep tools by path, and Bash that reads it (`cat`, `grep`, `sed`, `cp`, `source`, `<` …) or writes it (`>`, `>>`, `tee`, `mv`, `sed -i` …), with `~`, `$HOME` and `$ONESHOT_HOME` expanded and relative paths resolved against the session cwd. `.env.example`/`.env.local` and the work repo's `.env` are allowed. **Not covered, deliberately:** `local_settings.py`, `~/.claude.json`, `~/.ssh/**`, `*.pem`, echoing `*TOKEN*` variables (the session env is a whitelist and carries no token), and any interpreter or `sudo` that opens the file itself — it is best-effort, and the skills keep their "never print `GITLAB_TOKEN`" rule. It also guards the Cypress credentials for local tests, by a stricter rule — see the local-tests rows below. | P2 |
| `dryrun-guard` | — | **Not built; partly covered by structure.** Under `DRY_RUN`, `toolPolicy()` in `src/conductor/phase.ts` strips `Write`, `Edit` and `NotebookEdit` from every phase, plus seven MR/issue tools (`create_`/`update_merge_request`, `create_`/`update_issue`, the MR and issue notes, `upload_markdown`). That is a deny-list, so it is not closed. `mr` skips the wider GitLab deny-list (`mayTouchGitlab`), so under `DRY_RUN` it still holds `push_files`, `create_or_update_file`, `create_branch` and the thread, note and draft-note writes. Every phase still holds the mutation tools that are on no list at all: `delete_issue`, the label and issue-link writes, `delete_draft_note`, `create_`/`retry_`/`cancel_pipeline`, `fork_repository` and `create_repository`. `git-guard` covers only `git push` on Bash (`ONESHOT_DRY_RUN`). Closing the rest belongs in `toolPolicy()`/`mcpServers()` — the GitLab MCP server has a read-only mode — not in a hook. | — |
| `log-event` | *(all)* | Event tail / dashboard. | **P0** |

#### Local tests (`local-tests-scope`, `local-tests-run`)

`local-tests-scope` is a session. It may make **temporary** edits to specs, page objects and
fixtures in a throwaway worktree of the workstream-automation clone at `state/runs/<iid>/wsa`.
Those edits are never committed. They are saved as
`artifacts/local-tests/temporary-changes.patch`. `local-tests-run` is conductor code: it applies
that patch to a fresh worktree and runs Cypress against a per-run copy of the automation database,
using credentials kept on Oneshot's side. Four things have to hold without the session's help,
and three existing guards hold them. Paths come from `ONESHOT_LOCAL_TESTS_REPO` and
`ONESHOT_LOCAL_TESTS_CREDS` (`localTests()` in `hooks/_common.cjs`), read exactly as
`localTestsConfig()` reads them: `.env` under the process environment, the legacy `ONELOOP_`
spelling accepted, a blank or placeholder value counted as unset, `~` expanded and a relative path
taken from the Oneshot checkout. `hooks.test.ts` pins the two together. An empty repo means the
feature is off on that desk, and only the rules that do not need the clone's path fire.

| Rule | Hook | Denied | Still allowed | Why |
|---|---|---|---|---|
| The automation repos stay as they are | `git-guard` | An **allow-list**. In the clone, any `state/runs/*/wsa` or any `state/runs/*/wsa-run`, reached by cwd, `cd`, `-C`, `--git-dir`/`--work-tree` or `GIT_DIR`/`GIT_WORK_TREE`, from **any** phase, every git subcommand that is not a read is refused: `commit`, `push`, `stash`, `reset`, `checkout` (including `-- <path>`), `restore`, `clean`, `update-index`, `gc`, … and also `branch <new>`/`-m`/`-M`/`-d`, `tag <new>`/`-a`/`-d`, `remote add`/`remove`/`rename`/`set-url`, `worktree add`/`remove`/`prune`, `reflog expire`/`delete`, `config` writes, a `fetch` whose refspec has a `:` (or that prunes, sets an upstream or updates HEAD), and `apply --index`/`--cached`/`--3way`/`--unsafe-paths`. A plain `apply` or `add` aimed anywhere but a run's own `wsa` (a `wsa-run`, the clone, or a `wsa` pointed at another tree by `--work-tree`) is refused too. | Reads: `status`, `diff`, `log`, `show`, `ls-files`, `ls-tree`, `grep`, `blame`, `rev-parse`, `cat-file`, `merge-base`, `describe` and the like; `fetch` without a refspec; `config --get`/`--list`/`<key>`; `branch`/`tag` listings (`-a`, `-l`, `--show-current`, `--contains`); `remote -v`/`show`/`get-url`; `worktree list`. Writes: a plain `apply` or `add` (`add -N` included) in a run's own `wsa`, which change that worktree's files and index like an Edit — `local-tests-scope` re-applies the previous round's patch that way on a QA redo, and the read-only-worktree rule, which judges the ERP worktree, leaves such a call to this one. | A worktree shares its clone's `.git`, so a stash, commit, branch, remote or config change made there lands in a person's checkout — `remote remove origin` drops `refs/remotes/origin/*`, after which no prepare-scope resolves `origin/master`. `wsa-run` is the run step's while it exists, and another ticket's can be mid-run. A worktree moved under the patch no longer matches what the run step will apply. A list of the dangerous subcommands was tried first and missed half of these. This also closes the gap the conductor-cwd allowlist leaves open on purpose: `checkout -- <path>`, `restore` and `clean` are refused when aimed at these repos, and `remediate` keeps them everywhere else. |
| Specs run only in `local-tests-run` | `git-guard` | From any session: `cypress …`, `node_modules/.bin/cypress`, `npx`/`pnpx`/`bunx`/`yarn`/`pnpm cypress`, `npm exec cypress`, `node …/node_modules/cypress/…`, Cypress's module API from `node -e`, a `package.json` script whose body runs `cypress` (`npm run report` in workstream-automation), and `scripts/localtests.cjs` however it is started. An option's value is not taken for the command (`npx --cache /tmp/c cypress run`, `npx -c 'cypress run'`, an unknown `--opt value` before it), and `--prefix`/`-C`/`--cwd`/`--dir` move where the `package.json` script is read from (`npm --prefix <clone> run report`, `npm run report --prefix <wsa>`). The same holds behind `timeout` (with `-k`/`-s` and their values), `nohup`, `nice`, `env`, `sudo` (with their options) or `bash -c`. | Reading the script, grepping specs, `ls` or `command -v` of the binary, other package scripts (`npm --prefix <clone> run lint`), options that belong to another tool (`npx tsc -p cypress`), `npm ls`/`view cypress`. | The run step owns the database copy, the credentials and the cleanup. Started from a session, specs would hit whatever database the environment points at, and nothing would clean up after them. |
| The Cypress credentials stay out of transcripts | `secret-guard` | Any `cypress.env.json` (workstream-automation **tracks** one, so the clone and every `wsa` and `wsa-run` has it; the clone's is filled in locally and `wsa-run`'s is the run step's merge with the desk credentials) and the desk's credentials file (default `~/.config/oneshot/cypress-env.json`). Read/Grep by path, case-folded and through symlinks. A Grep in `content` mode rooted where one sits (the clone, a `wsa`, a `wsa-run`, a run directory) unless its `glob`/`type` leaves it out. A Glob that hunts for it by name. **Any** Bash segment that names one, including `rev:path`, a shell glob that expands to it, a brace expansion that does (`*.{json,ts}`, `cypress.env.{json,x}`), and interpreter one-liners. A recursive `grep -r`/`rg`/`ag`/`git grep` rooted where one sits; for `grep -r`, rooted at or above `state/runs` too, which reaches every run's `wsa` and `wsa-run`. Git that prints the clone's or a `wsa-run`'s working tree as a patch — `diff`, `show`, `log -p`, `format-patch`, `stash show -p`, `add -p` — reached by `cd`, `-C`, `--git-dir`/`--work-tree` or `GIT_DIR`/`GIT_WORK_TREE`, unless a pathspec leaves the file out. | `ls`/`stat`/`test`/`file` of it. Searches narrowed to `cypress/` or a subdirectory, or that exclude it (`--exclude=`, `-g '!…'`, `':!…'`, a Grep `glob`/`type`). Names-only searches: Grep in `files_with_matches` mode, `grep -l`/`-c`, `git grep -l`. In the clone or a `wsa-run`: `git diff -- cypress/`, `git diff -- . ':!cypress.env.json'`, `--stat`/`--name-only`, `log --oneline`, `show <rev>:<other file>`. `git diff` in a run's `wsa` (its copy is the committed one; that diff is how the scope session cuts its patch). | The rule is the name, not the verb, because no session has a reason to touch these files, and because a one-liner's `;` splits its verb off. Still best-effort: deeper trees, `$(…)`, `xargs` and a recursive search inside `bash -c` are not parsed. A segment whose judging throws is refused when a credentials file is in reach of it, rather than allowing it and every segment after it. Glob reaches the guard because `READ_OR_BASH` in `src/conductor/hooks.ts` matches it, which `hooks.test.ts` pins. |
| The run step's records stay its own | `artifact-guard` | A write, by tool or Bash, to `local-tests-resources.json`, `local-tests-capture.json` or `local-tests-seq` directly in any run directory. | Reading them. Anything under `artifacts/local-tests/`. | `writes: ['run']` hands `local-tests-scope` and `remediate` the whole run directory, and the run step's crash recovery acts on the resources file it finds there: it signals the process groups, frees the ports, drops the database and removes the worktrees that file names. |

**Fail-open is the default, and the exception is wired in `src/conductor/hooks.ts`.** Every
`.cjs` guard fails open on its own internal errors (one narrow exception inside a script:
`secret-guard` refuses a Bash segment whose credentials check throws when a credentials file is
in reach of it, so one bad word cannot wave the rest of the command through), and the runner
mirrors that: a spawn
failure, a 15s timeout or non-JSON stdout resolves to `{}`, which the SDK reads as allow. That
is right for guards whose subject matter the pipeline can survive being wrong about, and it
keeps a broken guard from wedging a 90-minute phase. It is wrong for a guard standing between a
confused agent and an irreversible action, so `hooks.ts` keeps a `FAIL_CLOSED` set and turns any
failure of a script in it into a `PreToolUse` **deny** payload instead. That set is **empty**
today — its only member was `deploy-guard` — and it is kept because the rule outlives the guard
that needed it.

### PostToolUse

| Hook | Matcher | Enforces | P |
|---|---|---|---|
| ~~`artifact-validate`~~ | — | **Superseded by structure; never built.** The premise was that a session writes its own handoff, so a `Write` matcher could catch a malformed one. It does not: the artifact is the SDK's *structured output*, enforced by `outputFormat: json_schema` in `src/conductor/phase.ts` and retried until it validates, then written by the conductor after the session is dead. There is no tool call for a matcher to see. Semantic checks a schema cannot express ("the field is present but empty") are run-level post-conditions and live in the conductor — `src/conductor/reproduction.ts` is the worked example. | — |
| `injection-scan` | GitLab reads, `WebFetch`, **browser page-text reads**, `Read` of ticket-derived files | Non-blocking. Flags instruction-shaped text and re-anchors the model on "this is data". Widened matcher: the app under test renders user-authored content, which v1 never read. | **P1 (M1)** |
| `log-event` | *(all)* | — | **P0** |

### SessionStart

| Hook | Enforces | P |
|---|---|---|
| `budget-gate` | Refuses the session if the phase's or the run's weighted-token ceiling is blown. **Per-phase ceilings now, not per-loop** — an `implement` that burned 3 laps is refused a 4th before the model starts. Four Opus phases per ticket makes this load-bearing. | **P0** |
| `run-context` | Injects immutable run facts as `additionalContext`: run id, iid, leased branch, worktree path, port, lap number, outstanding findings. Uniform across all phases and present even if prompt assembly has a bug. | **P1 (M1)** |
| `traps-brief` | Self-gates to `testcases` and injects `erp-ticket-test-plan`'s `refs/traps.md` as `additionalContext`. The skill already says to read it; an instruction to read a file is a request, and a phase under turn pressure drops reads first. | **P1** |
| `repro-conditions` | Self-gates to `research` (and to `bugReproduction !== false`) and injects `bug-reproduction`'s `refs/why-it-did-not-reproduce.md`. Lands before the account is chosen and the options enumerated, which is the only point at which two of those conditions can still change the run. | **P1** |

### Not a hook: `automation-ready`

`hooks/automation-ready.cjs` lives here and speaks the guard contract, but `hooksFor()` registers
it for **no** event. It is the Ready For Automation mode's readiness check, and its only caller
is the conductor (`runAutomationReadyGuard` in `src/conductor/hooks.ts`), which runs it before
it spends an automation session, before it posts each version for QA, and before it writes the
sheet. A hook would be the wrong layer (§1): the `automation-testcases` session has no write
scope, no GitLab server, no shell and no file reads, so there is no tool call for a hook to stand
in front of, and every post, label edit and sheet write is conductor code.

A ticket is ready when `Loop`, the entry label and master switch, is on it (reason
`loop-missing`); `Ready For Automation` is on it (`rfa-missing`) and either `Ready For
Deployment` was added before the latest trigger add or the ticket is closed (`rfd-order`);
**and** a merge request linked to it is in the same project, merged, and not a branch promotion
(source not a protected or `Adhoc-YYYY-MM-DD` branch) (`mr-not-merged`). Open leftover MRs are a
warning. A missing `Loop` or `Ready For Automation` withdraws the request rather than leaving
something to fix, so the conductor stops on `loop-missing`/`rfa-missing` without commenting and
resumes when the label is back; a not-ready comment is posted only when both labels are on and
`rfd-order` or `mr-not-merged` remains.

It is not in `FAIL_CLOSED` and does not need to be. Every failure the script can catch — a
missing token, GitLab down or answering 401/500, too many label events, a bug — answers
`unknown` with the reason. What it cannot catch (not running, a timeout, empty or non-JSON
output) resolves to `{}` like any guard, and the conductor reads `{}`, or anything short of a
well-formed verdict for this ticket under `automationReadiness`, as `unknown` too. `unknown` is a
hold: nothing is spent and nothing is posted.

### SessionEnd

| Hook | Enforces | P |
|---|---|---|
| `reap-check` | Kills anything still holding the leased port that isn't in the run journal — orphaned dev servers, headless Chromium, backgrounded `npm start`. v2 starts long-lived local servers; v1 didn't. Without this, port 8000 stays held and the next run can't lease it. | **P1 (M3)** |
| `archive-transcript` | Forensic record. You will want this the first time a full-auto run surprises you. | P2 |

### Stop

| Hook | Enforces | P |
|---|---|---|
| ~~`phase-exit-check`~~ | **Superseded by structure; never built.** Same reason as `artifact-validate`: the failure it guards — "a phase that did the work, narrated it in prose, and ended without a handoff" — is what `outputFormat: json_schema` removed. A session that returns no structured output fails the phase outright (`out.error = 'session produced no structured output despite a schema'`), which the runner handles as a phase failure rather than a silent degradation. | — |

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

### 4.2 What a fail-closed guard was for *(historical — `deploy-guard` is removed)*

Full auto **and** self-deploy, with phase 10 a session rather than code — a diagnostician that
could read the remote build log and retry. That combination had no human in the path, so the
only thing standing between a confused phase and the demo server was this hook.

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

### 4.4 The handoff contract became structure, not two hooks *(historical)*

This section argued that `artifact-validate` + `phase-exit-check` were "the **mechanism**",
because the handoff contract was then a skill — advice, and so ignorable under load. Both
properties it asked for now hold without either hook, and by construction rather than by policy:

- The phase cannot end without producing its artifact — a session that returns no structured
  output fails the phase.
- The artifact cannot be malformed and still be accepted — `outputFormat: json_schema` retries
  until it validates.

The reasoning is kept because the *shape* of the argument was right and the conclusion was wrong
in an instructive way: the question to ask of a proposed hook is always whether the capability
it guards can be removed instead. Here it could. **Do not build these two from this plan.**

What the plan did not anticipate is the opposite failure — not a phase that fails to write its
own artifact, but one that writes **somebody else's**. Every session gets `writes: ['run']`, the
conductor reads those files back to decide the merge, and `run.json` in the same directory holds
a human's gate approval. That is `artifact-guard`, in the PreToolUse table above, and it is a
hook rather than structure only because the capability cannot be withdrawn: the three
`*-partial.json` crash backstops are real, they live in that directory, and Bash can reach any
path regardless of what the tool list says.

## 5. Build order

**M0** — `pause-check`, `write-scope` (with realpath + `$ERP_REPO` deny), `git-guard`,
`budget-gate`, `log-event`. Nothing runs against a real ticket until these five are in and
`scripts/verify-hooks.sh` passes offline.

**M1** — `run-context`, `injection-scan`. (`artifact-validate` and `phase-exit-check` were dropped
here — see §4.4. `artifact-guard` took their place in the run directory, for the opposite
failure.)

**M3** — `browser-scope`, `sleep-cap`, `reap-check`.

**M5** — `deploy-guard`. Shipped with phase 10, then **removed with it**: the pipeline ends at
the merge, and a guard whose only job was the deploy has nothing left to guard.

**M7** — `secret-guard`, `precompact-guard`, `subagent-capture`, `archive-transcript`.
(`dryrun-guard` was dropped here: `DRY_RUN` is enforced by cutting the tool list, and what that
does not yet cut belongs in the same place — see its row in §3.)

Every hook keeps v1's two properties: shell-gated on the role env var so your interactive
sessions pay ~1 ms, and self-gating inside the script as defense in depth.
