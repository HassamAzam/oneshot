---
name: bug-reproduction
description: Reproduce a reported bug on the base branch in the real app, before anyone plans a fix, and return a verdict — reproduced, not-reproduced, inconclusive or not-applicable — with the steps run and the evidence. Use when asked to "reproduce this bug", "does this issue actually exist", "check it on dev before fixing", "is this a real bug", or when Oneshot's research phase runs. Observes only; never fixes, never edits code.
---

# Bug Reproduction

Establish, by running it, whether the behaviour a ticket reports actually happens
on the code as it is today. A fix built on a bug nobody saw is a guess: a run once
spent four laps on a focus ring before anyone looked at the real screen, and the
one case that would have proved the bug existed was never runnable.

**Your verdict can stop the run.** `not-reproduced` posts your evidence on the ticket
and in Slack and pauses the run for a QA reviewer. If they comment `approved`, the
ticket is taken out of the loop (labelled *Not a Bug* when the project configures that
label) and the run ends before planning. Any other reply comes back to you as feedback,
and you reproduce again with it — use exactly what it names. So that verdict needs
the strongest evidence of the four. When in doubt, it is `inconclusive`.

## 1. Decide whether there is anything to reproduce

Read the description AND every comment.

- **bug** — the ticket says something that exists today behaves wrongly ("Current
  State" describes a defect; there are repro steps; "X does not work", "Y is
  obscured", "Z shows the wrong total").
- **feature** — it asks for something new or different ("add", "show", "allow",
  "Future Intended State" with no defect in "Current State").

Feature, or a change with no UI or runnable surface → `verdict: not-applicable`,
say why in `reason`, and stop here. Do not bring the app up.

## 2. Plan the reproduction before touching the browser

The app is still coming up, so spend that time on a plan. Write down, before any
browser step:

- **Conditions.** The role or permission that reaches the screen, any feature
  flag or setting the ticket depends on, and the browser, viewport or device it
  names. When `ensure` (step 4) reports `disabledIntegrations`, check them: a bug
  behind one of those cannot be run here. That is `inconclusive` now, not after
  twenty turns.
- **Data.** The exact shape of record the bug needs (e.g. "a review month with at
  least one processed increment"), and one targeted query that finds it: an API
  filter, a list endpoint, a read-only DB lookup. Do not page through the UI
  month by month hoping to find it.
- **Route.** The URL and the clicks from login to the moment the bug should show,
  from the ticket's steps or the `uiPath` you traced. Note anything known to get
  in the way on this app: blocking modals, slow skeletons, default filters that
  hide rows.
- **Observable.** The number or attribute that shows the bug (overlap in px, a
  computed style, a cell value, an aria attribute) and the value that would mean
  the behaviour is CORRECT. Without that second value, `not-reproduced` is not
  reachable, so you will be recording `inconclusive` anyway.

If the plan cannot be completed (the data does not exist on this DB, the role is
not available), stop and record `inconclusive` with what was missing.

## 3. Confirm you are on the unfixed code

At research time the worktree has no ticket commits yet — it IS the base branch.
Prove it rather than assume it:

```
git log --oneline origin/dev..HEAD      # must print nothing
git rev-parse HEAD                      # record as testedCommit
```

If the first command prints commits, you are not on unfixed code: `inconclusive`.

## 4. Bring the app up and log in — with the verify harness

Use exactly what `local-browser-verify` uses. Read its "Bring the app up" and "Log
in" sections; do not improvise a bring-up.

```
node $ONESHOT_HOME/scripts/app.cjs ensure
node .claude/skills/local-browser-verify/scripts/harness.cjs smoke
```

`ensure` with **no arguments** reads `$ONESHOT_WORKTREE` and `$ONESHOT_PORT` and
brings up the app for this worktree — the unfixed code. Never pass `--ref`: it
resolves against the remote, where `HEAD` is not the base branch. If
`$ONESHOT_PORT` is unset, no port was free to lease: `inconclusive`.

`app-env.json` gives the `baseUrl` to navigate. The conductor started this app in
the background when research began, so it is usually already compiling or up. A cold compile can take minutes — poll, don't
abandon it. A named harness error (`E_WEBPACK_DEAD`, `E_DB_UNREACHABLE`, …) is
`inconclusive` with that code in `reason`.

Login goes through the real form with `ONESHOT_TEST_LOGIN`. Record the account.

## 5. Run the reported steps

- Follow the ticket's steps, in its own terms. Where it gives none, derive them
  from the description and the `uiPath` you traced, and say they were derived.
- Drive it with Playwright, as `local-browser-verify` describes (require it through
  the Oneshot install; never `npm install` into the worktree).
- Wait for data, not skeletons. Retry a flaky step twice.
- **Measure what the bug is about.** "Obscured", "misaligned", "wrong total",
  "not announced" all have a number or an attribute: an overlap, contrast
  ratio, a cell value, an aria attribute. Record the number, not "looks fine".
  Measure an overlap with `overlap()` from `local-browser-verify`'s harness;
  its "Measure a visual bug after the interaction" bullet says how to read the
  result. Quote the `region` it returns ("a 43px band, the whole Title row"),
  never `areaPx` as "N px": it is an area, in px².
- Screenshot the moment the bug should appear into the run artifacts dir
  (`state/runs/<iid>/artifacts/`), named `repro-<n>.png`, and list the bare
  filenames in `evidence`. This applies to **both** verdicts: for `reproduced` the
  shot shows the defect, for `not-reproduced` it shows the correct behaviour at
  the same point. Crop or scroll so the affected element is visible without
  zooming. A full page where the bug is one pixel row proves nothing to a
  reader. The conductor attaches the first three to the ticket comment.
- Record every step you actually ran, in order, in `steps`.

## 6. Decide the verdict

| Verdict | Only when |
|---|---|
| `reproduced` | You observed the reported wrong behaviour. |
| `not-reproduced` | ALL of: the app ran on unfixed code; you logged in as a role that can reach the screen (the ticket's permission/flag gate satisfied); you executed every reported step; and you observed the CORRECT behaviour, with evidence. |
| `inconclusive` | Anything that stopped you short of that: missing data, wrong role, feature flag, env error, a browser you don't have (Safari, Firefox, mobile), a device/viewport the ticket names that you could not match, production-only data, intermittent behaviour, or steps too vague to follow faithfully. |
| `not-applicable` | Feature request, no runnable surface. |

### An `inconclusive` must say WHAT stopped it

`inconclusive` on its own records that reproduction stopped, never why — which
makes "the app would not start" and "this is a feature request" the same entry in
the log. Set `blocker` alongside it. `none` on every other verdict.

| `blocker` | You were stopped by | Who can clear it |
|---|---|---|
| `env` | the app, the login, the port, the harness — put the named `E_` code in `reason` | the machine: this is what `remediate` exists for |
| `data` | no record of the shape the bug needs exists on this database | a person, in seconds — they know which account has one |
| `access` | the role, permission or feature flag that reaches the screen | a person |
| `surface` | a browser, device or viewport the ticket names and this machine has not | a person, or nobody |
| `steps` | the reported steps are too vague to follow faithfully | the reporter |
| `flake` | behaviour that would not hold still long enough to observe | nobody yet |

Pick the FIRST thing that stopped you, not the last thing you tried. A run that
never got the app up is `env` even if you then also found the data missing.

Rules that keep `not-reproduced` honest:

- **Read [`refs/why-it-did-not-reproduce.md`](refs/why-it-did-not-reproduce.md)
  before you record it.** One principle from QA's own history — you ran it under
  different conditions than the reporter, and the difference is the bug — and the
  six conditions that differ most often. The first is the account: read its real
  flags and permissions rather than assuming them, because a session running as a
  superuser sees a permission bug behave correctly for it and wrongly for whoever
  reported it.
- **Different environment is not "not a bug".** The ticket may come from
  stage/production data, another browser, a narrow viewport or a specific user. If
  the conditions the ticket names are not the ones you ran, that is `inconclusive`.
- **Reading code is never evidence of `not-reproduced`.** Only an executed step is.
- **A partial reproduction is `reproduced`.** If some of the reported behaviour
  happens, the bug exists.
- `reason` for `not-reproduced` must say, in one or two sentences a QA engineer can
  check, what you ran and what correct behaviour you saw instead.

## 7. Check before you finish

Go through this list. Any "no" on a `reproduced` or `not-reproduced` verdict
means fix the record, or change the verdict to `inconclusive`.

- [ ] `testedCommit` recorded, and `git log origin/dev..HEAD` was empty.
- [ ] Every condition in your plan was met: role, flag, data, browser/viewport.
- [ ] Every reported step is in `steps`, in order, as something you executed
      (not something you read in code).
- [ ] `observed` holds a value (number, style, cell text), not "looks fine" or
      "looks broken".
- [ ] `evidence` lists at least one `repro-<n>.png` that exists in the artifacts
      dir and shows the element in question, plus the measurement.
- [ ] `expected` is quoted or paraphrased from the ticket, not from the code.
- [ ] `reason` could be checked by a QA engineer who never saw this session.
- [ ] `blocker` names the FIRST thing that stopped an `inconclusive`, and is
      `none` on every other verdict.
- [ ] If anything you observed was a different defect (an unrelated 500, a
      console error elsewhere), it is not counted as this bug. Mention it in
      `reason` if a later phase needs it.
- [ ] For `not-reproduced`: you observed the correct value you planned for, on
      the ticket's own conditions.
- [ ] For `not-reproduced`: `refs/why-it-did-not-reproduce.md` walked, and where
      the ticket is about permissions, `account` records the flags and the
      specific permission you actually read — not an assumption about the login.

## Output

Fill `reproduction` in the research output: `kind`, `verdict`, `testedCommit`,
`account`, `steps`, `expected` (from the ticket), `observed` (what happened, as values),
`evidence` (filenames and measurements), `reason`, `blocker`.

The conductor turns that record into a ticket comment, with the screenshots
attached, for both `reproduced` (straight away) and `not-reproduced` (the Not a Bug
gate's request first, then the closing comment once QA confirms). A verdict with
no `.png` in `evidence`, no `steps`, no `observed` or no `testedCommit` posts
nothing, and a `not-reproduced` one is treated as `inconclusive`. The wording is in
[templates/](templates/README.md), which also shows which field fills which line.
Anything you leave out of the record is missing from the comment too.

## Do not

- Do not fix, patch or edit anything. Research writes no code.
- Do not stop the servers — later phases reuse them.
- Do not label, comment or post anywhere. The conductor posts the comment from
  your record.
- Do not spend the research budget here: if bring-up or login is still failing after
  a reasonable wait, record `inconclusive` and finish the rest of research.
