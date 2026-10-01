import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mrOpenNote, promptFor, systemPromptFor, type PromptCtx } from './prompts.js';
import { gateSubjectDigest } from '../lib/artifacts.js';
import { ROOT, phaseByName, phases, runDir, type PhaseConfig } from '../lib/config.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from './types.js';

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

test('plan always gets the skills that are its method', () => {
  const prompt = systemPromptFor(cfg('plan'), ctx(ticket()));
  assert.ok(names(prompt).includes('planning-methodology'));
  assert.ok(names(prompt).includes('util-reuse-methodology'));
});

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
