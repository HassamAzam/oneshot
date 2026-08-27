---
name: self-remediation
description: Diagnose a run that has stopped and repair the environment around it so the pipeline can resume without a person. Use when asked to "unblock this run", "figure out why it stopped and fix it", "can this heal itself", or when Oneshot invokes its on-demand `remediate` phase (16) on a blocked run. Repairs the environment only — never edits the ticket's own change, and hands back fast when a human is genuinely required.
---

# Self-Remediation

A run has stopped and is waiting for someone. Your job is to make it able to
continue by repairing what is around it — the environment, the data, the
credentials, the caps. Not the work it was doing.

Most stops are not defects. On the run this phase was built for, nearly every
one was a missing demo credential, an account outside a group the feature is
gated behind, a wedged MCP spawn, a turn cap, or a budget an earlier lap had
already eaten. All of those are diagnosable and repairable without a person.

## Start from the block reason

- **Read it first and trust it.** The phase that stopped wrote it while it still
  had the failure in front of it, and those reasons are usually precise —
  "cannot log in as X", "the deployed SHA does not contain the merge", "phase
  ceiling reached". Treat it as the leading hypothesis, not as a rumour to
  re-derive from scratch.
- **Confirm it once, at the thing it names** — the endpoint, the login, the
  lock file, the quota row. One cheap observation separates a real cause from a
  plausible one.
- **Do not re-run the blocked phase to watch it fail.** That spends the budget
  the retry is going to need, and it tells you what the note already said.

## Classify before you fix

| Category | What it looks like | What to do |
|---|---|---|
| `environment` | config drift, a cap that was never large enough, a stale lock, a wedged process, a leased port nobody freed | Fix it |
| `provisioning` | data or a permission that simply does not exist on the target | Arrange the smallest version of it |
| `credentials` | a secret that is stale, unwired, or pointing at the wrong host | Fix it if it exists; a human if it does not |
| `infrastructure` | the box, the tunnel or the registry is down | Not yours. Hand back |
| `code` | the ticket's own change is wrong | Never fix. Send it back through the pipeline |
| `unknown` | you cannot place it | Say so, `fixed: false`, hand back quickly |

Name the category you concluded and the evidence for it. A wrong classification
is how a code defect gets "repaired" in the environment.

## Fix the environment, never the code

This is the line, and crossing it ships broken work.

Everything this pipeline produces is trustworthy because the diff was reviewed,
verified in a browser, and QA'd against a deployed build. A change made from
here meets none of those — it lands after the checks have already run, and the
run then finishes green over code nobody looked at. If the block really is a
defect, the remedy is `retryFrom: implement`, where the change goes back through
review and verify like any other.

The same rule covers the softer version of it: never loosen a check to make a
block go away. Do not rewrite a test case's `expected`, do not relax a guard, do
not widen a budget to hide a phase that is spinning. A cap that was never big
enough for the job is a real fix; a cap raised to accommodate a runaway loop is
the bug, dressed up.

## Prefer the app's own interfaces

- **Admin panel over database shell.** The admin enforces the same rules the UI
  enforces, so a permission granted there is a permission that actually works at
  the endpoint — and it writes an audit row someone else can read and undo. A
  shell bypasses the permission model and leaves nothing behind.
- **The app's own config over a hand-patched process.** A running process you
  patched dies with its host and takes the fix with it.
- **The smallest change that satisfies the precondition.** One group, one flag,
  one record. Never a reorganisation.
- **Never delete anything, never change another person's credential, never
  touch a record unrelated to the block.** These environments are shared, and
  admin actions are attributable. Behave as though someone will read the log,
  because they can.

## Verify at the surface that failed

- Prove the repair where the block happened: same URL, same account, same entry
  point. A grant that looks correct in the admin and still fails at the endpoint
  is the ordinary case, not the exotic one.
- **An unverified repair is `fixed: false`.** Say what you changed and that it is
  unproven. Resuming on an unverified fix spends a whole lap rediscovering the
  same block.
- Verify once: a fix that needs a second attempt was misdiagnosed. Re-classify.

## Record every change so it can be undone

`changes[]` carries one entry per change: what you changed, on which record or
file, from what to what — precise enough that someone else undoes it without
asking you. An env var and its old value. A group granted on a named account. A
lock file removed and the dead PID it referenced. A cap raised, from what to
what.

An empty `changes[]` with `fixed: false` is an honest, useful answer. An
unrecorded change is indistinguishable from someone else breaking their own
environment.

Stay inside the run's own state and the target environment. Never the ticket's
diff, never another run's state, never a shared secret store.

## Where to resume

`retryFrom` names the earliest phase whose failure your fix invalidates —
usually the phase that blocked. If the repair touched the deployed box, resume
from the phase that puts code there rather than the one that tests it: re-QA
against unchanged bytes is not a QA result. `''` means retry nothing, which is
the right answer whenever you fixed nothing or the fix still needs a person.

## Know when to stop

- You get **two attempts in a run, and never the same block twice.** Work as if
  yours is the only one.
- **Fast and honest beats heroic and wrong.** An outage and a genuine defect are
  both "a human decides", and saying so in five minutes is worth more than an
  hour that ends in a repair nobody asked for.
- `humanNeeded` is an instruction, not a lament: the action, where to perform
  it, and what it releases. "Investigate the deploy" helps nobody.
- Never provision a credential nobody has, restart infrastructure you do not
  own, rewrite published history, delete data, or spend outside the configured
  budgets. Those stop the run on purpose.
