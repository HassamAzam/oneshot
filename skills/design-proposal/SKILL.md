---
name: design-proposal
description: Draw what a ticket's UI should look like, before anyone plans or builds it, and hand a human something they can approve — mockups grounded in the real product's tokens, before/after captures, and for a flow change each state of that journey drawn as its own screen. Use when asked to "design this before we build it", "what should this look like", "mock this up for sign-off", or when Oneshot's design phase runs on a ticket labelled Design. Draws only; never implements, never edits application code.
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

## 2. Ground it in the real product, not in taste

A mockup succeeds when the reaction is "that's our app with the feature in it"
and fails when it is "that's a nice generic dashboard". Generic is the default
failure mode and it is not a small one — it is the difference between feedback
about the feature and feedback about your colour choices.

In order:

1. **Read the real tokens.** `frontend/src/jss/Theme.js` (`getColors`,
   `getPalateColors`), `frontend/src/jss/style.js` (Lato/Montserrat),
   `frontend/src/scss/_variables.scss`. Distil them into one `tokens.css` that
   every mockup imports — a system-level change is then a one-file edit instead
   of a find-and-replace across five files.
2. **Capture the screens as they are today.** Bring the app up the way everything
   else does (`node $ONESHOT_HOME/scripts/app.cjs ensure`) and screenshot each
   screen this ticket touches. Those captures are the `before` on every screen,
   and they are also where you read the real shell — nav, header, density,
   spacing — which every mockup then reproduces.
3. **Use research's `uiPath`** to find those screens instead of hunting for them.
   It was traced one phase ago for exactly this.

A `before` is empty only when the screen does not exist yet — never because you
did not capture it.

## 3. Draw the screens

One self-contained `.html` per screen, importing `../tokens.css`. No CDN
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

## 4. A flow change is drawn as states, not prototyped

When the change spans more than one screen or adds a step to an existing journey, set
`flowChange` and draw each state of that flow as its own screen, in order, so the reviewer
can read the journey off the mockups.

Do **not** build a clickable prototype and do **not** record a walkthrough. Both follow in
their own change, once real runs have measured what this phase actually costs — they are
the most expensive and most breakable part of an estimated budget.

## 5. Give the reviewer the decisions, not a changelog

- **`decisions`** — the two or three choices you made on their behalf that they
  would argue with. Not everything you did.
- **`newPatterns`** — anything not already in the design system: a new token, a
  component the product does not have. Surface it. Approving the design approves
  these too, so slipping one in as though it already existed is the one move
  that makes the gate worthless.
- **`openQuestions`** — always with a recommendation. A question carrying a
  default gets answered; one without it parks the run on somebody's inbox.

## 6. When feedback comes back

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
