import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelledLayers, mrOpenNote, promptFor, systemPromptFor, type PromptCtx } from './prompts.js';
import { gateSubjectDigest } from '../lib/artifacts.js';
import { ROOT, phaseByName, phases, runDir, type PhaseConfig } from '../lib/config.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDesignTokens } from '../lib/designtokens.js';
import type { Ticket } from './types.js';
import { PRIOR_ART_KINDS, RESEARCH_SCHEMA } from '../conductor/schemas.js';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    iid: 1, title: 'A ticket', description: null, labels: ['Loop'], ...over,
  };
}

function ctx(t: Ticket, prior: Record<string, Record<string, unknown> | null> = {}): PromptCtx {
  return { ticket: t, runId: 'r-test', lap: 0, journal: {}, prior } as unknown as PromptCtx;
}

const cfg = (name: string): PhaseConfig => {
  const c = phaseByName(name);
  assert.ok(c, `phase ${name} is configured`);
  return c;
};

/** The Skill tool is told about a skill by name, one per line. */
const names = (prompt: string): string[] =>
  [...prompt.matchAll(/^ {2}- (\S+)$/gm)].flatMap((m) => (m[1] ? [m[1]] : []));

// ------------------------------------------------------------ the label gate

test('the accessibility label puts the skill in front of the plan', () => {
  const prompt = systemPromptFor(cfg('plan'), ctx(ticket({ labels: ['Accessibility', 'Loop'] })));
  assert.ok(names(prompt).includes('frontend-accessibility'));
});

test('without the label the plan is not offered it', () => {
  const prompt = systemPromptFor(cfg('plan'), ctx(ticket({ labels: ['Loop'] })));
  assert.ok(!names(prompt).includes('frontend-accessibility'));
});

test('the ticket text is not a signal — only the label is', () => {
  // Deliberate: the whole point of moving to labels is that one field decides
  // this, so a ticket that reads as an a11y ticket but was never labelled is a
  // triage miss rather than a quiet half-match.
  const prompt = systemPromptFor(cfg('plan'), ctx(ticket({
    title: 'Error messages provide insufficient correction guidance',
    description: 'A web accessibility issue that violates WCAG 3.3.1.',
    labels: ['Loop'],
  })));
  assert.ok(!names(prompt).includes('frontend-accessibility'));
});

test('a label that differs only in case still counts', () => {
  // Labels are typed by hand. A case slip must not silently disable a skill.
  const prompt = systemPromptFor(cfg('plan'), ctx(ticket({ labels: ['accessibility'] })));
  assert.ok(names(prompt).includes('frontend-accessibility'));
});

test('the mapping is config, so any label can carry any skill', () => {
  // Nothing about the mechanism is accessibility-shaped: this pair exists only
  // in this test's config, and no code knows the label or the skill.
  const synthetic = {
    ...cfg('plan'),
    skills: ['planning-methodology'],
    labelSkills: { Frontend: 'react-frontend-standards' },
  };
  const got = names(systemPromptFor(synthetic, ctx(ticket({ labels: ['Frontend'] }))));
  assert.deepEqual(got, ['planning-methodology', 'react-frontend-standards']);
  assert.deepEqual(
    names(systemPromptFor(synthetic, ctx(ticket({ labels: ['Loop'] })))),
    ['planning-methodology'],
  );
});

// `plan` declaring change-scoping unconditionally is asserted further down, by
// 'plan declares change-scoping, and not the discovery pair it replaced'.

// ------------------------------------------------ recall has a method now

test('recall is given a method, not just a prompt', () => {
  // Phase 0 was the last session phase carrying its whole method inline. The
  // scoring ladder in particular was four lines of prompt with no room to say
  // why each rung outranks the next.
  assert.deepEqual(names(systemPromptFor(cfg('recall'), ctx(ticket()))), ['prior-art-recall']);
});

test('the skill recall declares actually ships in this repo', () => {
  // recall runs at cwd 'conductor', so it resolves skills from the .claude that
  // ensureClaudeDir composes at the Oneshot root. A name in config with no
  // directory behind it fails silently — the phase just runs without it.
  assert.ok(existsSync(join(ROOT, 'skills', 'prior-art-recall', 'SKILL.md')));
});

test('the recall prompt still stands alone if the skill does not resolve', () => {
  // Skills are an upgrade, never a dependency (see SKILL_LINE): the prompt has
  // to carry enough to run correctly by itself. The empty-memory stop is the
  // part that must survive — without it the phase explores a filesystem that
  // has nothing to find, on the tightest budget in the pipeline.
  const p = promptFor(cfg('recall'), ctx(ticket()));
  assert.match(p, /prior-art-recall/, 'the prompt must name the skill');
  assert.match(p, /STOP IMMEDIATELY and return an empty list and an empty brief/);
  assert.match(p, /file-path overlap first/, 'the ladder must survive in the short form');
  assert.match(p, /then module, then label, then\s+title-token overlap/);
});

// ------------------------------------------ plan knows how scheduling is done

test('plan is told how recurring work gets scheduled, for every ticket', () => {
  // ERP #8344: the plan proposed seeding PeriodicTask rows in a data migration
  // for a recurring reminder. The mechanism is chosen here and implement cannot
  // walk it back — by then the migration exists and review checks the diff
  // against the plan, not the plan against the repo. Unlabelled on purpose: a
  // labelSkills entry needs triage to already know it is a scheduling ticket,
  // and not knowing is the failure this closes.
  const got = names(systemPromptFor(cfg('plan'), ctx(ticket())));
  assert.ok(got.includes('django-scheduled-jobs'), 'plan must declare the scheduling skill');
});

test('plan gets the scheduling skill eagerly, not lazily', () => {
  // Only implement uses the lazy SKILL_LINE. A lazily-offered skill is one the
  // session may skip after reading the plan — but here the skill is what tells
  // it the plan may be wrong, so it has to be read before the plan is written.
  const p = systemPromptFor(cfg('plan'), ctx(ticket()));
  assert.match(p, /Invoke these with the Skill tool BEFORE you start/);
  assert.doesNotMatch(p, /Read the plan first/, 'plan must not get implement\'s lazy wording');
});

test('the scheduling skill plan declares actually ships in the snapshot', () => {
  // plan runs at cwd 'worktree', so it resolves skills from the .claude that
  // ensureClaudeDir composes there — context/skills first. A name in config with
  // no directory behind it fails silently and the phase just runs without it.
  assert.ok(existsSync(join(ROOT, 'context', 'skills', 'django-scheduled-jobs', 'SKILL.md')));
});

// --------------------------------------------- implement's gating is unchanged

test('implement keeps a plan-gated skill when there is no plan to gate on', () => {
  const got = names(systemPromptFor(cfg('implement'), ctx(ticket())));
  assert.ok(got.includes('django-migration-standards'));
  assert.ok(got.includes('script-writing-standards'));
});

test('implement drops a plan-gated skill the plan rules out', () => {
  const got = names(systemPromptFor(cfg('implement'), ctx(ticket(), {
    plan: { migrations: false, steps: [{ files: ['frontend/src/App.js'], layer: 'frontend' }] },
  })));
  assert.ok(!got.includes('django-migration-standards'));
  assert.ok(!got.includes('script-writing-standards'));
});

// ------------------------------------------- ui-evidence only claims a real approval

const DESIGN = {
  applicable: true,
  screens: [{ id: 's1', name: 'Completed list', screenshot: 's1.png' }],
};

function uiEvidencePrompt(gate: Record<string, unknown>, design: unknown): string {
  return promptFor(cfg('ui-evidence'), {
    ticket: ticket(), runId: 'r-test', lap: 0,
    journal: { designApproval: gate },
    prior: { design },
  } as unknown as PromptCtx);
}

test('ui-evidence pairs against the design when the approval covers it', () => {
  const gate = {
    requestTs: 'x', approved: true, feedback: [],
    approvedDigest: gateSubjectDigest(DESIGN),
  };
  assert.match(uiEvidencePrompt(gate, DESIGN), /is this what I approved/);
});

test('ui-evidence stops claiming approval once the design was rewritten', () => {
  // The caption is a factual claim to the reviewer -- "a human approved these
  // screens before the code was written". Against a design rewritten after the
  // sign-off that is false, and saying nothing is better than captioning the
  // wrong screens as approved.
  const gate = {
    requestTs: 'x', approved: true, feedback: [],
    approvedDigest: gateSubjectDigest({ ...DESIGN, screens: [] }),
  };
  assert.ok(!uiEvidencePrompt(gate, DESIGN).includes('is this what I approved'));
});

test('an approval predating digests still pairs, so upgrades do not regress', () => {
  const gate = { requestTs: 'x', approved: true, feedback: [] };
  assert.match(uiEvidencePrompt(gate, DESIGN), /is this what I approved/);
});

test('plan does not tell itself a stale design was approved', () => {
  const gate = {
    requestTs: 'x', approved: true, feedback: [],
    approvedDigest: gateSubjectDigest({ ...DESIGN, screens: [] }),
  };
  const planDesign = {
    applicable: true,
    screens: [{ id: 's1', name: 'Completed list', purpose: 'p', mockupHtml: 's1.html', screenshot: 's1.png' }],
  };
  const stale = promptFor(cfg('plan'), {
    ...ctx(ticket()), journal: { designApproval: gate }, prior: { design: planDesign },
  } as unknown as PromptCtx);
  assert.ok(!stale.includes('A human approved these screens'));
  assert.match(stale, /No approval covers this version/);

  const covering = { ...gate, approvedDigest: gateSubjectDigest(planDesign) };
  const fresh = promptFor(cfg('plan'), {
    ...ctx(ticket()), journal: { designApproval: covering }, prior: { design: planDesign },
  } as unknown as PromptCtx);
  assert.match(fresh, /A human approved these screens/);
});

// ------------------------------------------- plan does not order frontend unit tests

test('plan is told not to put a Jest or other frontend unit test in a step', () => {
  // testcases and verify both already refuse Jest -- the toolchain has rotted and
  // CI never runs it. plan did not, so it could still order one, and implement
  // would then write code that nothing downstream will ever execute.
  const prompt = promptFor(cfg('plan'), ctx(ticket()));
  assert.match(prompt, /No step writes a Jest test, or any other frontend unit test/);
});

test('plan says where frontend behaviour is covered instead', () => {
  // A prohibition with no alternative reads as "skip frontend coverage". It is
  // Playwright, written by testcases against the real app.
  const prompt = promptFor(cfg('plan'), ctx(ticket()));
  assert.match(prompt, /Playwright cases/);
});

// ------------------------------------------- research's reproduction is gated

test('the bug label puts the reproduction skill in front of research', () => {
  const prompt = systemPromptFor(cfg('research'), ctx(ticket({ labels: ['Bug', 'Loop'] })));
  assert.ok(names(prompt).includes('bug-reproduction'));
});

test('without the bug label research is not offered the reproduction skill', () => {
  // The case that forced this: an accessibility ticket carrying no labels at all
  // spent 57 turns failing to bring the app up, for a verdict of 'inconclusive'.
  const prompt = systemPromptFor(cfg('research'), ctx(ticket({ labels: ['Loop'] })));
  assert.ok(!names(prompt).includes('bug-reproduction'));
});

// ------------------------------------------- research's external-document rule

test('research is told not to spend a fetch on a chat permalink it cannot read', () => {
  // #8652 was linked to a sibling whose description cited a Slack thread as the
  // original report. Research followed it and got a 403: archive URLs need an
  // authenticated session, and a phase session is given only the GitLab MCP, so
  // the call can never succeed. The rule above it -- try every external document
  // -- is right, and this is the one class worth carving out of it.
  const prompt = promptFor(cfg('research'), ctx(ticket()));
  assert.match(prompt, /Slack\s+archive URL answers 403/);
  assert.match(prompt, /Record it in `unknowns` by URL/);
});

test('research still opens every other external document', () => {
  // The carve-out must not read as permission to skip links in general.
  const prompt = promptFor(cfg('research'), ctx(ticket()));
  assert.match(prompt, /Try each document linked outside GitLab with WebFetch/);
  assert.match(prompt, /Never guess what an\s+unopened document says/);
});

test('the reproduction instructions follow the same gate as the skill', () => {
  // The two halves must agree: loading the skill file without the prose leaves
  // research a method for a job it was never asked to do, and the prose without
  // the skill sends it to reproduce with no method. One label decides both.
  const withLabel = promptFor(cfg('research'), ctx(ticket({ labels: ['Bug'] })));
  assert.match(withLabel, /Reproduce the bug before anything is planned/);

  const without = promptFor(cfg('research'), ctx(ticket({ labels: ['Loop'] })));
  assert.ok(!/Reproduce the bug before anything is planned/.test(without));
  assert.match(without, /'not-applicable'/);
});

test('an unlabelled ticket is never told to bring the app up', () => {
  // The expensive half is not the skill text, it is the app: bring-up, login and
  // driving the steps is what raised this phase to 180 turns.
  const without = promptFor(cfg('research'), ctx(ticket({ labels: [] })));
  assert.ok(!/app\.cjs ensure/.test(without));
});

// ------------------------------------------ verify is told how to make data

test('verify carries a data method, not just a browser one', () => {
  // The phase drives a real app against a real database. Declaring only
  // local-browser-verify gave it bring-up and case-driving with nothing to say
  // about the STATE a case asserts against, and every session improvised one.
  const got = names(systemPromptFor(cfg('verify'), ctx(ticket())));
  assert.ok(got.includes('local-browser-verify'));
  assert.ok(got.includes('erp-ticket-test-data'));
});

test('the data-setup boundaries travel with the skill that needs them', () => {
  // erp-ticket-test-data was written for a person on dev/stage with a webshell
  // and someone to paste output back. Loading it into an autonomous local phase
  // without reframing it is how a verify session ends up writing to a shared
  // server, or waiting for a human who is not there. Both halves or neither.
  const p = promptFor(cfg('verify'), ctx(ticket()));
  assert.match(p, /erp-ticket-test-data/, 'the prompt must name the skill it is reframing');
  assert.match(p, /no\s+dev\/stage server/, 'the local-database boundary must be stated');
  assert.match(p, /Nobody will paste a script's output back to you/, 'the no-human boundary must be stated');
  assert.match(p, /OUTLIVES your session/, 'cleanup is the half that a later lap pays for');
});

test('verify is told the database is shared now, and that browser-visible data must commit', () => {
  // Every worktree gets the same hrdb/local_settings.py, so concurrent runs write one
  // Postgres. And a rollback in a separate `manage.py shell` process never reaches the
  // server the browser talks to, so "rollback" is only for what the shell measures.
  const p = promptFor(cfg('verify'), ctx(ticket()));
  assert.match(p, /ONE database, shared by\s+every worktree/);
  assert.match(p, /at the same moment you are/);
  assert.match(p, /SEE in the browser must commit/);
  assert.ok(!/not\s+hypothetical/.test(p), 'no incident is asserted to the model as fact');
});

// ------------------------------------------- verify failures reach implement

/**
 * A verify failure is a measurement; a review finding is a reader's hypothesis
 * about a diff. When a run cycles back to `implement` carrying both, the prompt
 * used to render only the review findings — so a run spent both of its cycle laps
 * closing a rebase and a test-file move while a reproducible h3 duplication went
 * untouched, and the run blocked on a defect nothing had ever shown it.
 *
 * These write into the reserved 990000+ iid band that `verify-fleet` already
 * uses, because the prompt reads both artifacts off disk by iid.
 */
const FIXTURE_IID = 990101;

function withArtifacts(
  artifacts: Record<string, unknown>,
  run: (c: PromptCtx) => void,
): void {
  const dir = runDir(FIXTURE_IID);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(artifacts)) {
    writeFileSync(join(dir, name), JSON.stringify(data));
  }
  try {
    run(ctx(ticket({ iid: FIXTURE_IID }), {}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VERIFY_FAILED = {
  results: [
    { id: 'TC-06', result: 'fail', evidence: 'h3Count=32 not 27', screenshot: 'TC-06-fail.png' },
    { id: 'TC-10', result: 'pass', evidence: 'ok', screenshot: '' },
  ],
};

const REVIEW_CHANGES = {
  verdict: 'changes-requested',
  findings: [{ id: 'F-02', severity: 'major', file: 'a.js', line: 1, what: 'w', why: 'y', fix: 'f' }],
};

test('a verify failure reaches implement even when review also has findings', () => {
  withArtifacts({ 'verify.json': VERIFY_FAILED, 'findings.json': REVIEW_CHANGES }, (c) => {
    const p = promptFor(cfg('implement'), c);
    assert.match(p, /## Verify failed these cases/, 'the verify block must render');
    assert.match(p, /## Review findings to fix/, 'the review block must still render');
    assert.match(p, /TC-06/, "the failing case's id must be named");
    assert.match(p, /h3Count=32 not 27/, 'the measured evidence must be carried, not just the expectation');
  });
});

test('verify failures are stated before review findings', () => {
  withArtifacts({ 'verify.json': VERIFY_FAILED, 'findings.json': REVIEW_CHANGES }, (c) => {
    const p = promptFor(cfg('implement'), c);
    assert.ok(
      p.indexOf('## Verify failed these cases') < p.indexOf('## Review findings to fix'),
      'whichever block leads frames the lap, so the measurement must lead',
    );
    assert.match(p, /the measurement wins/, 'precedence must be stated, not merely implied by order');
  });
});

test('a passing verify contributes no failure block', () => {
  const allPass = { results: [{ id: 'TC-01', result: 'pass', evidence: 'ok', screenshot: '' }] };
  withArtifacts({ 'verify.json': allPass, 'findings.json': REVIEW_CHANGES }, (c) => {
    const p = promptFor(cfg('implement'), c);
    assert.doesNotMatch(p, /## Verify failed these cases/);
    assert.match(p, /## Review findings to fix/);
  });
});

// ------------------------------------------------- layer labels at implement

/** The agents implement's prompt tells the session to delegate to. */
const delegatedTo = (prompt: string): string =>
  /Delegate implementation work to (.*?) for changes/.exec(prompt)?.[1] ?? '';

const FRONTEND_PLAN = { steps: [{ files: ['frontend/src/components/training/List.js'], layer: 'frontend' }] };
const NO_LAYER_PLAN = { steps: [{ files: ['README.md'], layer: 'docs' }] };

test('layer labels from grooming are read case-insensitively', () => {
  assert.deepEqual(labelledLayers({ labels: ['backend', 'AI'] }), { backend: true, frontend: false });
  assert.deepEqual(labelledLayers({ labels: ['Frontend', 'Backend'] }), { backend: true, frontend: true });
  assert.deepEqual(labelledLayers({ labels: ['Bug'] }), { backend: false, frontend: false });
});

test('a layer label adds its agent to what the plan forecasts, never takes one away', () => {
  const p = promptFor(cfg('implement'), ctx(ticket({ labels: ['Loop', 'Backend'] }), { plan: FRONTEND_PLAN }));
  assert.equal(delegatedTo(p), '`backend-agent` and `frontend-agent`');
});

test('with no plan, a layer label decides which agent is listed, and says so', () => {
  const p = promptFor(cfg('implement'), ctx(ticket({ labels: ['Loop', 'Backend'] })));
  assert.equal(delegatedTo(p), '`backend-agent`');
  assert.match(p, /The ticket's layer labels do not call for frontend work/);
  assert.doesNotMatch(p, /Neither the plan/, 'there is no plan to cite');
});

test('a plan that names no layer leaves the labels to decide, as no plan does', () => {
  const p = promptFor(cfg('implement'), ctx(ticket({ labels: ['Loop', 'Backend'] }), { plan: NO_LAYER_PLAN }));
  assert.equal(delegatedTo(p), '`backend-agent`');
  assert.match(p, /The ticket's layer labels do not call for frontend work/);
});

test('with neither a plan forecast nor a layer label, both agents are listed', () => {
  const p = promptFor(cfg('implement'), ctx(ticket({ labels: ['Loop'] }), { plan: NO_LAYER_PLAN }));
  assert.equal(delegatedTo(p), '`backend-agent` and `frontend-agent`');
});

// ------------------------------------------------------------ mr-open's draft

test('the mr prompt tells the erp pipeline a Draft is waiting from mr-open', () => {
  const prompt = promptFor(cfg('mr'), ctx(ticket()));
  assert.match(prompt, /`mr-open` opened a \*\*Draft\*\*/);
  assert.match(prompt, /LOOK FOR AN EXISTING MR/);
});

test('without mr-open in the pipeline the mr prompt makes no claim about it', () => {
  assert.equal(mrOpenNote(false), '');
  assert.match(mrOpenNote(true), /`Draft:` prefix off the title/);
});

// ------------------------------------------------- base-check judges scope

/**
 * "Fails on the base" is true by definition of the ticket's own bug, so the
 * base check has to judge scope as well, and it can only do that against the
 * criteria the cases were written from. ticketHead() leaves them out.
 * An iid in the reserved 990000+ band, so the verify.json it reads is never a
 * real run's.
 */
const baseCheckPrompt = (): string => promptFor(cfg('base-check'), ctx(ticket({ iid: 990102 }), {
  research: { acceptanceCriteria: ['Leave balance carries forward at year end'] },
}));

test('base-check is given the acceptance criteria to judge scope against', () => {
  const p = baseCheckPrompt();
  assert.match(p, /## Acceptance criteria/);
  assert.match(p, /Leave balance carries forward at year end/);
});

test("base-check judges scope from the ticket, never from verify's evidence", () => {
  const p = baseCheckPrompt();
  assert.match(p, /`inTicketScope`/);
  assert.match(p, /never from verify's evidence/);
  assert.match(p, /When you cannot tell, it is true/);
});

test('verify is not told a wrong label always ends as a fail', () => {
  // It did not: a case in the ticket's own scope fails on the base by
  // definition, so the old deterrent described a closed hatch that was open.
  const p = promptFor(cfg('verify'), ctx(ticket()));
  assert.doesNotMatch(p, /A wrong label saves nothing/);
  assert.match(p, /tagged `happy` covers this ticket's own\s+criteria/);
});

test('base-check never scores a failure on the branch\'s own rows as the base failing', () => {
  // verify ran the change against the one shared Postgres first, so a row it
  // left behind was written by the change.
  const p = baseCheckPrompt();
  assert.match(p, /never reuse a row verify created or\s+marked/);
  assert.match(p, /a record verify, or this branch's code, created or modified during\s+this run/);
});

test("base-check scores a failure on its own fresh fixtures as the base's answer", () => {
  // The prompt tells the session to create every record fresh, so an
  // "inconclusive" rule covering any record created during the run would
  // swallow every data-dependent case and no label could ever be confirmed.
  const p = baseCheckPrompt();
  assert.match(p, /anything you did not just create fresh for the case/);
  assert.match(p, /A failure on a record you created fresh through the base app is the base's own\s+answer/);
  assert.doesNotMatch(p, /a failure that turns on a record created or modified during this run/);
});

test('verify is told a migrating branch cannot carry a confirmed label', () => {
  const p = promptFor(cfg('verify'), ctx(ticket()));
  assert.match(p, /a failure on data this branch's migrations or code wrote/);
  assert.match(p, /adds or changes a migration the label is\s+never confirmed/);
});

test('base-check takes its URL and commit from ensure, never from list or git -C', () => {
  // `app.cjs list` prints no baseUrl, and git-guard refuses `git -C` on the base
  // checkout because it sits outside the leased worktree; an empty baseCommit
  // drops the sha from every "confirmed on" line.
  const p = baseCheckPrompt();
  assert.match(p, /app\.cjs ensure --ref/);
  assert.match(p, /`app\.baseUrl`/);
  assert.match(p, /record `app\.head`/);
  assert.doesNotMatch(p, /use its `baseUrl`/);
  assert.doesNotMatch(p, /git -C <that checkout>/);
});

// --------------------------------- the prior-art hunt moved from plan to research

test('research is given the prior-art survey on every ticket, label or not', () => {
  // Not label-gated, unlike bug-reproduction beside it: the survey is a use for
  // files this phase already opens to build the trace, so there is no ticket it
  // costs enough to withhold from.
  assert.deepEqual(names(systemPromptFor(cfg('research'), ctx(ticket()))), ['prior-art-survey']);
});

test('plan declares change-scoping, and not the discovery pair it replaced', () => {
  const got = names(systemPromptFor(cfg('plan'), ctx(ticket())));
  assert.ok(got.includes('change-scoping'));
  // The discovery half of these now runs in research. util-reuse-methodology is
  // NOT deleted from the context repo — util-reuse-agent still loads it under
  // erp-code-review — it is just no longer this phase's method.
  assert.ok(!got.includes('util-reuse-methodology'));
  assert.ok(!got.includes('planning-methodology'));
});

test('both skills these phases declare actually ship in this repo', () => {
  // A name in config with no directory behind it fails SILENTLY — the phase
  // just runs without it, and the prompt's short form is all that survives.
  assert.ok(existsSync(join(ROOT, 'skills', 'prior-art-survey', 'SKILL.md')));
  assert.ok(existsSync(join(ROOT, 'skills', 'change-scoping', 'SKILL.md')));
});

test('the research prompt still stands alone if the skill does not resolve', () => {
  // Skills are an upgrade, never a dependency (see SKILL_LINE). The parts that
  // must survive are the three the measurement showed were load-bearing.
  const p = promptFor(cfg('research'), ctx(ticket()));
  assert.match(p, /looking for FOUR kinds, not one/, 'the four kinds must survive the short form');
  assert.match(p, /Spell every noun TWICE/, 'the two-spelling rule must survive');
  assert.match(p, /Resolve every hit to its enclosing DEFINITION/, 'the resolve step must survive');
  // Without this the prompt describes the kinds but never says the role has to
  // carry one, and the only remaining carrier is the schema description.
  assert.match(p, /PREFIXED with its kind/, 'the prefix must be required, not just described');
  // The greps are the step that lapses, so they ship as commands rather than a
  // habit. Both are -E with a POSIX class instead of `\s`: a template literal
  // eats a single backslash, and BSD grep, GNU grep and ripgrep read this form
  // the same way.
  assert.ok(
    p.includes(`grep -nE '^([[:space:]]*(async )?(def|class) |[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[^=])' <file>`),
    'the python variant',
  );
  // Both variants, or a frontend ticket gets a Python-only command for the one
  // step this change calls load-bearing.
  assert.ok(
    p.includes(`grep -nE '^(export default |(export )?(async )?(function|const|let|class) )' <file>`),
    'the js/ts variant',
  );
});

/** The `grep -nE` patterns a text ships, in order, as RegExps. `[[:space:]]` is
 *  the one construct they use that JS spells differently. */
const definitionListings = (text: string): RegExp[] =>
  [...text.matchAll(/grep -nE '([^']+)' <file>/g)].flatMap((m) =>
    m[1] ? [new RegExp(m[1].replaceAll('[[:space:]]', '\\s'))] : []);

/** The 1-indexed lines a listing prints for a file. */
const listed = (pattern: RegExp, file: string): number[] =>
  file.split('\n').flatMap((l, i) => (pattern.test(l) ? [i + 1] : []));

const indent = (l: string): number => l.length - l.trimStart().length;

/** The python rule as the prompt states it: a listed hit is its own definition,
 *  and so is an unlisted column-0 statement; otherwise the last listed entry
 *  before N indented LESS than line N. */
const enclosingPy = (pattern: RegExp, file: string, n: number): number | undefined => {
  const lines = file.split('\n');
  const defs = listed(pattern, file);
  const at = indent(lines[n - 1] ?? '');
  if (defs.includes(n) || at === 0) return n;
  return defs.filter((d) => d < n && indent(lines[d - 1] ?? '') < at).at(-1);
};

const COMPONENT = [
  "import { LEAVE_TYPES } from './constants';",
  '',
  '',
  'const LeaveSummary = ({ person }) => {',
  '  const [open, setOpen] = useState(false);',
  '  const remaining = person.balance - person.used;',
  '  const isMaternity = person.type === LEAVE_TYPES.MATERNITY;',
  '  return isMaternity ? remaining : open;',
  '};',
  '',
  'export async function loadQuota() {',
  '  return LEAVE_TYPES.MATERNITY;',
  '}',
  '',
  'export default (props) => {',
  '  const days = LEAVE_TYPES.MATERNITY;',
  '  return <LeaveSummary person={props.person} days={days} />;',
  '};',
].join('\n');

const VIEW = [
  'class LeaveSummaryView:',
  '    def get(self, request):',
  '        def _fmt(x):',
  '            return x',
  '        quota = LeaveType.MATERNITY',
  '        return _fmt(quota)',
  '',
  '    async def stream(self):',
  '        yield LeaveType.MATERNITY',
  '',
  'MATERNITY_DAYS = 90',
  '',
  '',
  'def can_view_leave(user):',
  '    return user.is_staff',
  '',
  '',
  'EXCLUDED_LEAVE_TYPES = {',
  '    LeaveType.MATERNITY,',
  '}',
  '',
  'register_quota(LeaveType.MATERNITY, MATERNITY_DAYS)',
].join('\n');

test('a hit resolves to the definition around it, not to a local or to the line it matched', () => {
  // The first cut's js/ts pattern allowed leading whitespace, so it listed every
  // local `const` in a component body, and a hit on line 7 resolved to line 7
  // itself: the matched line the schema forbids citing. Its python pattern never
  // listed `async def`, and "the last entry at or before N" sent a hit in
  // `get`'s body to the nested `_fmt` above it. The second cut listed only defs
  // and classes, so a hit inside a multi-line module constant resolved to the
  // def above the constant, and its js/ts list skipped `export default (props)
  // =>`, so a hit in that component resolved to whatever came before it.
  const sources = [
    ['research prompt', promptFor(cfg('research'), ctx(ticket()))],
    ['prior-art-survey skill', readFileSync(join(ROOT, 'skills', 'prior-art-survey', 'SKILL.md'), 'utf8')],
  ] as const;
  for (const [where, text] of sources) {
    const [py, js, ...rest] = definitionListings(text);
    assert.ok(py && js && rest.length === 0, `${where} ships exactly a python and a js/ts listing`);
    assert.deepEqual(listed(js, COMPONENT), [4, 11, 15], `${where}: js/ts lists top-level definitions only`);
    assert.equal(listed(js, COMPONENT).filter((d) => d <= 7).at(-1), 4, `${where}: the hit in the body is the component's`);
    assert.equal(listed(js, COMPONENT).filter((d) => d <= 16).at(-1), 15, `${where}: a hit in an anonymous default export is that export's`);
    assert.deepEqual(listed(py, VIEW), [1, 2, 3, 8, 11, 14, 18], `${where}: python lists async def and module-level assignments`);
    assert.equal(enclosingPy(py, VIEW, 5), 2, `${where}: a hit after a nested def is the outer def's`);
    assert.equal(enclosingPy(py, VIEW, 9), 8, `${where}: a hit in an async def is that def's`);
    assert.equal(enclosingPy(py, VIEW, 11), 11, `${where}: a one-line constant is its own definition`);
    assert.equal(enclosingPy(py, VIEW, 19), 18, `${where}: a hit inside a multi-line constant is the constant's, not the def above it`);
    assert.equal(enclosingPy(py, VIEW, 22), 22, `${where}: an unlisted column-0 statement is cited at its own line`);
  }
});

test('the plan prompt still stands alone if the skill does not resolve', () => {
  const p = promptFor(cfg('plan'), ctx(ticket()));
  assert.match(p, /The prior art ARRIVES/, 'confirm-not-rediscover must survive the short form');
  assert.match(p, /still yours to search/, 'the approach residual must survive');
  assert.match(p, /Place a new unit where its MIRROR lives/, 'placement must survive');
});

test('research paces itself against its own configured budget', () => {
  // It was the last long session phase with no landing mark at all. The number
  // is quoted from config, never typed in, or the prompt teaches a session to
  // pace past the cap phase.ts actually kills it at.
  const p = promptFor(cfg('research'), ctx(ticket()));
  const turns = cfg('research').maxTurns ?? 0;
  assert.match(p, new RegExp(`LAND THE PLANE at ~${Math.round(turns * 0.7)} turns`));
  assert.match(p, new RegExp(`about 70% of your ${turns}`));
});

test('the plan keeps its measured budget rather than growing to fit the method', () => {
  // Seven replays measured 26-39 turns against a cap of 50, and the 39 was the
  // run that DISCOVERED the prior art — the cost this change moves to research.
  // A ceiling raised to cover a method is read as a target.
  const c = cfg('plan');
  assert.equal(c.maxTurns, 50);
  assert.equal(c.timeoutMin, 20);
  assert.ok((c as unknown as { _why_turns?: string })._why_turns, 'the decision not to raise is recorded');
});

test('the prior-art kinds are one set, in every place that names them', () => {
  // The measured failure this guards: a rule authored in two places diverges
  // invisibly. Three skill edits were once silently contradicted by prompts.ts
  // carrying its own compressed copy of the same rule, and nothing flagged it.
  // Here the producer (research's skill + the schema the model writes against)
  // and the consumer (plan's prompt + skill) must agree on the SAME vocabulary,
  // or plan is handed a prefix it was never told to expect.
  const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
  const sources: Array<[string, string]> = [
    ['research schema', JSON.stringify(RESEARCH_SCHEMA)],
    // The research prompt is the artefact that lost a token last time, so it is
    // the one the guard most needs: without this row, trimming its bullet back
    // to four kinds leaves the test green because the schema still names six.
    ['research prompt', promptFor(cfg('research'), ctx(ticket()))],
    ['plan prompt', promptFor(cfg('plan'), ctx(ticket()))],
    // implement reads `codePath` raw, so it is told what a prefix means rather
    // than left to read one as an instruction. Derived from the constant today;
    // this row is what notices if someone types the list out again.
    ['implement prompt', promptFor(cfg('implement'), ctx(ticket()))],
    ['prior-art-survey skill', read('skills', 'prior-art-survey', 'SKILL.md')],
    ['change-scoping skill', read('skills', 'change-scoping', 'SKILL.md')],
  ];
  for (const [where, text] of sources) {
    for (const kind of PRIOR_ART_KINDS) {
      assert.ok(text.includes(kind), `${where} is missing the '${kind}' kind`);
    }
  }
});

const PLAN_WITH_A_REJECTION = {
  approach: 'Count maternity days with the existing helper.',
  reuse: [
    'reuse: leave_days() in apps/leaves/utils.py, called as it stands',
    'rejected: carry_forward() — it has 12 callers, and a flag would split them',
  ],
  migrations: false,
  steps: [],
};

test('implement is told a rejected reuse entry is a candidate not to build on', () => {
  // `reuse` became four verdicts, rejections included, and the line below the
  // plan still said to reuse everything named there.
  const p = promptFor(cfg('implement'), ctx(ticket(), { plan: PLAN_WITH_A_REJECTION }));
  assert.doesNotMatch(p, /Reuse what the plan named under `reuse`/);
  assert.match(p, /A reuse, extend or collapse\s+entry is binding/);
  assert.match(p, /A rejected entry is a candidate the plan decided NOT to build on/);
});

test('review sees the plan\'s reuse verdicts one per line, under a heading that admits rejections', () => {
  // A comma-join lost the boundary between entries whose reasons carry commas,
  // and put the rejection under a bare `reuse:` label.
  const p = promptFor(cfg('review'), ctx(ticket(), { plan: PLAN_WITH_A_REJECTION }));
  assert.ok(p.includes(
    'reuse verdicts (rejections included):\n' +
    '  - reuse: leave_days() in apps/leaves/utils.py, called as it stands\n' +
    '  - rejected: carry_forward() — it has 12 callers, and a flag would split them\n',
  ));
});

// ---------------------------------------------------------------- design tokens

test('design is told the tokens are generated, where they are, and not to redo them', () => {
  const prompt = promptFor(cfg('design'), ctx(ticket({ iid: 424242, labels: ['Design'] })));
  assert.ok(prompt.includes(join(runDir(424242), 'artifacts', 'design', 'tokens.css')));
  assert.ok(prompt.includes('./tokens.css'));
  assert.ok(!prompt.includes('../tokens.css'), 'a mockup in design/ importing ../tokens.css misses the file');
  assert.doesNotMatch(prompt, /Distil them into one/);
});

test('plan and implement are pointed at the tokens the design added, not told to avoid new ones', () => {
  const design = {
    applicable: true,
    tokensFile: 'design/tokens.css',
    screens: [{ id: 's1', name: 'Completed list', purpose: 'p', mockupHtml: 'design/s1.html', screenshot: 's1.png' }],
    newPatterns: ['x'],
  };
  for (const phase of ['plan', 'implement']) {
    const prompt = promptFor(cfg(phase), ctx(ticket({ iid: 424243 }), { design }));
    assert.ok(prompt.includes(join(runDir(424243), 'artifacts', 'design', 'tokens.css')), phase);
    assert.ok(prompt.includes(join(runDir(424243), 'artifacts', 'design', 'new-tokens.css')), phase);
    assert.doesNotMatch(prompt, /rather than new ones/, phase);
  }
});

test('the design prompt names the very file writeDesignTokens wrote, and tells a dark screen to set data-theme', (t) => {
  const iid = 990374;
  const wt = mkdtempSync(join(tmpdir(), 'oneshot-tokens-prompt-'));
  t.after(() => {
    rmSync(wt, { recursive: true, force: true });
    rmSync(runDir(iid), { recursive: true, force: true });
  });
  mkdirSync(join(wt, 'frontend', 'src', 'scss'), { recursive: true });
  writeFileSync(join(wt, 'frontend', 'src', 'scss', '_variables.scss'), '$brand: #111;\n');
  const written = writeDesignTokens(iid, wt);
  assert.ok(written);
  const prompt = promptFor(cfg('design'), ctx(ticket({ iid, labels: ['Design'] })));
  assert.ok(prompt.includes(written.path), 'the prompt must point at the file the writer produced');
  assert.match(prompt, /data-theme="dark"/);
});

// ------------------------------------------- Beta: a new version beside the old one

const BETA = 'beta-version-toggle';

/** The phases config/phases.json hands the Beta skill to, read from config. */
const loadsBeta = (): string[] =>
  phases().filter((p) => Object.values(p.labelSkills ?? {}).includes(BETA)).map((p) => p.name);

const beta = (labels = ['Beta', 'Loop']): PromptCtx => ctx(ticket({ labels }));

/** A prompt with its line wrapping undone, so re-wrapping prose cannot break an assertion. */
const flat = (phase: string, c: PromptCtx = beta()): string => promptFor(cfg(phase), c).replace(/\s+/g, ' ');

test('the Beta label reaches every phase that plans, builds, checks or shows the change', () => {
  // verify executes testcases' list and nothing else, so a switch no case was
  // written for is a switch nobody verified; review is where an edit to v1 is caught.
  for (const phase of ['plan', 'implement', 'testcases', 'review', 'verify', 'ui-evidence', 'mr']) {
    assert.ok(loadsBeta().includes(phase), `${phase} does not load ${BETA}`);
  }
  assert.ok(!loadsBeta().includes('design'), 'design must not load Beta: the contract and the skill both state its mockups carry no switch');
});

test('each of those phases is offered the skill and told its own part in the beta', () => {
  for (const phase of loadsBeta()) {
    assert.ok(names(systemPromptFor(cfg(phase), beta())).includes(BETA), `${phase}: skill not offered`);
    const p = promptFor(cfg(phase), beta());
    assert.match(p, /carries \*\*Beta\*\* — v2 beside v1, with a switch back/, `${phase}: no contract`);
    assert.match(p, new RegExp(`### Your part, as \`${phase}\`\\n\\S`), `${phase}: contract with no job`);
  }
});

test('without the label no phase is offered the skill or told to build a v2', () => {
  for (const phase of loadsBeta()) {
    const plain = ctx(ticket({ labels: ['Loop'] }));
    assert.ok(!names(systemPromptFor(cfg(phase), plain)).includes(BETA), phase);
    assert.doesNotMatch(promptFor(cfg(phase), plain), /carries \*\*Beta\*\*/, phase);
  }
});

test('a Beta label typed in lower case still counts', () => {
  assert.match(promptFor(cfg('plan'), beta(['beta'])), /carries \*\*Beta\*\*/);
});

test('a phase that does not load the skill is not told about the beta', () => {
  // research traces the code as it is today; there is no v2 to hold it to yet.
  assert.doesNotMatch(promptFor(cfg('research'), beta()), /carries \*\*Beta\*\*/);
});

test('the skill the Beta label loads ships in this repo', () => {
  assert.ok(existsSync(join(ROOT, 'skills', BETA, 'SKILL.md')));
});

test('plan is told v1\'s components are not prior art for v2, and a duplicate inside v1 is not its to collapse', () => {
  // plan loads util-reuse-methodology, whose reuse-first hunt finds v1's component
  // as the obvious thing for v2 to extend; implement and review already carve the
  // copy out, and without the same line here the plan they inherit has folded it.
  const p = flat('plan');
  assert.match(p, /v1's COMPONENTS are not prior art for v2 to extend/);
  assert.match(p, /not a duplicate to reuse or collapse/);
  assert.match(p, /Collapsing a duplicate that already sits in v1's directory is out of scope too/);
  assert.doesNotMatch(flat('plan', ctx(ticket({ labels: ['Loop'] }))), /not prior art for v2/);
});

test('implement is told the v2 copy is the requirement, not duplication to fold away', () => {
  // ponytail is always loaded and asks whether code needs to exist at all; on a
  // Beta ticket its honest answer would collapse v2 back into an edit of v1.
  const p = flat('implement');
  assert.match(p, /`ponytail` never simplifies away anything explicitly requested, and the label is that request/);
  assert.match(p, /"does this need to exist" does not fold v2's copy/);
});

test('review does not raise the v2 copies the label asked for as duplication', () => {
  // review loads ponytail-review and dispatches util-reuse-agent, and both exist
  // to flag exactly this shape; without the carve-out a correct beta comes back
  // as findings and spends a lap undoing the requirement.
  const p = flat('review');
  assert.match(p, /v2's own copies of v1's COMPONENTS are what the label asked for/);
  assert.match(p, /A copied HELPER \(a util, a constant, an API call\) is a finding as usual/);
});

test('review hands the beta contract to the agent that judges scope', () => {
  // spec-conformance-agent reads scope off the ticket's own text, and a Beta
  // ticket's description never mentions the switch — the label does.
  assert.match(flat('review'), /into `spec-conformance-agent`'s `ticket_context`/);
});

test('review holds every edited v1 file to a backward-compatible extension', () => {
  // Project Logs v2 extended seven v1 files (optional parameters, null guards), so
  // "never touch v1" would fail the precedent the label follows; what it never did
  // was change what a v1 call site does, or let v1 import v2.
  const p = flat('review');
  assert.match(p, /git diff --stat origin\/\S+\.\.\.HEAD/);
  assert.match(p, /Anything else there — a changed behaviour, a rename, a move — is a `major` finding/);
  assert.match(p, /v1 importing from `<module>_v2\/`/);
});

test('every phase is held to the Project Logs v2 layout, and told the switch is the new part', () => {
  const p = flat('plan');
  assert.match(p, /a sibling `<module>_v2\/` directory/);
  assert.match(p, /a route wrapper like `LogsVersionRoute\.js`, on every route of the feature/);
  assert.match(p, /the switch is what this label adds/);
});

test('testcases writes a v1 regression case and reaches each version by the switch', () => {
  const p = flat('testcases');
  assert.match(p, /the case that proves v1 was left alone/);
  assert.match(p, /never by writing the stored choice directly/);
  // The phase's own rule is that only the criteria and the ticket are an oracle;
  // the switch appears in neither, so without this its cases have no source.
  assert.match(p, /part of this ticket's oracle, alongside its acceptance criteria/);
});

test('the never-touched case starts by removing the stored choice, and no case needs a second login', () => {
  // The harness reloads the storage it saved at login into every later case, so an
  // earlier case's choice would land this one on v1; and verify has exactly one
  // login, so a second-account case could only end blocked, which no gate refuses.
  const p = flat('testcases');
  assert.match(p, /a user who never touched the switch landing on v2 \(`boundary`\)\. Its first step removes the stored choice/);
  // verify reads that step to learn which key to remove; nothing else tells it.
  assert.match(p, /naming its localStorage key exactly as the diff spells it/);
  assert.match(p, /it is not a case here: `verify` has one login/);
  assert.doesNotMatch(p, /a second account on the same browser not inheriting/);
});

test('verify reaches each version through the switch, never by writing the stored choice', () => {
  const p = flat('verify');
  assert.match(p, /THROUGH THE SWITCH/);
  // Clearing storage is the obvious way to "log out" in a script, and it erases
  // exactly the value the persistence case exists to measure.
  assert.match(p, /Log out through the app's own logout, never by clearing browser storage/);
});

test('verify may remove the stored choice only to set up the never-touched case', () => {
  const p = flat('verify');
  assert.match(p, /Never set the stored choice directly/);
  assert.match(p, /The one write you may make is SETUP for the never-touched case/);
  assert.match(p, /Remove that one key — not the rest of storage, which holds the login/);
  // A case result is {id, result, evidence, screenshot}: `steps` is testcases'
  // field, so an order to record the setup there had nowhere to go.
  assert.match(p, /say so in that case's `evidence`/);
  assert.doesNotMatch(p, /say so in the case's steps/);
});

test('review proves in code that the choice is per user, since no browser case can', () => {
  const p = flat('review');
  assert.match(p, /Point 5's second account is yours to prove, because no browser case can/);
  assert.match(p, /A username cached at module scope or once per page load is a `major` finding/);
});

test('ui-evidence takes its before from v1 on its own instance and checks it against the base', () => {
  const p = flat('ui-evidence');
  assert.match(p, /v1, reached through the switch on YOUR instance/);
  assert.match(p, /Any other difference between the two is v1 having changed/);
});

test('ui-evidence compares v1 with the base branch below the switch, which the base never has', () => {
  // The switch renders above v1 too, so a whole-page match could never hold and
  // every beta MR taking a base shot would claim that v1 had changed.
  const p = flat('ui-evidence');
  assert.match(p, /compare the page BELOW the switch/);
  assert.match(p, /its absence from the base-branch shot is expected and is not a difference/);
});

test('the rule that a before comes from a second instance names the beta exception, on a beta only', () => {
  assert.match(flat('ui-evidence'), /This ticket is a beta, the one exception: its block below makes v1/);
  assert.doesNotMatch(flat('ui-evidence', ctx(ticket({ labels: ['Loop'] }))), /This ticket is a beta/);
});

test('the switch sits outside an approved design, so Design and Beta together ask for one thing', () => {
  // design is never told about the beta, so its mockups carry no switch; without
  // this, implement is told both to build exactly to them and to add the switch.
  for (const phase of ['implement', 'ui-evidence']) {
    assert.match(flat(phase), /it sits outside any approved design/, phase);
    assert.match(flat(phase), /it is never a departure from the design/, phase);
  }
});

test('on a Design and Beta ticket the design pair is v2 below the switch, said before any row is filled', () => {
  // The conformance block asks for every departure, small ones too, and comes
  // before the beta block; read top-down, the switch the mockups never drew is a
  // departure on every screen unless the block itself says otherwise.
  const designed = (labels: string[]): string => promptFor(cfg('ui-evidence'), {
    ...ctx(ticket({ labels })),
    journal: { designApproval: { requestTs: 'x', approved: true, feedback: [] } },
    prior: { design: DESIGN },
  } as unknown as PromptCtx).replace(/\s+/g, ' ');
  const p = designed(['Beta', 'Loop']);
  const pointer = p.indexOf('This ticket is a beta: pair each approved screen against v2, reached through the switch');
  assert.ok(pointer > p.indexOf('## Pair the shipped screens against the approved design'), 'pointer outside the block');
  assert.ok(pointer < p.indexOf('carries **Beta**'), 'pointer after the beta block');
  assert.match(p, /so leave it out of `differences`/);

  const plain = designed(['Loop']);
  assert.match(plain, /is this what I approved/);
  assert.doesNotMatch(plain, /pair each approved screen against v2/);
});
