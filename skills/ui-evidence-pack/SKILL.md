---
name: ui-evidence-pack
description: Assemble the screenshot pack a reviewer looks at instead of checking out the branch — before/after pairs, the states tests do not reach, captions written for someone who has not read the ticket — and attach it to GitLab correctly. Use when asked for "screenshots for the MR", "show me what this looks like", "evidence for the reviewer", "attach these to the ticket", or when Oneshot's phase 7 runs.
---

# UI Evidence Pack

A reviewer who can see the change does not have to imagine it. This is a
different artefact from verify's pass/fail screenshots: those prove a case ran,
these make an argument.

## What belongs in a pack

- **Before/after on every changed screen.** When a true "before" cannot be
  produced — the screen did not exist, the data is gone — say so in the caption
  rather than shipping an "after" pair that implies one.
- **The states the cases do not reach:** empty, loading, error,
  permission-denied. These are where a reviewer's doubt actually lives.
- **One shot per high-blast passing case**, so the pack shows the feature
  working and not just rendering.

Nothing else. A pack of thirty screenshots is read as carefully as a pack of
zero.

## Getting a real "before"

The "after" is the app you already have. The "before" is the base branch — and the
one way NOT to get it is by moving files in this checkout. The git guard refuses
`checkout`, `restore`, `stash` and `reset` from this phase, and anything left altered
here is what `mr` pushes: one run left a staged revert of its own fix behind that way,
and the fix would have been silently undone if it had been committed.

Bring up a SECOND app on the base branch instead. It runs on its own ports
(`ONESHOT_APP_PORTS`, 8010-8012) as its own processes, and — with the command below —
writes nothing into this run's directory, so the run's app and the run's
`harness/app-env.json` stay exactly as they were.

**First, check that it is cheap.** `ensure` cannot be told to give up on a cold start,
and a cold start waits up to 90s for Django and up to 20 minutes for the first webpack
compile — against this phase's 40-minute budget. So look before you call it:

```
node $ONESHOT_HOME/scripts/app.cjs list
git rev-parse origin/<base branch>
```

Go ahead only if `list` shows an instance with `healthy: true` and `bundleReady: true`
that is EITHER at the base branch already (its `head` is the first 10 characters of
that sha — reused, near-instant) OR `ours: true` with `dirty: 0` (switched to the base
branch in place, ~20s). If neither exists, the next call is a cold start: do not make
it — caption the gap and ship the "after" alone.

Then:

```
env -u ONESHOT_WORKTREE -u ONESHOT_PORT -u ONESHOT_TICKET -u ONESHOT_IID \
  ONESHOT_RUN_DIR=$ONESHOT_HOME/state/runs/$ONESHOT_TICKET/base-app \
  node $ONESHOT_HOME/scripts/app.cjs ensure --ref <base branch>
```

Every variable in that line matters:

- `ONESHOT_WORKTREE` / `ONESHOT_PORT`: with a worktree pinned, `ensure` answers for THAT
  checkout and ignores `--ref` entirely (scripts/app.cjs, the pinned branch of `ensure`)
  — you would photograph the change twice and call it a pair.
- `ONESHOT_TICKET` / `ONESHOT_IID` / `ONESHOT_RUN_DIR`: `ensure` writes the app it brought
  up to `<run dir>/harness/app-env.json`, and without these it resolves the run dir from
  `ONESHOT_TICKET` — i.e. it would overwrite THIS run's `app-env.json` with the base
  app. Pointing `ONESHOT_RUN_DIR` at a `base-app/` subdirectory keeps that write, and the
  harness's own `servers.json`, out of the run's files. (The shell expands
  `$ONESHOT_TICKET` before `env` strips it.)

The command prints the base app's descriptor on stdout; navigate to ITS `baseUrl` for
the "before" shot. Take the "after" on your own instance — `http://localhost:$ONESHOT_PORT`,
the `baseUrl` you already had — and do not re-read any `app-env.json` to find it once
the base app is up.

- Same viewport, same data, same path in both shots, or the pair proves nothing.
- Leave that instance running. It is shared, and the next run reuses it.
- If `list` shows no cheap instance (above), or `ensure` fails (`E_NO_PORTS`,
  `E_REF_UNRESOLVED`), say so in the caption and ship the "after" alone. Never present an
  unchanged region of this branch as a "before".
- A value that is not in the viewport does not need any of this: read it from source
  with `git show origin/<base>:<path>` and record it in `observations`.

## Changes a screenshot cannot show

A page title, an `aria-*`, `alt` or `lang` value, a meta tag, focus order, a
response header: none of these is in the viewport, so a before/after pair of
them is two identical pictures. Measure the value instead and report it as
text — what, where, base-branch value, this-branch value, how it was read. In
Oneshot that is the `observations` field, published as a table. A pack of zero
screenshots and a complete table is a complete pack for a non-visual change.

## Naming and order

- `<caseId>-<slug>.png` when the shot belongs to a case — `TC-04-status-column.png`.
- `<NN>-<slug>.png`, zero-padded, when it does not. NN is the order the reviewer
  should read them in. **The order is the argument**: setup, before, after,
  side-effect.
- **Never reuse a filename across laps.** A second lap's screenshot overwriting
  the first destroys the before/after pair and nothing warns you.

## Captions

Written for someone who has not read the ticket: what the screen is, what
changed, what to look at. "Increment report" is not a caption. "Increment
report, Status column now present and reading Resigned for a terminated
employee" is.

Bind a caption to a case id when one exists. An empty case id beats an invented
one.

## Annotation

- Arrow, box or callout on the region that changed — and never over the value
  being demonstrated.
- One annotation per point. A screenshot with four arrows makes no point at all.
- Redact anything that reads as real personal data, even on a demo instance.
  Salary figures, national IDs, personal emails.

## When the ticket had an approved design

A ticket that went through the design gate had its screens approved by a human
*before* the code existed. The reviewer's question on the MR is therefore not
"does this look reasonable" but "is this what I signed off", and that is a
question only a pair can answer.

- One `designConformance` row per approved screen: the approved render, your
  capture of the same screen, and every way they differ.
- **Capture at the size the mockup was drawn at** — 1280×800 unless the design
  says otherwise. Two screens at different widths are not comparable and a pair
  that is not comparable is worse than no pair, because it invites a conclusion
  the pictures do not support.
- **An empty `differences` is a claim, not a default.** It says these match. So
  list the small departures too — a spacing change, a reworded label, a missing
  empty state. Deciding on the reviewer's behalf which departures were fine is
  the one thing this row must not do; they approved the design, so they are the
  one who gets to say a difference does not matter.
- A screen you genuinely cannot reach — the route needs data or a role you
  cannot make — gets an empty `builtShot` and the reason as its single
  difference. Never pair a screenshot of a different screen.
- Put both files in `screenshots` as well, approved first and built immediately
  after. Order is the argument here as everywhere else in this pack.

The approved renders are already in the artifact directory; you do not
re-create them, and you must not re-render them from the mockup HTML — the file
that was approved is the file that gets shown.

## Attaching to GitLab

`upload_markdown` **rejects absolute paths and any path outside the project
directory** as directory traversal. A scratchpad path, a `/tmp` path or a run
artifacts path is refused every time, and the refusal reads like a permissions
problem rather than a path problem.

The procedure:

1. Copy the file into a directory **inside the working directory** you are
   invoking from.
2. Pass the **relative** path to `upload_markdown`.
3. Keep the URL it returns.
4. Delete the copy once the upload has returned.

Upload before writing the note that links it, and link only what actually
returned a URL. Two refusals means stop and report the pack un-uploaded — not a
third attempt with a fourth shape of path.

## Honesty

- Do not stage a screenshot of a state you produced by hand and present it as
  the feature working.
- Do not add anything to the page before capturing it — no overlay, banner,
  label, style or script. Text painted onto the page is your text dressed as the
  app's, and it hides whatever it covers. Annotation belongs in the caption or
  drawn on the image afterwards, never in the DOM.
- Do not modify the checkout under review to produce a "before" — no
  `git checkout <ref> -- <paths>`, no stash, no editing files and putting them
  back. Take the before from a separate base-branch instance, or read the old
  value with `git show <base>:<path>` and say so, or state that there is none.
- Do not crop out an error banner that happened to be on screen. Caption it.
- A pack with a gap in it, labelled, is worth more than a complete-looking pack
  that quietly omits the screen that looked wrong.
