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
  outDir: `${process.env.ONESHOT_HOME}/state/runs/${process.env.ONESHOT_TICKET}/artifacts/demo`,
  title: 'Demo — <what the ticket delivers>',
});
// r.session is a local-browser-verify session; r.caption / r.ring / r.installOverlay are ready.
// ONESHOT_RUN_DIR is NOT in a phase session's environment — build the path from
// ONESHOT_HOME + ONESHOT_TICKET (the same dir the conductor reads the webm from),
// never `ONESHOT_RUN_DIR + ...`, which would be the literal string "undefined/...".

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
- **Admin-only features** (the change lives in the Django admin, with no React
  screen) record with `startRecording({ ..., admin: true })` and `rec.gotoAdmin(r,
  '/admin/<app>/<model>/')` instead of `gotoModule`. Admin mode authenticates
  against the Django admin and needs only Django on `$ONESHOT_PORT` — never the
  webpack bundle — so it still works when the SPA is down. The journey is the same:
  one caption per step, ring the control, drive it.

## The conductor posts the webm — you only record it

Do **not** call any GitLab tool. Session phases are off every GitLab write (that
is deliberate — a session that could post could also answer a reviewer on work
nobody has checked), and this one does not need to. You record the webm into
`artifacts/demo/` and name it in `demo.json`; the **conductor** attaches it to the
**ticket** (the issue) as an inline player once the phase finishes, exactly the way
it posts the ui-evidence pack. GitLab renders an uploaded `.webm` as an inline
player, and the webm never reaches the branch or the MR diff.

So there is nothing to upload, copy or delete by hand: get the webm onto disk under
`artifacts/demo/`, put its bare filename in `demo.json`, and stop.

## Re-run once, then warn with a reason

This phase is `onFail: warn` — a failed demo must never block a verified, reviewed
change from merging. So the one re-run it deserves is yours:

- On a flaky step, **retry the capture once**. If the first attempt already opened
  a browser, `rec.abortRecording(r)` it first so the retry does not leave a second
  chromium and a stale recording context alive.
- If it still fails, write `demo.json` with `{ status: "failed", reason, attempts }`
  — the conductor posts that reason to the ticket, so the gap is recorded where a
  person sees it.
- On success, write `demo.json` with `{ status: "ok", journey, webm, attempts }`,
  where `webm` is the **bare filename** under `artifacts/demo/` (e.g. `"demo.webm"`).

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
