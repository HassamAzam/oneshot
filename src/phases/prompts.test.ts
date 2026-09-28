import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptFor, systemPromptFor, type PromptCtx } from './prompts.js';
import { ROOT, phaseByName, runDir, type PhaseConfig } from '../lib/config.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('plan always gets the skill that is its method', () => {
  // Was the planning-methodology + util-reuse-methodology pair. The discovery
  // half of that method now runs in research, where the files are already open;
  // change-scoping is what is left, and it is a different job — confirm what
  // arrived in codePath, then search only what this approach introduces.
  const prompt = systemPromptFor(cfg('plan'), ctx(ticket()));
  assert.ok(names(prompt).includes('change-scoping'));
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
  // habit — and a template literal eats a single backslash, which would leave
  // the pattern matching a literal 's' instead of whitespace.
  assert.match(p, /grep -n "\^\\s\*\\\(def\\\|class\\\) " <file>/, 'the python variant');
  // Both variants, or a frontend ticket gets a Python-only command for the one
  // step this change calls load-bearing.
  assert.match(p, /grep -n "\^\\s\*\\\(export \\\|async \\\)\*\\\(function\\\|const\\\|class\\\) " <file>/, 'the js/ts variant');
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
    ['prior-art-survey skill', read('skills', 'prior-art-survey', 'SKILL.md')],
    ['change-scoping skill', read('skills', 'change-scoping', 'SKILL.md')],
  ];
  for (const [where, text] of sources) {
    for (const kind of PRIOR_ART_KINDS) {
      assert.ok(text.includes(kind), `${where} is missing the '${kind}' kind`);
    }
  }
});
