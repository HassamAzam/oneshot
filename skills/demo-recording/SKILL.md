---
name: demo-recording
description: Record a short annotated walkthrough of the finished feature working in the real app and post the webm to the ticket — one user journey, captioned for someone who has not read the ticket, drawn from the acceptance criteria and the cases that actually passed. Use when asked to "record a demo", "make a walkthrough video", "show this working on the ticket", or when Oneshot's demo-recording phase (8.5) runs. Records and narrates; it does not fix the feature and does not author the test cases it follows.
---

# Demo Recording

A demo is an argument made in motion: it shows a stakeholder the change *happening*
so they do not have to check out the branch or read the diff. It runs late — after
the feature is implemented, verified, evidenced, and the MR carries its description
— so the journey you record is the one that actually passed.

## This is NOT a UI-evidence pack — the one rule inverts

`ui-evidence-pack` forbids any DOM overlay: a screenshot must be the untouched app,
or it is your text dressed as the product's. A demo is the opposite. The caption
chrome — a title band and a step pill — **is the point**, and it is drawn to read
as demo furniture, visually separate from the app, never mimicking its UI. Keep it
that way: narration on top of the real app, never a fake control painted into it.

Everything else `ui-evidence-pack` says about honesty still holds (below).

## One journey, not the whole case list

A demo is a story with a beginning and an end, not a regression sweep. Pick the
**single primary user journey** the ticket delivers:

- Source it from the ticket's **acceptance criteria** (what a person asked for) and
  the **happy-path cases that passed** in `verify.json` — read `testcases.json` for
  the approved scenarios and their steps, and `verify.json` for which ran green.
- Follow the `happy`-tagged journey end to end. Skip negative, edge and boundary
  cases — those are verify's job and belong in evidence, not a walkthrough.
- 5–8 steps is a demo. Twenty steps is a test run nobody watches to the end.

If `verify.json` shows the happy path did **not** pass, there is no working feature
to demo: do not stage one. Post the reason to the ticket (below) and stop.

## Bring-up and session

The app is already leased for this phase (`needsPort`), reachable at
`http://localhost:$ONESHOT_PORT`. Do not bring up your own — reuse it.

Login has one trap this phase pays for: a **stale** `storage-state.json`
authenticates just enough to render `/home/` but ERR_ABORTs or bounces every real
navigation to `/login/`. The helper handles it by forcing a fresh login
off-camera before recording; if you drive Playwright by hand, do the same —
`h.login(session, { force: true })` once, then record.

## Record with the helper

`scripts/record.cjs` owns the mechanics that cost a run to get right: a video
context, the fresh-login dance, the caption/ring overlay, and flushing the webm.
You own the flow — the clicks and the words — because only you know this ticket's
journey.

```js
const rec = require('<ONESHOT_HOME>/.claude/skills/demo-recording/scripts/record.cjs');
const r = await rec.startRecording({
  outDir: process.env.ONESHOT_RUN_DIR + '/artifacts/demo',
  title: 'Demo — <what the ticket delivers>',
});
// r.session is a local-browser-verify session; r.caption / r.ring / r.installOverlay are ready.

await rec.gotoModule(r, '<module-key>');          // uses the harness's module routes
await r.caption(1, 'Open <screen> and start <action>.');
await r.ring(r.page.locator('[data-testid="..."]'));
await r.page.locator('[data-testid="..."]').click();
// … the rest of the journey, one caption per step …
await r.caption(7, '✅ <the outcome the ticket asked for>.', 1800);

const webm = await rec.finishRecording(r, 'demo.webm');  // closes context, returns the path
```

- Captions are written for **someone who has not read the ticket**: name the
  screen, the action, and the outcome — not the testid you clicked.
- `slowMo` is on so the video is watchable. Let overlays settle before the next
  step; a caption nobody can read is no caption.
- Record real data and the real journey. Intercepting `**/api/v1/**` is only for a
  state real data cannot reach, and then say so in the caption — a demo of a
  mocked state that claims to be live is the one thing that destroys the artefact.

## Attach the webm to the ticket

The webm goes on the **ticket** (the issue), as a note, so a stakeholder sees it
without the MR. GitLab renders an uploaded `.webm` as an inline player.

`upload_markdown` **rejects absolute paths and anything outside the project
directory** — a scratchpad or `artifacts/` path is refused every time, and the
refusal reads like a permissions error. So:

1. Copy the webm into a directory **inside the worktree** you are invoking from.
2. Pass the **relative** path to `mcp__gitlab__upload_markdown`; keep the URL/markdown it returns.
3. Post the note on the ticket with `mcp__gitlab__create_issue_note`, embedding
   what the upload returned, with one line of context (what the demo shows).
4. **Delete the copy** from the worktree once the upload returns — it must never
   reach the MR diff.

The ticket IID is `$ONESHOT_TICKET`. Upload before writing the note, and link only
what actually returned a URL. Two refusals: stop and report un-uploaded — not a
third shape of path.

## Re-run once, then warn with a reason

This phase is `onFail: warn` — a failed demo must never block a verified, reviewed
change from merging. So the one re-run it deserves is yours:

- On a flaky step or a failed upload, **retry the capture once**.
- If it still fails, **post a short note to the ticket** stating why there is no
  demo (what step failed, what you saw), and finish. Write `demo.json` with
  `{ status: "failed", reason, attempts }`.
- On success, write `demo.json` with `{ status: "ok", journey, ticketNoteUrl,
  webm: "<artifacts path>" }`.

A recorded gap a person can see beats a silent one.

## Honesty

- Record the feature actually working. Never stage a state by hand and narrate it
  as the feature.
- Do not caption a broken flow as a success. If the journey breaks mid-record,
  that is a real finding — stop, report the reason, do not dress it up.
- Do not modify the checkout under review to make the demo look better. The git
  guard refuses `checkout`/`restore`/`stash`/`reset`, and anything left altered
  here is what `merge` would carry.

## Teardown — leave it running

Do **not** stop the servers. `merge` follows on the same worktree and the app is
shared; the conductor reaps both processes by pid when the run ends. The webm lives
in `state/runs/<iid>/artifacts/demo/`, never on the branch.
