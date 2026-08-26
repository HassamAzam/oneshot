---
name: demo-server-qa
description: Execute an already-written test-case list against a DEPLOYED build and return a per-case verdict, after proving the build under test is the one that carries the change. Use when asked to "QA this on the demo server", "verify it on dev/stage", "run the cases against the deployment", or when Oneshot's phase 11 runs. Does not write cases, does not fix anything, and does not test the local checkout.
---

# Demo Server QA

The same shared case list, executed against a deployed build. Not a new test
plan, and not a second opinion on the code.

## Establish the build before you test anything

This comes first, before a single case runs.

- **Ask the server what is live**, not the deploy step. A deploy script that
  exited 0 reports that a command succeeded, not that your commit is serving
  traffic.
- The deploy ships a **branch tip**, not a specific SHA. Between merge and
  deploy, another commit can be what actually shipped.
- **The live build must contain this run's merged SHA.** If it does not:
  **block, do not test.** A green verdict recorded against the wrong build is
  worse than no verdict at all — it is a false clearance that nobody re-checks.
- **On a re-QA lap, the live SHA must differ from the previous lap's.** Identical
  means the redeploy did not take, and re-observing the same failures against the
  same bytes is not a QA result. Block.

State the SHA you tested against in the output. Every downstream note quotes it.

## Executing

- **Per case: pass / fail / blocked / skipped, with evidence.** Never a bulk
  verdict, never "all cases passed".
- Evidence is actual vs expected. Screenshot every fail.
- **Demo data is not local data.** A case whose precondition does not exist on
  this server is `blocked` for that case, with the missing data named — not a
  fail, and not a silent skip.
- Log in through the real UI as the role the case names. Permission behaviour is
  half of what only a deployed run can tell you.

## Environment or code

Compare each result against the local verify result for the same case id.

| Local | Here | Read it as |
|---|---|---|
| pass | fail | Environment first — missing data, unrun migration, config drift. Then code. |
| fail | fail | Code. |
| pass | pass | Done. |
| not run | fail | Report as-is; do not infer a local result you do not have. |

Say which of the two you concluded and why. **Never soften a demo failure
because it passed locally** — the deployed build is the one users get.

## Verdict

- `pass` only when every case passed or was legitimately skipped with a reason.
  One fail at any blast level is `fail`.
- **`fail` is a normal answer, not a block.** A failing verdict is this phase
  working correctly; it sends the run back to fix something real.
- Block only for: cannot reach the server, cannot log in, or the SHA does not
  match. The box is VPN-gated, so unreachable is a plausible and correct block.

## Hard rules

- **Never fix anything from this phase.** Not the code, not the data, not the
  config on the server. You are the only step in the pipeline whose report is
  untainted by having also changed something.
- Never test the local checkout because the server is awkward. That is a
  different phase and it already ran.
- Never re-word a case's `expected` to match what you observed.
