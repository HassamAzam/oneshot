---
name: bug-reproduction
description: Reproduce a reported bug on the base branch in the real app, before anyone plans a fix, and return a verdict — reproduced, not-reproduced, inconclusive or not-applicable — with the steps run and the evidence. Use when asked to "reproduce this bug", "does this issue actually exist", "check it on dev before fixing", "is this a real bug", or when Oneshot's research phase runs. Observes only; never fixes, never edits code.
---

# Bug Reproduction

Establish, by running it, whether the behaviour a ticket reports actually happens
on the code as it is today. A fix built on a bug nobody saw is a guess: a run once
spent four laps on a focus ring before anyone looked at the real screen, and the
one case that would have proved the bug existed was never runnable.

**Your verdict can stop the run.** `not-reproduced` takes the ticket out of the loop
(labelling it *Not a Bug* when the project configures that label), posts on it and in
Slack, and ends the run before planning. So that verdict needs
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

## 2. Confirm you are on the unfixed code

At research time the worktree has no ticket commits yet — it IS the base branch.
Prove it rather than assume it:

```
git log --oneline origin/dev..HEAD      # must print nothing
git rev-parse HEAD                      # record as testedCommit
```

If the first command prints commits, you are not on unfixed code: `inconclusive`.

## 3. Bring the app up and log in — with the verify harness

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

## 4. Run the reported steps

- Follow the ticket's steps, in its own terms. Where it gives none, derive them
  from the description and the `uiPath` you traced, and say they were derived.
- Drive it with Playwright, as `local-browser-verify` describes (require it through
  the Oneshot install; never `npm install` into the worktree).
- Wait for data, not skeletons. Retry a flaky step twice.
- **Measure what the bug is about.** "Obscured", "misaligned", "wrong total",
  "not announced" all have a number or an attribute: overlap in px, contrast
  ratio, a cell value, an aria attribute. Record the number, not "looks fine".
- Screenshot the moment the bug should appear into the run artifacts dir
  (`state/runs/<iid>/artifacts/`), named `repro-<n>.png`. Record bare filenames.
- Record every step you actually ran, in order, in `steps`.

## 5. Decide the verdict

| Verdict | Only when |
|---|---|
| `reproduced` | You observed the reported wrong behaviour. |
| `not-reproduced` | ALL of: the app ran on unfixed code; you logged in as a role that can reach the screen (the ticket's permission/flag gate satisfied); you executed every reported step; and you observed the CORRECT behaviour, with evidence. |
| `inconclusive` | Anything that stopped you short of that: missing data, wrong role, feature flag, env error, a browser you don't have (Safari, Firefox, mobile), a device/viewport the ticket names that you could not match, production-only data, intermittent behaviour, or steps too vague to follow faithfully. |
| `not-applicable` | Feature request, no runnable surface. |

Rules that keep `not-reproduced` honest:

- **Different environment is not "not a bug".** The ticket may come from
  stage/production data, another browser, a narrow viewport or a specific user. If
  the conditions the ticket names are not the ones you ran, that is `inconclusive`.
- **Reading code is never evidence of `not-reproduced`.** Only an executed step is.
- **A partial reproduction is `reproduced`.** If some of the reported behaviour
  happens, the bug exists.
- `reason` for `not-reproduced` must say, in one or two sentences a QA engineer can
  check, what you ran and what correct behaviour you saw instead.

## Output

Fill `reproduction` in the research output: `kind`, `verdict`, `testedCommit`,
`account`, `steps`, `expected` (from the ticket), `observed` (what happened — values),
`evidence` (filenames and measurements), `reason`.

## Do not

- Do not fix, patch or edit anything. Research writes no code.
- Do not stop the servers — later phases reuse them.
- Do not label, comment or post anywhere. The conductor does that from your verdict.
- Do not spend the research budget here: if bring-up or login is still failing after
  a reasonable wait, record `inconclusive` and finish the rest of research.
