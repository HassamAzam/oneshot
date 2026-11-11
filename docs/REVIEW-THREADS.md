# Code review as threads on the merge request

On a run that has a merge request by the time `review` is reached (the `erp` target, where
`mr-open` opens a Draft straight after `implement`), the code review is two sessions with two
jobs, and the conductor does the posting for both.

```
review (reviewer) ──findings──▶ conductor posts one thread per finding on the MR
                                        │
              open threads ◀────────────┘
                   │
review-fix (fixer) ──answers──▶ conductor pushes, replies on each thread, resolves the fixed ones
                   │
review (re-check) ──rulings───▶ conductor reopens / withdraws / leaves resolved
                   │
       nothing open ─▶ verify …        still open after the fix laps ─▶ parked for a person
```

| | Reviewer — `review` | Fixer — `review-fix` (on demand) |
|---|---|---|
| Model tier | heavy | standard |
| Worktree | read-only | edits and commits |
| Returns | `findings`; on a re-check, a ruling per thread | an answer per thread it was handed |
| Cannot | change code | raise a finding (an id it was not handed is ignored) |

Neither session holds a GitLab write tool. Code: `src/review/` (pure modules with tests, wired in
`src/conductor/runner.ts`); the judgement both sessions are given is `skills/review-threads`.

## What lands on the merge request

- **One resolvable thread per finding**, on the diff line when the line is in the diff, otherwise
  on the MR with `file:line` in the note. Each starts `F-03 · major — …` with why it matters and a
  suggested fix.
- **The fixer's reply** on the thread: `Fixed in <sha> — …` (thread resolved) or `Not changed — …`.
  A declined blocker or major stays open. A declined minor or suggestion is closed with its
  reason: this project refuses to merge with an unresolved thread, and a non-blocking note that
  will not be taken up should not need a person to click it away.
- **The reviewer's ruling** when it is not a plain acceptance: `Reopened — …`, `Withdrawn — …`,
  or `Still stands — …`.

Every note ends with a hidden marker, `<!-- oneshot:review role=… finding=F-03 action=… -->`.
The reviewer and the fixer post as one account, so the marker is what tells a finding, an answer
and a person's comment apart.

## What makes it converge

The loop it replaced re-reviewed the whole change every lap and handed findings to `implement`.
On #9174 lap 2 raised a lap-0 suggestion to a blocker, lap 4 raised two new majors against a test
added at the reviewer's own suggestion, and the run reached a merge that could only refuse.

1. **Severity is fixed when a thread is raised.** A re-check can reopen a thread, never re-grade
   or re-number it.
2. **A re-check may raise a new thread only** for a blocker, or for a defect in a file the commits
   since the last review touched. Anything else is dropped by the conductor (kept in
   `review-threads.json` under `dropped`).
3. **Declined by the fixer and upheld by the reviewer goes to a person at once**, instead of
   the two sessions spending the remaining laps disagreeing.

## When it needs you

`review.maxLaps` (3) is the number of fixer laps per review, counted since the code last changed
outside the loop. If a blocker or major is still open after them — or the two sessions disagree
on one — the run **parks** (it is not blocked, and nothing is re-labelled) and posts one note on
the ticket listing each open thread with a link. `verify` has not been spent on it.

To move it on, on the merge request:

- **Resolve the thread** once you have decided it. The next conductor tick sees it and the run
  continues.
- **Reply on the thread** with what to do. A reply from a configured reviewer
  (`config/reviewers.json`) is handed to the fixer as the instruction for that thread, even past
  the lap cap. Anyone else's reply is ignored.

## At merge

`merge` reads the reviewer threads as they stand on GitLab at that moment and parks while one is
open, naming it. It does not read `findings.json`, which is now only a view the conductor
rewrites from the ledger (`verdict` is `changes-requested` exactly while a blocker or major is
open). A reply you leave inside a reviewer thread while the run waits at merge goes through
`mr-feedback`, like any other review comment.

## Files

| File (under `state/runs/<iid>/`) | What it is |
|---|---|
| `review-threads.json` | the loop's ledger: each thread, its state, what is still owed to GitLab. Conductor-owned; sessions cannot write it |
| `findings.json` | a view of what is open now, for the phases that read it |
| `review-fix.json` | the fixer's last answer |
| `transcripts/review-lap*.jsonl`, `review-fix-lap*.jsonl` | the sessions |

## Switching it off

`ONESHOT_REVIEW_THREADS=0` in the env file puts the desk back on the old loop (review cycles to
`implement`; merge reads `findings.json`) at the next conductor start. A dry run, and a run with
no merge request at review time, use the old loop as well. A run that the old loop already
reviewed is not re-reviewed uninvited: `npm run unblock -- <iid> --force-phase review` moves it
onto the thread loop.
