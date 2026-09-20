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

Bring up a SECOND app on the base branch instead. It is a different instance on its
own port (`ONESHOT_APP_PORTS`, 8010-8012), so it cannot disturb the run's app:

```
env -u ONESHOT_WORKTREE -u ONESHOT_PORT \
  node $ONESHOT_HOME/scripts/app.cjs ensure --ref <base branch>
```

Clearing `ONESHOT_WORKTREE` is the part to get right: with a worktree pinned, `ensure`
answers for THAT checkout and ignores `--ref` entirely (scripts/app.cjs, the pinned
branch of `ensure`) — you would photograph the change twice and call it a pair. The
command prints the same `app-env.json`; navigate to its `baseUrl` for the "before"
shot, then take the "after" on your own instance.

- Same viewport, same data, same path in both shots, or the pair proves nothing.
- Leave that instance running. It is shared, and the next run reuses it.
- If it will not come up (`E_NO_PORTS`, `E_REF_UNRESOLVED`, or a cold seed that would
  eat your budget), say so in the caption and ship the "after" alone. Never present an
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
