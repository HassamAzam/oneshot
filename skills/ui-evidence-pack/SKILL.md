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
