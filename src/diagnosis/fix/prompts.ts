/**
 * Prompts for the three fix sessions.
 *
 * Each session is told only what its job needs. The reviewers are handed the
 * diagnosis and the diff and NOT the author's account of its own work, and the
 * verifier is handed the reviewers' points and NOT their confidence: a session
 * given a conclusion tends to return it confirmed.
 */
import type { CheckedFinding } from '../types.js';
import type { ReviewPoint } from './decide.js';

export interface FixCtx {
  iid: number;
  /** How the public repository names the work project's ticket: `erp#9174`. */
  ticketRef: string;
  finding: CheckedFinding;
  /** The fix worktree: a checkout of the base branch on its own branch. */
  worktree: string;
  branch: string;
  base: string;
  /** Ready-to-paste commands that work under the session's guards (no npx, no installs). */
  commands: { typecheck: string; tests: string; oneTest: string; hooks: string };
  /** What the pipeline ran itself on the author's commits, for the reviewers and the verifier. */
  measured?: string;
}

const measuredBlock = (c: FixCtx): string => (c.measured
  ? `## What the pipeline already measured on these commits

${c.measured}

These were run by code, not reported by the author. You may re-run any of them.

`
  : '');

function findingBlock(f: CheckedFinding): string {
  const evidence = f.evidence.filter((c) => c.ok)
    .map((c) => `  - ${c.file}:${c.line} — "${c.quote.replace(/\s+/g, ' ').slice(0, 260)}"`).join('\n');
  return `### ${f.id} — ${f.title}

Affected: ${f.phases || '(not stated)'}
Recorded as: ${f.recorded || '(the recorded error was accurate)'}

What happened:
${f.cause}

What the diagnosis says to do:
${f.solution}

Where: ${f.where.join(', ') || '(not stated)'}

Evidence that was re-opened and found (\`repo:\` paths are this repository as the run had it):
${evidence || '  (none)'}`;
}

const HOUSE_RULES = (c: FixCtx): string => `## This repository

It is the Oneshot conductor: TypeScript, run with tsx, tested with node:test. You are in
\`${c.worktree}\`, on branch \`${c.branch}\`, cut from \`origin/${c.base}\`. It has no CI: the
numbers in a pull request are whatever was run by hand, so run things.

Commands that work here (\`npx\` and every package install are denied by a guard, on purpose):
\`\`\`
${c.commands.typecheck}
${c.commands.tests}
${c.commands.oneTest} src/path/to/file.test.ts
${c.commands.hooks}        # only if you touch hooks/
\`\`\`

House style, which reviewers hold a change to:
- Decisions are pure functions with tests beside them (\`src/**/*.test.ts\`, node:test +
  assert/strict, names that read as sentences about behaviour). GitLab, GitHub and model
  sessions are stubbed, never called. The suite does not use module mocking.
- A file's header comment says WHY it exists and what failure it prevents. Comments explain
  mechanism and the incident behind a rule, not what the next line does.
- Guards fail open unless they stand in front of something irreversible.
- Commits are \`type(scope): lowercase imperative\`, with a body giving the mechanism, the
  failure it fixes and what was deliberately not done.

Never \`git stash\`, and never push: this checkout is a private clone made for this one fix, its
\`origin\` is a directory on this machine, and the pipeline publishes the commit it has checked.
Commit on the branch you were given and stay on it: the commit that is measured and published
is the one \`HEAD\` is at when you finish.

The repository is PUBLIC. The ticket it serves is not. Nothing you commit and nothing you
write for the pull request may carry ticket text, a person's name, a hostname or address, a
credential, or a path outside this repository. Refer to the run as ${c.ticketRef}.`;

export function fixAuthorPrompt(c: FixCtx, round: number, blockers: ReviewPoint[] = []): string {
  const again = round > 0
    ? `## This is fix round ${round}

Your change is on the branch already. It was checked and reviewed, and these points stand
against it. Each one was either measured by the pipeline or upheld by a verifier who tried to
refute it, so treat each as true until you have shown otherwise by running something:

${blockers.map((b) => `- **${b.id}** ${b.file ? `(\`${b.file}${b.line ? `:${b.line}` : ''}\`) ` : ''}${b.what}
  why: ${b.why || '(not given)'}${b.fix ? `\n  suggested: ${b.fix}` : ''}`).join('\n')}

Answer every one, in \`addressed\`: what you changed, or the command and output that shows it
does not hold. Then re-run the typecheck and the whole suite, and commit.

`
    : '';
  return `# Fix a diagnosed harness defect — ${c.ticketRef}, finding ${c.finding.id}

A run of the pipeline stopped, and its diagnosis attributed one cause to this repository's
own code. Your job is to fix that one cause, with a test that proves it was there.

${again}## The finding

${findingBlock(c.finding)}

${HOUSE_RULES(c)}

## What to do

1. **Read the code the finding names, on THIS branch.** The diagnosis was made against the
   code a run was using, which may be ahead of or behind \`${c.base}\`. Find out whether the
   defect is here. If the code it describes is not on this branch, or is already fixed here,
   stop: \`outcome: 'refused'\` and say which. That is a correct result.
2. **Reproduce it first.** Write a test that fails because of the defect, run it, and watch
   it fail for the diagnosed reason. A test that only passes after your change proves
   nothing on its own: the pipeline will run your test against \`${c.base}\` without your
   fix, and a test that passes there sends the change back.
3. **Make the smallest change that removes the cause.** One cause. No refactoring on the
   way past, no fixing of other things you notice (put those in \`summary\`), no new
   dependency, no change to \`package.json\`, \`package-lock.json\`, \`deploy/\` or \`.github/\`.
4. **Run the typecheck and the whole suite**, and \`${c.commands.hooks}\` if you touched
   \`hooks/\`. Fix what you broke.
5. **Commit** on \`${c.branch}\` in the house style. Do not push, do not open a pull request,
   do not switch branches: the pipeline does those after the review.

## When to refuse

Refusing is part of the job, and a wrong pull request costs more than no pull request.
Return \`outcome: 'refused'\` with the reason when:
- it does not reproduce on this branch, or it is already fixed here;
- the fix is a design or cost decision rather than a defect: more than one reasonable
  behaviour, and the diagnosis picked one without an observed failure that settles it;
- it would need more than about 15 files or 800 lines, which is a redesign;
- proving it needs a test pattern this suite does not use;
- the cause is not in this repository after all.

Your structured output is your handoff. \`prSummary\`, \`prWhy\` and \`prTests\` go into a
public pull request as written, so write them for a reader who has never seen the ticket.
\`title\` is the pull request's title: plain words saying what the change does, not a commit
subject, so no \`fix:\` prefix (your commits keep theirs).`;
}

export const REVIEW_LENSES: Record<'A' | 'B', { name: string; brief: string }> = {
  A: {
    name: 'correctness',
    brief: `Does the change remove the diagnosed cause, and does it break anything else?
- Trace the changed code's callers. The best findings in this repository have been about what
  a diff did NOT touch: a sibling call site left inconsistent, a second place the same
  assumption lives.
- Every guard and every conductor decision has a fail-open or fail-closed contract. Name any
  the change alters.
- Think about the states the conductor is really in: a resumed run, a parked run re-entered
  every minute, two conductors on one board, a session that was cancelled mid-write.
- Run the tests that cover the changed code, and read what they assert.`,
  },
  B: {
    name: 'tests and scope',
    brief: `Is this proven, and is it only what it says it is?
- Would each new test fail without the fix, for the diagnosed reason, or does it pass either
  way? A test that asserts what the code does rather than what it must do pins nothing.
- Is anything here beyond the one cause: a refactor, a rename, a second fix, a new option?
- Does it follow the house style: pure decision functions, stubbed GitLab/GitHub/sessions, a
  header comment that says why, no module mocking?
- The repository is public. Is there ticket text, a name, a host, an address or a credential
  anywhere in the diff or the commit messages?`,
  },
};

export function fixReviewPrompt(c: FixCtx, lens: 'A' | 'B'): string {
  const l = REVIEW_LENSES[lens];
  return `# Review a fix for a diagnosed harness defect — ${c.ticketRef}, finding ${c.finding.id}

Another session wrote a change for the finding below. Review it. You are one of two reviewers
working independently; yours is the **${l.name}** review.

You change nothing: no edits, no commits. Run whatever you need to.

## The finding the change is meant to fix

${findingBlock(c.finding)}

## The change

It is the commits on \`${c.branch}\` over \`origin/${c.base}\`, in \`${c.worktree}\`:
\`\`\`
git log --oneline origin/${c.base}..HEAD
git diff origin/${c.base}...HEAD
\`\`\`
Read the diff in full, then read the code AROUND it.

${measuredBlock(c)}${HOUSE_RULES(c)}

## Your review

${l.brief}

## Severity

Three levels, and only the first blocks:
- **blocker** — it is wrong, it breaks a fail-open/fail-closed contract, or it ships
  something unproven. Say what input or state produces what wrong result.
- **nit** — real, not blocking.
- **note** — an observation, not a request.

Do not invent severities and do not pad. A review with no blockers says so. Every blocker you
raise will be handed to a third session whose only job is to refute it by running the code, so
raise what you can show, with the file and line, and say in \`verified\` what you ran.`;
}

export function fixVerifyPrompt(c: FixCtx, points: ReviewPoint[], round: number): string {
  const blockers = points.filter((p) => p.severity === 'blocker');
  return `# Verify a reviewed fix, adversarially — ${c.ticketRef}, finding ${c.finding.id}

A change was written for the finding below and two reviewers have read it. Your job is to
find out which of their blockers are TRUE, and whether the change does what it is for.

Reviewers over-report. In this repository a multi-lens review once raised 39 blockers of which
13 survived being checked, and two reviewers agreeing was not evidence: they had read the same
diff with the same assumptions. So do not weigh the points. Test each one.

You change nothing: no edits, no commits, no checkouts. Run whatever you need to; scratch files
go under /tmp, and the checkout is put back to the reviewed commit when you finish.
${round > 0 ? `\nThis is after fix round ${round}. The blockers below STOOD after an earlier round: a verifier tried to refute each and could not, or raised it itself. The author has committed again since. Rule on each as the code stands NOW: \`holds: false\` only when you have run something that shows it no longer holds, and say what. The author saying it is fixed is not evidence.\n` : ''}
## The finding

${findingBlock(c.finding)}

## The change

The commits on \`${c.branch}\` over \`origin/${c.base}\`, in \`${c.worktree}\`:
\`\`\`
git diff origin/${c.base}...HEAD
\`\`\`

${measuredBlock(c)}${HOUSE_RULES(c)}

## The blockers to rule on

${blockers.length ? blockers.map((b) => `- **${b.id}** ${b.file ? `(\`${b.file}${b.line ? `:${b.line}` : ''}\`) ` : ''}${b.what}
  the reason given: ${b.why || '(none given)'}`).join('\n') : (round > 0 ? '(none are standing)' : '(none were raised)')}

For each: try to REFUTE it. Construct the input or the state it describes and run it. Read
the code path it claims is wrong. \`holds: true\` means you tried and it stood; \`holds: false\`
means you can show it does not, and \`reason\` says what you ran and saw. A blocker you do not
rule on is treated as upheld, so rule on every one.

## Then, the question nobody was asked

Independently of the reviewers: does this change remove the diagnosed cause?
- The pipeline ran the changed tests against \`origin/${c.base}\` without the fix (above). Read
  those tests: do they fail there for the DIAGNOSED reason, or for an unrelated one such as a
  module that does not exist yet? Only the first is a reproduction.
- Run the whole suite and the typecheck on this branch.
- Ask what the diagnosis observed, and whether that observation could still happen with this
  change in place.

\`fixesTheCause\` is true only if you confirmed that yourself. Add anything blocking that the
reviewers missed to \`additional\`. \`verdict\` is \`ship\`, \`fix-first\` (the author can answer
what stands) or \`do-not-ship\` (this change should not be opened: say why).`;
}
