# Failure diagnosis

When a run stops and a person is wanted, Oneshot works out why and says so: on the ticket, on
the dashboard, and, when the cause is a defect in Oneshot itself, as a pull request with
the fix.

It is off unless a desk sets `ONESHOT_DIAGNOSIS=1`.

- [Why it exists](#why-it-exists)
- [When it runs](#when-it-runs)
- [What it reads](#what-it-reads)
- [What comes out](#what-comes-out)
- [The fix pull request](#the-fix-pull-request)
- [Settings](#settings)
- [By hand](#by-hand)
- [What it cost on the run it was built from](#what-it-cost-on-the-run-it-was-built-from)
- [Limits](#limits)

## Why it exists

A stopped run leaves one sentence on its ticket: whatever the last phase said, plus whatever
self-remediation added. The first ticket run on the server ended blocked after 88 phase records,
and reading its journal and transcripts by hand showed that the sentence was wrong about nearly
everything:

- Fifteen sessions were recorded as `Claude Code process exited with code 1`. Two had run out
  of structured-output tries, one out of turns, and the rest had **finished**: the CLI exits
  after a finished session when a background task's notice arrives late, and that text
  replaced each session's own result.
- Every session ran with no GitLab tools. The SDK reported the server `connected`.
- One test case could never pass: the machine could not create a Django test database. Five
  `implement` laps and six `verify` laps were spent on it.
- A code phase re-ran 59 times, once a minute, while the run was parked at a gate.

Almost all of it was the harness or the machine, not the ticket. Finding that took a person a
day. This does the same reading for every stop.

It is not the `remediate` phase with more turns:

| | `remediate` | diagnosis |
|---|---|---|
| Runs | inside a run that is about to block | after the run has stopped |
| Looks at | the one block in front of it | every attempt of the run |
| May change | the environment | nothing |
| May resume the run | yes | no |
| Answers | can this continue without a person | what were the causes, and whose are they |

`remediate.json` is one of the diagnosis's inputs, so what remediation established is not
derived twice. On that first run the diagnosis also corrected it: remediation asked for a
database role's password to be changed, and the diagnosis found the harness fix for the same
cause already in the checkout.

## When it runs

A watching conductor (`npm start`, not `--ticket` and not `--watch-only`) looks, once a tick,
at each of its tickets whose newest run is `blocked` or `parked` and stopped within the last
week. It is behind the same pause and usage-limit checks as everything else, it is
single-flight, and a pass starts **at most one diagnosis session**, newest stop first. It holds
no claim, no port and no dispatch slot. Its sessions are paid from the same subscription as
every run's, which is the one way it can cost a ticket anything. Several conductors on one
desk share one state directory and each makes this pass, so a stop is locked before anything
is paid for: the second conductor finds the lock, or the attempt already on record, and moves
on.

A stop is diagnosed **once**. What makes a stop the same stop is its content (`stopKey` in
[src/diagnosis/stop.ts](../src/diagnosis/stop.ts)): the run, its status, the phase it stopped
at, the reason it gave, and the *kinds* of trouble still standing on its journal. Not a
timestamp and not a count of records, because both change while nothing happens: a parked run
is re-claimed every tick and put back, and before the runner learned to step over a settled
code phase it gained a record a minute doing it. Of the reason, only the first paragraph
counts, with its counts and durations flattened: what follows a blank line is
self-remediation's own account, which reads differently the second time, and "next check in
27m" is the same wait a minute later. Deciding costs a read of `run.json` and of the
diagnosis's own record, and no transcript.

**Trouble** is what no later lap put right. A phase is judged by the last time it ran, so a
review that asked for changes and then passed, or a session that died and was re-attempted
successfully, leaves none: that is the pipeline working. What counts is a phase whose last run
failed, warned or was refused; a phase run five times (six for a session phase); and a
remediation. A `merge` poll that found the merge request still waiting for a person is not a
run of the phase, however many there are. Neither is the conductor's second record of one
session, its verdict on it. And a failure a person has settled at a gate (verify's failing
case, once QA has ruled on it) is history, not trouble.

| The run is | Diagnosed? |
|---|---|
| `blocked` | Yes, once it has stood for 20 seconds |
| `blocked` on the usage limit or a budget ceiling | No. It says what it is, and it clears by itself |
| `parked` with no trouble behind it: a clean run waiting for its plan to be approved, or for a person to merge | No. The gate's own note says what it is waiting for |
| `parked` with trouble behind it | Yes, once |
| `parked` again, later, with only trouble an earlier diagnosis of the run covered: the next gate, or the same gate worded differently | No |
| stopped at a stop it has already been diagnosed for | No, however often it is looked at |
| unblocked, and blocked again for the same reason | No. The first answer still holds |
| stopped again for a new reason, or with a new kind of trouble | Yes, and the session is given the earlier diagnosis |
| `running`, `done` or `aborted` | No |

With `reviewAllRuns` every run ends parked for a person's merge, which is why a park is held to
"something is still wrong": anything looser is a session and a comment on every healthy ticket.

Caps, for whatever that misses: four diagnoses per run and eight sessions per run however they
ended, twenty minutes between two diagnoses, two sessions per stop before it is given up on,
and nothing for a stop more than a week old or with no stop time on its journal (so turning
this on does not diagnose a desk's whole history). A session the conductor cancelled on its
way down, or that a usage limit cut off, is not counted against the stop the first two times.

The session takes minutes and the run does not wait for it. What happens to a diagnosis that
comes back depends on where the run is by then:

- still at that stop: the note is posted;
- stopped somewhere else, or ended: the diagnosis is kept for the dashboard and **not posted**;
- reading `running`: kept, with the note owed. That is a person having resumed it, or only the
  conductor's own tick, which re-claims a parked run and puts it back seconds later. The note
  is posted by a later look that finds the run back at this stop, and never if it has truly
  moved on.

## What it reads

The reading is done in code, not by the session. A run directory is tens of megabytes;
[src/diagnosis/evidence.ts](../src/diagnosis/evidence.ts) turns it into a digest of about
45 KB in a fraction of a second, and the session starts from the digest:

- **The journal**: every phase record, with identical consecutive code-phase records folded
  into one row.
- **Facts**, from comparing the journal with the transcripts. A record that says "process
  exited" over a session whose own result frame says `success`, `error_max_turns` or
  `error_max_structured_output_retries`. A failed record with no result frame at all. An MCP
  server that connected and exposed no tools. A code phase run dozens of times. A record is
  matched to its session by session id, not by position: once `unblock` or self-remediation
  drops a failed record the lap number is used again and the transcript appended to, and the
  record that survives belongs to the *last* session in the file. The sessions no record
  describes any more are a fact of their own.
- **What each lap of a repeated phase returned**, from each lap's own result frame, since the
  artifact on disk is only the last lap's.
- **Failures that recur**: failed tool calls, guard denials, schema rejections, CLI stderr and
  failure lines in the output of commands that exited 0 (background commands included),
  grouped across the whole run. A failure in one session is that session's. The same failure
  in ten is the machine's.
- **Artifacts**, gates and remediations, in brief.
- **The conductor's events** for the run from `state/oneshot.db`, and its **log** for the
  run's window: the systemd journal where the conductor runs as a unit
  (`journalctl -u oneshot-conductor`), or the file named in `ONESHOT_CONDUCTOR_LOG`. A missing
  log is a sentence in the digest, not an error.

Every entry carries a file and a line. The full digest is written to
`state/runs/<iid>/diagnosis/evidence.json`; the text handed to the session is bounded, section
by section, however large the run.

The session itself is the on-demand `diagnose` phase: heavy tier, 80 turns, 30 minutes, the
repository root as its working directory so it can read the harness's own source. It has **no
write tools** and is started **without the GitLab MCP server**. To look inside a transcript it
uses `npm run diagnose -- peek …`, which prints short redacted excerpts with line numbers and
never a whole frame: one line of a transcript can be hundreds of kilobytes. And its own words
are never read as a usage-limit notice: `phase.ts` reads every other session's prose for one
and parks the conductor when it finds it, and writing about a run that hit the limit is this
session's job.

Its answer is then **checked by code** ([src/diagnosis/citations.ts](../src/diagnosis/citations.ts)).
Every finding cites a file, a line and a quote, and each is re-opened:

- The file must be inside the run directory or this repository, links followed. It must be
  evidence: not the diagnosis's own output (its record, its session's answer, its own
  transcripts), and in the repository not `.env`, the state directory, `node_modules` or `.git`.
- The quote must be in it. A quote found a few lines off has its line corrected.
- A quote may leave out its middle. Then there are at most three parts, each at least twelve
  characters, close together on one line. Without that rule three words that occur somewhere
  in a file "are found" in it, in order, and so is a sentence nobody wrote.

A finding none of whose citations hold is shown as a *lead*, not a finding, and never gets a
fix opened for it.

## What comes out

Each finding is one cause, classed by who has to act:

| Category | Means | Fixed by |
|---|---|---|
| `harness` | Oneshot's own code, config, prompts, hooks, skills or setup scripts | a pull request on Oneshot |
| `environment` | this machine, an account, a credential, a service, the network | an operator, on the machine |
| `ticket` | the ticket's own change is wrong or unfinished | the pipeline, back through `implement` |
| `human` | nothing is broken; a decision is owed | a person |

A run is diagnosed against the code as it is now, which may be ahead of the code the run used.
When a cause is already fixed in the checkout, the finding names the commit and its remedy is
to run code that has it. It is shown as "already fixed by `<sha>`", and no fix is written for
it a second time.

**On the ticket**: one comment per diagnosed stop, headed **Oneshot diagnosis**. It carries
the one-sentence headline, what to do next, a table of the causes with whose each one is, the
account of what happened in order, and each cause collapsed with what was recorded, what
actually happened, the evidence and the fix. It is posted by code, from the checked diagnosis,
and only where this desk may write: a ticket that is unassigned or assigned to the account it
acts as, that is open, and that no other run has claimed since. Nothing is posted while the
desk is paused. It is a machine note, so the review gates never read it as a reviewer. It
cannot run a GitLab quick action or notify anyone, whatever a transcript it quotes contained,
and it cannot create or end a claim: the finished comment is read by the claim protocol's own
parser before it is returned, and one the parser would act on is never returned. If GitLab is
unreachable the note stays owed and is posted when it is back, without a second session; a
refusal GitLab means (no permission, no such ticket) is retried five times and then left.

**On the dashboard** (`npm run dashboard`): the run's page `/run/<iid>` is its transcript
report, and the report opens with the diagnosis: the headline, what to do next, and the causes
with whose each one is. The `diagnose` session's own transcript is listed there as run after
the stop, not as a phase of the run.

**On disk**: `state/runs/<iid>/diagnosis.json`, one entry per stop that was looked at. The
diagnosis never writes `run.json`: the runner holds the journal in memory and writes it back,
so a second writer would lose one side's change. Its own file has several writers too (the
conductor's pass, a diagnosis by hand, a fix running for an hour), so each re-reads it,
changes its own entry and replaces the file in one step. The ticket note and the fix pipeline
are driven from it, so the artifact guard keeps a run's own sessions from writing it, and what
is read back is held to its declared shape: a count is a number, a key is a key, and a stop
filed under one key that claims to be another is not a stop.

## The fix pull request

For a finding that is `harness`, to be fixed by a pull request, `confirmed`, evidenced, not
already fixed in the checkout, and shown in this repository's code by a `repo:` citation that
checked out, Oneshot can open the fix as a pull request. Four agents and a referee
([src/diagnosis/fix/pipeline.ts](../src/diagnosis/fix/pipeline.ts)):

1. **`fix-author`** writes the fix and a test that fails without it, and commits. It may
   refuse, and is told to: a defect that does not reproduce on the base branch, is already
   fixed there, or is really a design decision gets no pull request.
2. **The referee, which is code, measures.** The typecheck and the whole suite on the author's
   commits. And the reproduction: the author's changed tests are run against the base branch
   **without the fix**, in a second checkout, and must fail there, by the runner's own summary
   and its exit code. Tests that pass on the base do not show the defect, and neither does a
   run that printed no summary. A failed measurement goes back to the author before anyone
   reviews.
3. **Two `fix-review` sessions** read the diff independently, one for correctness and what the
   diff did not touch, one for whether the tests prove anything and the change is only what it
   says. Neither is given the author's account of its work. They run once, on the first round
   that passes every measurement.
4. **`fix-verify`** is handed every blocker the reviewers raised and told to refute each one by
   running the code, and is asked whether the change removes the diagnosed cause. A blocker it
   does not rule on counts as upheld. It exists because reviewers over-report: a multi-lens
   review of this repository raised 39 blockers of which 13 survived being checked.
5. Up to two fix rounds. A blocker that stood, a reviewer's or the verifier's own, goes back to
   the author and is then put to the verifier **again**: it is fixed when a verifier rules that
   it no longer holds, never because the author's lap returned. A round whose measurements
   failed leaves every standing blocker standing.
6. The referee publishes: one commit range, one branch
   (`fix/diagnosed-<iid>-<stop>-<finding>`), one pull request against the base, and, on a desk
   that posts, the link on the ticket with what was measured.

**A session is given no way to publish.** Three things stand in front of that:

- The fix is written in a private repository made for the one finding and deleted afterwards.
  It holds the base branch and nothing else of the operator's clone, no other branch and no
  unpushed work, and its only remote is that clone, a directory on this disk.
- For the fix phases the git guard holds git to an allowlist: read the change, and for the
  author commit it. No push, fetch, remote or config, and no git reached through a variable, a
  flag or another command.
- The one push to GitHub is the referee's, by address, of the exact commit the measurements
  ran on and the reviewers read. After each read-only session the checkout is put back at
  that commit, and a merge commit in the change is a refusal.

None of that is a sandbox. A session is a shell running as the operator, and one that wrote a
program to do what the guard refuses would not be stopped by it. The repository's branch
protection and the person who merges are the last line, which is one reason this step is off
unless a desk asks for it. Nothing is merged, and nothing in the pipeline can merge or turn
auto-merge on.

It refuses rather than guesses. No pull request when: the diff is over 15 files or 800 lines,
changes no test, changes source without a test that can be run against the base, or touches
`package.json`, the lockfile, `deploy/`, `.github/` or team configuration; a blocker survives
two rounds; the verifier will not confirm the cause is fixed, or says the change should not be
opened at all; the commits would publish something private, or hold a merge; a branch of the fix's name is
already on GitHub and is not this pipeline's pull request; GitHub cannot be asked; another
process is already fixing it. A finding that was looked at gets a recorded answer, including
"no pull request, and why", and `diagnosis.json` holds it. An attempt that was interrupted (a
pause, the usage limit, a shutdown) is recorded as held, not as tried.

A pull request is recognised as this pipeline's by a marker in its description that names the
ticket, the stop and the finding, because finding ids start again at `D-1` in every diagnosis
and a fork can give its branch any name.

The pull request's title is plain words, by the repository's own title rule: the commit
prefix comes off and names from the code are left as written. Its numbers are the referee's
own runs, with the commands, because this repository has no CI and the description is where a
reviewer looks. The repository is public and the ticket is not. The author is told to describe
the mechanism in the repository's terms; behind that, the title and the whole description have
credentials, private addresses, e-mail addresses, home directories, mentions and closing
keywords taken out, along with what the pipeline knows exactly is private: the work project's
host, the ticket's title and this machine's name. The commits cannot be rewritten, so they
are refused instead: a commit message or an added line that carries one of those, a real
e-mail address or a private network address, or a commit message with a mention or a closing
keyword, which GitHub acts on.

**Where it runs.** Wherever there is a clone whose `origin` is the GitHub repository and a `gh`
that is signed in. A machine without both records exactly that beside the finding and does
nothing. A run that happened on such a machine is fixed from a desk, once its run directory is
copied over (see [By hand](#by-hand)).

**What it is based on.** `origin/main` (`ONESHOT_FIX_BASE`), the branch every pull request on
the repository targets. The diagnosis is made against the code a run used, which may be ahead
of `main`. A defect in code that is not on `main`, or that is already fixed there, gets no pull
request. When none of the files the finding shows exist on `main`, that is refused before any
session starts; otherwise the author finds it out first and refuses.

## Settings

All optional, in `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `ONESHOT_DIAGNOSIS` | off | `1` turns the mode on for this desk's conductor |
| `ONESHOT_DIAGNOSIS_POST` | on | `0` keeps diagnoses on the dashboard and off the ticket |
| `ONESHOT_DIAGNOSIS_FIX` | off | `1` opens fix pull requests without being asked, at most two per stop |
| `ONESHOT_DIAGNOSIS_MAX_PER_RUN` | `4` | diagnoses one run may have |
| `ONESHOT_DIAGNOSIS_MIN_GAP_MIN` | `20` | minutes between two diagnoses of one run |
| `ONESHOT_DIAGNOSIS_MAX_AGE_DAYS` | `7` | a stop older than this is left alone |
| `ONESHOT_CONDUCTOR_LOG` | unset | a file the conductor's output is teed to, read instead of journald |
| `ONESHOT_CONDUCTOR_UNIT` | `oneshot-conductor` | the systemd unit whose journal is read |
| `ONESHOT_DASHBOARD_URL` | unset | the dashboard's address as people reach it; the note links the run there |
| `ONESHOT_FIX_REPO` | this checkout | a clone whose origin is the GitHub repository |
| `ONESHOT_FIX_BASE` | `main` | the branch fixes are cut from and target |
| `ONESHOT_FIX_WT_ROOT` | `../oneshot-fix-wt` beside the fix repo | where the private fix checkouts are made, and removed |

With `ONESHOT_DIAGNOSIS_FIX=1` the fix sessions run in the same pass, straight after the
diagnosis, and can take hours. The pass is single-flight, so no other stop is diagnosed until
they end.

Conductors on one desk are kept apart by the lock. Across desks nothing is shared but the
ticket: if two desks each hold a journal for the same ticket and both have this on, each
diagnoses its own run of it. A desk whose run no longer owns the ticket, because another
run's claim is now the oldest live one, does not post. A stopped run lives on the desk that
ran it, so in practice that is one desk.

## By hand

```bash
npm run diagnose -- evidence 9174        # the digest the session would get. No session, free
npm run diagnose -- 9174                 # diagnose this ticket's stopped run now. One session
npm run diagnose -- 9174 --post          # …and post the note
npm run diagnose -- show 9174            # the recorded diagnosis, as the note reads
npm run diagnose -- fix 9174             # open fixes for its eligible harness findings
npm run diagnose -- fix 9174 D-3         # …or for one finding
npm run diagnose -- fix 9174 D-3 --post  # …and say so on the ticket
```

By hand nothing is posted without `--post`, whatever the desk's settings are, and the waits,
the age limit and the judgement about what is worth a session are skipped. A stop that already
has its diagnosis is still never diagnosed twice: `<iid> --post` after a diagnosis that was not
posted posts that diagnosis, at no cost.

To diagnose, or fix from, a run that happened on another machine, copy its directory to
`state/runs/<iid>` here first: a session writes its transcript and its answer there, wherever
it was told to read. The diagnosis needs nothing else. `evidence` and `show` start no session
and read a copy wherever it lies: add `--dir <that directory>`.

## What it cost on the run it was built from

Measured three times, on a copy of that first run (22 MB, 25 transcripts, 88 phase
records), while the digest and the prompt were being changed between them. So this is a range,
not a repeated measurement:

| | Turns | Wall clock | Weighted tokens | Causes | Citations found |
|---|---|---|---|---|---|
| First | 34 | 8 min | 520k | 7 | 24 of 24 |
| Second | 52 | 9 min | 712k | 10 | 30 of 30 |
| Third | 35 | 6 min | 560k | 9 | 25 of 25 |

Building the digest took 0.15 s each time. The third session named, for seven of its nine
causes, the commit in the checkout that already fixes it. The run itself had spent 23.4M
weighted tokens. The budget in `config/phases.json` (80 turns, 30 minutes) is an estimate from
this one run and should be corrected from more.

## Limits

- **One run.** The prompt and the budget are tuned on a single run, read three times.
- **The fix pipeline has not opened a real pull request yet.** Its decisions are tested with
  everything scripted, and its git work against real repositories and a bare remote; the
  sessions and GitHub are stubbed in both. No live run of it has been made.
- **The reproduction check cannot tell why a test fails on the base.** A test that imports a
  module the fix adds fails at the import. The verifier is asked to read the tests for that.
- **The guards on a fix session are guards on command text, not a sandbox.** It holds no GitHub
  tool, no remote that reaches GitHub and a short list of git commands, and it is still a shell
  running as the operator. Where `gh` keeps its token in a plain file
  (`~/.config/gh/hosts.yml` on Linux) a session can read it, and no guard covers that file
  today. macOS keeps it in the keychain.
- **What is private is recognised only where it can be named.** A person's name, or a host the
  pipeline was never told about, is not something a pattern knows. The pull request is opened
  for a person to read, and that reading is the last check.
- **An interrupted fix is not come back to.** It is recorded as held, and
  `npm run diagnose -- fix <iid> <finding>` makes it again.
- **A run that is `aborted` is not diagnosed.** It resumes by itself on the next tick. A run
  that aborts on every tick is a stop this does not see.
- **A park with nothing still wrong behind it is not diagnosed**, even when laps were lost on
  the way to something that later passed, or something is quietly wrong, such as sessions
  without their MCP tools. Those causes are found at the first stop that has trouble standing.
- **Same defect, many tickets.** Each run that hits a harness defect has it diagnosed again.
  Fix pull requests are deduplicated per stop and finding, not across runs.
- **Spend is booked to the stopped run.** With budgets on (they are off today) a diagnosis
  counts toward that run's own ticket ceiling.
- **A dry run still diagnoses.** `DRY_RUN` withholds every write, the note included, and the
  session still runs. The fix pipeline starts nothing under it.
- **The Board** does not show diagnoses.
