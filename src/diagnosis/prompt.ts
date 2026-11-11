/**
 * The diagnosis session's prompt.
 *
 * It lives here, not in src/phases/prompts.ts, because the Loop never schedules
 * this phase and never builds a prompt for it: src/diagnosis/runner.ts invokes
 * it by name on a run that has already stopped. The system prompt is still the
 * shared one, so the trust rules and the finish contract are the same sentences
 * every other phase reads.
 *
 * The prompt carries the whole method in short form, as every prompt here does,
 * so a session that cannot resolve the `failure-diagnosis` skill still runs
 * correctly. The skill carries the judgement there is no room for: how to tell
 * a harness defect from a machine that was set up wrong, and what a finding
 * needs before it is worth a pull request.
 */
import { CATEGORIES } from './types.js';
import type { Evidence } from './evidence.js';

export interface DiagnoseCtx {
  evidence: Evidence;
  /** renderEvidence(evidence): the digest as text. */
  digest: string;
  /** Absolute path of the run directory the citations are relative to. */
  runDir: string;
  /** Absolute path of the Oneshot repository, for `repo:` citations. */
  repo: string;
  /** The command prefix that reads transcripts safely, ready to paste. */
  peek: string;
  /** What the repository is checked out at now, e.g. "some/branch @ 81b738e". '' when it could not be read. */
  repoHead?: string;
  budgetMin: number;
  /** Earlier diagnoses of this same run, oldest first. */
  earlier?: Array<{ headline: string; nextStep: string; findings: Array<{ id: string; category: string; title: string }> }>;
}

function earlierBlock(ctx: DiagnoseCtx): string {
  const list = ctx.earlier ?? [];
  if (!list.length) return '';
  return `## This run was diagnosed before, at an earlier stop

${list.map((d, i) => `${i + 1}. ${d.headline}
   next step given: ${d.nextStep}
${d.findings.map((f) => `   - ${f.id} [${f.category}] ${f.title}`).join('\n')}`).join('\n')}

It has stopped again, differently. Do not re-derive what is above: check whether each cause is
still there, say what is new, and carry forward only what still stands.

`;
}

export function diagnosePrompt(ctx: DiagnoseCtx): string {
  const e = ctx.evidence;
  const waiting = e.run.status === 'parked';
  return `# Diagnose run ${e.run.runId} — ticket #${e.run.iid}

This run has ${waiting ? 'parked, waiting on a person' : 'stopped, blocked'}, at \`${e.run.stoppedPhase || 'an unrecorded phase'}\`.
Someone is about to be asked to look at it. Tell them where it went wrong and what to do,
with evidence they can open.

You are a diagnostician and nothing else. You change NOTHING: no file, no git state, no
GitLab, no service, no database. Repairing the environment is the \`remediate\` phase's job
and it has had its turn; fixing the code is \`implement\`'s. A diagnosis that "also fixed it"
is a change nobody reviewed, on a run that is about to be read as evidence.

${earlierBlock(ctx)}## What the conductor already read for you

The run directory is \`${ctx.runDir}\`. It holds ${e.totals.transcripts} transcripts
(${Math.round(e.totals.transcriptBytes / (1024 * 1024))} MB). The digest below was computed from all of it, in
code: every journal record, every session start and result frame, every failed tool call.
The same digest, in full, is \`diagnosis/evidence.json\` in that directory.

${ctx.digest}

## Reading a transcript without drowning in it

One line of a transcript is one frame, and a frame can be hundreds of kilobytes: a tool result
holding a whole file. NEVER \`cat\`, \`Read\`, \`head\`, \`tail\`, \`sed\` or raw-\`grep\` a file under
\`transcripts/\`. Each of those puts whole frames into your context and ends your session early.
Use these instead; they print short, redacted excerpts with the line number of each frame:

\`\`\`
${ctx.peek} frames transcripts/verify-lap3.jsonl 180 195     # one line per frame, between two lines
${ctx.peek} frame  transcripts/verify-lap3.jsonl 194         # one frame, every block, each cut short
${ctx.peek} grep   'E_PORT_DRIFT'                            # every transcript of the run
${ctx.peek} grep   'could not read Username' transcripts/mr-lap0.jsonl
\`\`\`

The artifacts (\`run.json\`, \`findings.json\`, \`verify.json\`, \`remediate.json\` …) are small:
open them with Read. The harness's own source is \`${ctx.repo}\`: read it freely, it is where a
harness defect has to be shown.${ctx.repoHead ? ` It is checked out at ${ctx.repoHead}.` : ''} That is the code as
it is NOW, which may be newer than the code this run used. When a defect the run hit is already
fixed there, find the commit (\`git log\` is allowed), put its short SHA in \`fixedBy\`, and set
\`fix\` to \`operator\`: the remedy is running code that has the commit, and nothing is left to
write. \`fix: pr\` means a change that still has to be made. Say "this checkout", not a branch
name you have not verified: this checkout may be ahead of the repository's main branch.

## Method

1. **Start from the digest, not from the stop reason.** The reason is what the last phase
   said. The facts and the recurring failures are what the whole run shows, and the cause of
   a stop is usually several phases upstream of the phase that reported it.

2. **The journal's error text is a claim to check, never a finding.** "Claude Code process
   exited with code 1" described fifteen sessions of one run, and was true of none of them: two
   had run out of structured-output tries, one out of turns, and the rest had finished. For
   every failed, warned or repeated attempt, decide what actually ended it from its own
   result frame (the FIRST one after a session start) and from the last failed calls before
   it. The \`[masked-error]\`, \`[finished-then-exit]\`, \`[structured-output]\`, \`[turn-cap]\`
   and \`[no-result]\` facts are that comparison, already made. Confirm the ones you rely on.

3. **One finding per cause.** Six laps that died of one thing are one finding that names six
   laps. A run usually has two to seven causes. Account for every failed, warned and repeated
   attempt in the table: each belongs to some finding, or you say why it does not matter.

4. **Follow each cause to the thing that has to change.** Not "verify failed TC-21" but why:
   what the case needed, what the machine or the harness did not give it, and which file,
   setting or account that is.

   For a phase that ran several laps, read "What each lap of a repeated phase returned"
   before you believe the last lap. A review that re-grades a point it had settled, or
   raises new ones in code no lap touched, was never going to converge, and the laps it sent
   back through \`implement\` were the harness's cost, not the ticket's. A verify that fails
   the same one case every lap was not re-testing a fix. Laps that ran with nothing changed
   between them (same commits, same answer) were the conductor repeating itself: say which,
   and count them. The last lap's findings are not right because they are last.

5. **Classify each finding**, because the class decides who acts:
   - \`harness\` — Oneshot's own code, config, prompts, hooks, skills or setup scripts are
     wrong. The test: on a machine set up exactly as the docs say, would this still happen?
     If yes it is harness. A setup script that never provisions what a phase needs is harness.
     A harness finding MUST cite the code: open the file and quote the line with
     \`repo:<path>\`. Without the place in the code it is a guess.
   - \`environment\` — this machine, an account, a credential, a service or the network is
     not what a correct harness expects. An operator fixes it, on the machine.
   - \`ticket\` — the ticket's own change is wrong or unfinished. It goes back through
     \`implement\`; it is never fixed any other way.
   - \`human\` — nothing is broken. A decision is owed that only a person can make.
   When a check could not run, that is never the ticket's fault: do not class a finding
   \`ticket\` because a test the machine could not execute "failed".
   If you cannot tell harness from environment, say so in \`cause\`, class it \`environment\`
   and mark it \`probable\`: a wrong \`harness\` call sends agents to change code that was right.

6. **Cite, and expect to be checked.** Every finding needs \`evidence\`: a file, a line and
   text copied verbatim from that line. Code re-opens each one after you finish. A quote that
   is not in the file does not count, and a finding with no citation that holds is shown to
   the reader as an unproven lead. Paths are relative to the run directory
   (\`transcripts/verify-lap3.jsonl\`, \`run.json\`, \`diagnosis/evidence.json\`), or
   \`repo:<path>\` for this repository. For a transcript the line is the frame's line number,
   exactly as the peek commands print it. Copy the quote from what you actually read; do not
   reconstruct it from memory. To leave out the middle of a long line use \`…\`, at most twice,
   keeping parts of at least 12 characters each from that ONE line: a quote stitched from
   pieces of different lines is not found. What cannot be cited: your own output and
   transcripts (\`diagnosis.json\`, \`diagnosis/session.json\`, \`transcripts/diagnose-*\`), and
   in the repository anything that is not source (\`.env\`, \`state/\`, \`node_modules/\`).

7. **Name the decisive finding and the next step.** \`decisive\` is the one cause that, left
   in place, stops the next attempt too. \`nextStep\` is one action for someone with none of
   this context: what to do, where, and what it releases. Self-remediation's \`humanNeeded\`
   is often most of it already; start from it and correct it where the wider evidence
   disagrees.

8. **Record what is broken even when it did not stop this run.** A session that had no GitLab
   tools and worked around it, a fetch that was refused and then not needed, a guard that
   denied the same write in every lap: none of those ended the run, and each will cost the
   next one. Every \`[mcp-no-tools]\`, \`[mcp-not-connected]\`, \`[repeated]\`, \`[turn-cap]\` and
   \`[structured-output]\` fact, and every failure that recurs in three or more transcripts,
   is either part of a finding or its own finding. List those after the causes that mattered,
   say in \`cause\` that this run survived it, and class and cite them like any other. The
   only things you may leave out are ones you checked and found to be nothing: say which, in
   \`account\`.

Never recommend loosening a check to get the run through: not skipping a review finding, not
rewriting a test case's expectation, not raising a cap to cover a loop. If a cap was simply too
small for honest work, say which, from what to what, and what shows it.

## Budget

${ctx.budgetMin} minutes. The digest is most of the reading. Spend your turns confirming the
facts you build on and following the two or three causes that matter into the transcript or
the code. Stop when every attempt is accounted for; a finished diagnosis of five causes is
worth more than an unfinished one of nine.

Categories are exactly: ${CATEGORIES.join(', ')}.`;
}
