---
name: design-proposal
description: Draw what a ticket's UI should look like, before anyone plans or builds it, and hand a human something they can approve — the feature's purpose and entry points settled before the first pixel, mockups grounded in the real product's tokens, before/after captures, and for a flow change each state of that journey drawn as its own screen. Use when asked to "design this before we build it", "what should this look like", "mock this up for sign-off", or when Oneshot's design phase runs on a ticket labelled Design. Draws only; never implements, never edits application code.
---

# Design Proposal

Settle what a screen should look like while changing it is still free. A design
agreed after the plan exists is a picture of a decision already made, which is
why this runs between `research` and `plan` and why approving it is what
releases the run.

**What you produce is a specification.** `plan` and `implement` build to it, and
`ui-evidence` posts the shipped screens back against it on the MR. So a detail
you leave vague is a detail somebody else invents, and a screen you draw wrong
is a screen that gets built wrong and then defended in review.

## 1. Decide whether there is anything to design

Read the description and every comment before you draw a pixel.

No UI surface — backend-only, a data fix, an invisible refactor, a change whose
whole effect is in a log — is `applicable: false`, one line of `rationale`, no
screens, stop. That is a correct and cheap answer. The label is applied by a
person and people label optimistically; a design phase that invents a screen to
justify its own existence spends a reviewer's round on being told there was
nothing here.

## 2. Understand what the feature is for — and where it lives

A mockup can be pixel-perfect and still be the wrong feature. Before you ground
anything in tokens, settle two things the ticket usually does not spell out:
what the feature is *for*, and where in the app it surfaces.

**A terse ticket is an inference task, not a literal one.** A one- or two-line
description names a thing; it does not specify it. The noun in the title is
where you start reading, not where you stop. Derive, before drawing: who acts
and who reads, and what existing behaviour this formalises, replaces, or moves
in-product from wherever people improvise it today. A sentence granting everyone
the ability to add a record is rarely a request for a CRUD list — read what the
record is *for* before you draw the table that holds it. Design the literal
reading and you spend a reviewer's round being told what the feature was always
for.

So make that reading reviewable, and make it survive. State it as the **first
`openQuestion`, carrying a recommendation**: the gate posts open questions with
their recommendation and says the recommendation is used absent an answer, so a
reading stated there is one a reviewer can veto before approving anything. Then
put it in the primary screen's **`purpose`** as well — `openQuestions` and
`decisions` reach the gate and stop there, while a screen's `purpose` and `note`
are the only prose `plan` and `implement` are handed. An `approved` makes your
stated reading the specification; a comment correcting it re-runs this phase
with their words appended, the same as any other feedback.

**A feature has entry points in the app it joins, not just a page of its own.**
Where does someone already mid-flow meet this — the surface they are already on
when it becomes relevant to them? That surface is part of the design, not a
follow-up. Draw the **one** entry point a user is most likely to arrive
through, as its own screen with its own `before` capture and its own
`screenshot`, and name any others in `decisions` rather than drawing each — one
is what this phase's budget covers. Use research's `uiPath` to find that screen;
where `uiPath` never traced it, a handful of targeted reads, not a survey. A
feature reachable only from its own URL is a design that drew half the ticket
and left the reviewer to name the other half.

**Match the input affordance to the content.** Size the control to what goes
into it: expressive, long-form or attachment-bearing content needs more than a
single-line field, and a choice from a fixed set needs a control rather than
free text. Where that sizing is genuinely contested — the ticket implies one
thing and the surrounding product does another — it earns a `decisions` entry.
Where it is obvious, draw it and spend the slot on something a reviewer would
actually argue with.

## 3. Ground it in the real product, not in taste

A mockup succeeds when the reaction is "that's our app with the feature in it"
and fails when it is "that's a nice generic dashboard". Generic is the default
failure mode and it is not a small one — it is the difference between feedback
about the feature and feedback about your colour choices.

In order:

1. **Use the tokens you were handed.** `design/tokens.css` is already in your
   artifact directory, generated before this session started by a deterministic
   read of `frontend/src/jss/Theme.js` (`getColors`), `frontend/src/jss/style.js`
   (Lato/Montserrat) and `frontend/src/scss/_variables.scss`. Every mockup
   imports it, so a system-level change is a one-file edit instead of a
   find-and-replace across five files.

   **Import it; never rewrite it.** It is regenerated at the start of every
   round, so an edit to it is lost. A token the product does not have yet goes
   in `design/new-tokens.css`, which is yours, and in `newPatterns`.

   **Read its header before you draw.** It names the files it read and lists
   every token it could NOT resolve. Those are the only ones you go to the
   source for — going back for the rest re-derives, by hand and less reliably,
   something that is already correct in front of you. If the file is absent
   altogether the generator could not run: read the three files above and
   distil them yourself, exactly as this step used to say.

   **For a dark-mode screen, put `data-theme="dark"` on `<html>`.** The dark
   values sit in that block, not in a media query, so a dark mockup without
   the attribute renders the light palette — and re-deriving dark values by
   hand is the drift this file exists to stop.
2. **Capture the screens as they are today.** Bring the app up the way everything
   else does (`node $ONESHOT_HOME/scripts/app.cjs ensure`) and screenshot each
   screen this ticket touches. Those captures are the `before` on every screen,
   and they are also where you read the real shell — nav, header, density,
   spacing — which every mockup then reproduces.
3. **Use research's `uiPath`** to find those screens instead of hunting for them.
   It was traced one phase ago for exactly this.

A `before` is empty only when the screen does not exist yet — never because you
did not capture it.

## 4. Draw the screens

One self-contained `.html` per screen, in `design/` beside the tokens and
importing `./tokens.css` (and `./new-tokens.css` if you made one). No CDN
scripts, no external fonts, no remote images: inline everything.

- **Real content, always.** Plausible names, dates, amounts and statuses for
  this product. 5–8 varied rows in any table, including one long value that
  tests truncation and one edge amount. Never lorem ipsum, never "Item 1".
  People cannot judge a layout full of placeholders, so placeholder content
  costs you the round you spent getting it looked at.
- **Draw the states that carry risk** — empty, error, permission-denied — not
  only the happy one. A state you deliberately skip is worth a word in that
  screen's `note`.
- **Spacing on one scale**, one primary action per screen, body text ≥14px.
  Cramped-then-airy is the clearest tell of a machine-made mockup.
- Render at 1280×800 and screenshot. Then read your own screenshots once,
  critically: misaligned edges, doubled borders, overflow, contrast. Fix what
  you find — a flaw you could have caught yourself spends the reviewer's
  attention on your typo instead of on your design.

## 5. A flow change is drawn as states, not prototyped

When the change spans more than one screen or adds a step to an existing journey, set
`flowChange` and draw each state of that flow as its own screen, in order, so the reviewer
can read the journey off the mockups.

Do **not** build a clickable prototype and do **not** record a walkthrough. Both follow in
their own change, once real runs have measured what this phase actually costs — they are
the most expensive and most breakable part of an estimated budget.

## 6. Give the reviewer the decisions, not a changelog

- **`decisions`** — the two or three choices you made on their behalf that they
  would argue with. Not everything you did.
- **`newPatterns`** — anything not already in the design system: a new token, a
  component the product does not have. Surface it. Approving the design approves
  these too, so slipping one in as though it already existed is the one move
  that makes the gate worthless.
- **`openQuestions`** — always with a recommendation. A question carrying a
  default gets answered; one without it parks the run on somebody's inbox.

## 7. When feedback comes back

A non-`approved` comment from a reviewer re-runs this phase with their words
appended. Address them directly and visibly: re-render, re-screenshot, and make
the changed screens actually different. A round that returns the same pictures
with a paragraph explaining why they were right the first time is how a gate
turns into a loop.

## Output

`applicable`, `rationale`, `flowChange`, `tokensFile`, `screens[]`,
`decisions[]`, `newPatterns[]`, `openQuestions[]`. Every file path
is **artifact-relative and a bare filename where the schema says so** — a path
in a filename field breaks the gate that attaches it.

## Do not

- **Do not edit application code.** You are drawing. The only files you create
  live under the run's artifact directory; nothing you write here ships, and
  nothing goes into the worktree, because mockup HTML committed to the ticket
  branch would land in the MR diff.
- **Do not post to GitLab.** The conductor posts the design and reads the
  verdict back off the ticket. You have no tool for it and should not want one.
- **Do not wait for anyone.** You produce the artifact and end. The pause is the
  conductor's, not yours.
- **Do not skip the `before` captures** because the mockup looks fine on its
  own. Half of what a reviewer is judging is whether it still looks like the
  same product.
