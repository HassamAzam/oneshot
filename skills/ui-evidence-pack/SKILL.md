---
name: ui-evidence-pack
description: Assemble the screenshot pack a reviewer looks at instead of checking out the branch — before/after pairs, the states tests do not reach, captions written for someone who has not read the ticket — and attach it to GitLab correctly. Use when asked for "screenshots for the MR", "show me what this looks like", "evidence for the reviewer", "attach these to the ticket", or when Oneshot's phase 7 or 14 runs.
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
- Do not crop out an error banner that happened to be on screen. Caption it.
- A pack with a gap in it, labelled, is worth more than a complete-looking pack
  that quietly omits the screen that looked wrong.
