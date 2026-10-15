/**
 * The readiness rules, tested through the hook file itself.
 *
 * hooks/automation-ready.cjs is dependency-free CJS that the conductor runs
 * as its own process (runAutomationReadyGuard); its pure decision function is
 * reached here with createRequire rather than re-implemented, so the rules
 * under test are the rules that run.
 *
 * ONESHOT_PHASE is cleared before the require. The file must not exit, read
 * stdin or call GitLab when it is merely loaded — a hook that gated at top
 * level would end this test process before the first test.
 *
 * Every iid and MR number is invented. The shapes mirror live tickets: a
 * closed ticket with one merged fix, an abandoned open MR and five branch
 * promotions; Ready For Deployment removed and re-added; RFD added only after
 * the trigger; no MR at all; an MR from another project.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  AUTOMATION_PHASE, readinessFromHookOutput, withdrawnLabels,
  type Readiness, type ReadinessReason,
} from './readiness.js';

delete process.env.ONESHOT_PHASE;

interface LabelEvent { action: 'add' | 'remove'; created_at: string; label: { name: string } | null }
interface LinkedMr {
  iid: number; project_id: number; state: string; source_branch: string; target_branch: string;
  merged_at?: string | null; title?: string; web_url?: string;
}
interface Facts {
  issue: { iid: number; state: string; labels: string[]; project_id: number; updated_at?: string };
  events: LabelEvent[];
  mrs: LinkedMr[];
  labels: { trigger: string; deployed: string; loop: string };
  protectedBranches: string[];
  releaseBranch: RegExp;
  now?: string;
}
type Pages = { pages: number[] } | { sequential: true } | { tooMany: number };
interface ReadyHook {
  decideReadiness(f: Facts): Readiness;
  isPromotionBranch(branch: string, protectedBranches: string[], releaseBranch: RegExp): boolean;
  fingerprint(reasons: Array<Pick<ReadinessReason, 'code' | 'detail'> & { text?: string }>): string;
  renderOutput(r: Readiness): Record<string, unknown>;
  labelEventPages(totalPagesHeader: string | null, firstPageLength: number): Pages;
  classifyHttp(status: number): string;
  PHASE: string;
  DEADLINE_MS: number;
}

const hook = createRequire(import.meta.url)('../../hooks/automation-ready.cjs') as ReadyHook;

// The labels and branch policy the hook reads at run time, so these tests
// judge against the configuration that ships rather than a copy of it.
const project = JSON.parse(readFileSync(new URL('../../config/project.json', import.meta.url), 'utf8')) as {
  labels: { entry: string };
  automation: { labels: { trigger: string; deployed: string }; releaseBranchPattern: string };
  branches: { protected: string[] };
};
const T = project.automation.labels.trigger;
const D = project.automation.labels.deployed;
/** The Loop's entry label: the master switch every ticket this mode works must carry. */
const L = project.labels.entry;
const PROJECT = 7;

const add = (name: string, at: string): LabelEvent => ({ action: 'add', created_at: at, label: { name } });
const remove = (name: string, at: string): LabelEvent => ({ action: 'remove', created_at: at, label: { name } });
const mr = (iid: number, state: string, source: string, target = 'dev', projectId = PROJECT): LinkedMr => ({
  iid, project_id: projectId, state, source_branch: source, target_branch: target,
  merged_at: state === 'merged' ? `2026-09-${String(10 + (iid % 10)).padStart(2, '0')}T10:00:00+05:00` : null,
  title: `Fixture ${iid}`, web_url: `https://gitlab.example.com/acme/erp/-/merge_requests/${iid}`,
});

type FactsOver = Partial<Omit<Facts, 'issue'>> & { issue?: Partial<Facts['issue']> };

function facts(over: FactsOver = {}): Facts {
  return {
    events: [],
    mrs: [],
    labels: { trigger: T, deployed: D, loop: L },
    protectedBranches: project.branches.protected,
    releaseBranch: new RegExp(project.automation.releaseBranchPattern, 'i'),
    now: '2026-09-28T12:00:00.000Z',
    ...over,
    issue: {
      iid: 101, state: 'opened', labels: [L, T, D], project_id: PROJECT, updated_at: '2026-09-28T11:00:00+05:00',
      ...over.issue,
    },
  };
}

const decide = (over: FactsOver = {}): Readiness => hook.decideReadiness(facts(over));
const codes = (r: Readiness): string[] => r.reasons.map((x) => x.code);
const reason = (r: Readiness, code: string): ReadinessReason => {
  const found = r.reasons.find((x) => x.code === code);
  assert.ok(found, `expected a ${code} reason, got ${JSON.stringify(codes(r))}`);
  return found;
};

const FIX = mr(501, 'merged', 'fix/profile-docs');

test('a closed ticket with the trigger, one merged fix MR, an abandoned open MR and five promotion MRs is ready', () => {
  const r = decide({
    issue: { state: 'closed', labels: [L, T, D] },
    events: [add(D, '2026-09-17T20:42:40+05:00'), add(T, '2026-09-28T16:11:43+05:00')],
    mrs: [
      FIX,
      mr(400, 'opened', 'fix/profile-first-try'),
      mr(601, 'merged', 'master', 'stage'),
      mr(602, 'merged', 'master', 'stage'),
      mr(603, 'merged', 'stage', 'dev'),
      mr(604, 'merged', 'stage', 'dev'),
      mr(605, 'merged', 'stage', 'dev'),
    ],
  });
  assert.equal(r.verdict, 'ready');
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.merged.map((m) => m.iid), [501]);
  assert.deepEqual(r.open.map((m) => m.iid), [400]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0] ?? '', /!400 is still open/);
  assert.equal(r.fingerprint, null);
  assert.equal(r.state, 'closed');
  assert.equal(r.triggerAddedAt, '2026-09-28T16:11:43+05:00');
  assert.equal(r.issueUpdatedAt, '2026-09-28T11:00:00+05:00');
  assert.deepEqual(r.merged[0], {
    iid: 501, title: 'Fixture 501', source: 'fix/profile-docs', target: 'dev', state: 'merged',
    mergedAt: '2026-09-11T10:00:00+05:00', url: 'https://gitlab.example.com/acme/erp/-/merge_requests/501',
  });
});

test('an open ticket is ready once Ready For Deployment was added before the latest trigger', () => {
  const r = decide({
    events: [add(D, '2026-09-20T10:00:00+05:00'), add(T, '2026-09-20T11:00:00+05:00')],
    mrs: [FIX],
  });
  assert.equal(r.verdict, 'ready');
});

test('Ready For Deployment added only after the trigger does not count', () => {
  const r = decide({
    events: [add(T, '2026-09-20T10:00:00+05:00'), add(D, '2026-09-20T11:00:00+05:00')],
    mrs: [FIX],
  });
  assert.equal(r.verdict, 'not-ready');
  assert.deepEqual(codes(r), ['rfd-order']);
  const why = reason(r, 'rfd-order');
  assert.equal(why.detail, 'after');
  assert.match(why.text, /was not added before the latest `Ready For Automation` \(2026-09-20 10:00 UTC\+05:00\), and the ticket is still open\./);
  assert.match(why.fix, /remove and re-add `Ready For Automation`/);
  assert.match(r.fingerprint ?? '', /^[0-9a-f]{12}$/);
});

test('Ready For Deployment removed and re-added still counts when an add precedes the trigger', () => {
  const r = decide({
    events: [
      add(D, '2026-09-20T09:00:00+05:00'),
      remove(D, '2026-09-20T09:30:00+05:00'),
      add(T, '2026-09-20T11:00:00+05:00'),
      add(D, '2026-09-20T12:00:00+05:00'),
    ],
    mrs: [FIX],
  });
  assert.equal(r.verdict, 'ready');
});

test('re-adding the trigger after deployment is what makes an open ticket ready', () => {
  const before = [add(T, '2026-09-20T08:00:00+05:00'), add(D, '2026-09-20T10:00:00+05:00')];
  const stale = decide({ events: before, mrs: [FIX] });
  assert.deepEqual(codes(stale), ['rfd-order']);

  const readded = decide({
    events: [...before, remove(T, '2026-09-20T10:30:00+05:00'), add(T, '2026-09-20T11:00:00+05:00')],
    mrs: [FIX],
  });
  assert.equal(readded.verdict, 'ready');
  assert.equal(readded.triggerAddedAt, '2026-09-20T11:00:00+05:00');
});

test('a closed ticket without the trigger label is not ready', () => {
  const r = decide({
    issue: { state: 'closed', labels: [L, D] },
    events: [add(D, '2026-09-20T09:00:00+05:00'), add(T, '2026-09-20T10:00:00+05:00'), remove(T, '2026-09-21T10:00:00+05:00')],
    mrs: [FIX],
  });
  assert.equal(r.verdict, 'not-ready');
  assert.deepEqual(codes(r), ['rfa-missing']);
  assert.equal(reason(r, 'rfa-missing').detail, 'absent');
  assert.equal(reason(r, 'rfa-missing').text, '`Ready For Automation` is not on the ticket.');
});

test('a ticket that never had the trigger label is told it is not there, not that it was taken off', () => {
  // No trigger event on record at all: "no longer" and "back" would both be false.
  const r = decide({ issue: { state: 'closed', labels: [L, D] }, events: [add(D, '2026-09-20T09:00:00+05:00')], mrs: [FIX] });
  const why = reason(r, 'rfa-missing');
  assert.equal(why.text, `\`${T}\` is not on the ticket.`);
  assert.equal(why.fix, `Add \`${T}\` if this ticket should get automation test cases.`);
  assert.doesNotMatch(`${why.text} ${why.fix}`, /no longer|back|still/);
});

test('promotion MRs never satisfy the merged rule', () => {
  const sources = ['dev', 'stage', 'master', 'main', 'Adhoc-2026-09-01', 'adhoc-2026-09-01'];
  const release = new RegExp(project.automation.releaseBranchPattern, 'i');
  for (const s of sources) {
    assert.equal(hook.isPromotionBranch(s, project.branches.protected, release), true, s);
  }
  assert.equal(hook.isPromotionBranch('fix/stage-typo', project.branches.protected, release), false);
  assert.equal(hook.isPromotionBranch('Adhoc-2026-09', project.branches.protected, release), false);

  const r = decide({
    issue: { state: 'closed' },
    mrs: sources.map((s, i) => mr(610 + i, 'merged', s, s === 'dev' ? 'stage' : 'dev')),
  });
  assert.equal(r.verdict, 'not-ready');
  assert.deepEqual(codes(r), ['mr-not-merged']);
  const why = reason(r, 'mr-not-merged');
  assert.match(why.text, /^No merge request is linked to this ticket — only branch-promotion MRs \(dev → stage, stage → dev, master → dev …\) mention it\.$/);
  assert.equal(why.detail, 'none');
  assert.deepEqual(r.merged, []);
});

test('a fix MR into an Adhoc release branch counts', () => {
  const r = decide({ issue: { state: 'closed' }, mrs: [mr(502, 'merged', 'fix/z', 'Adhoc-2026-09-01')] });
  assert.equal(r.verdict, 'ready');
  assert.deepEqual(r.merged.map((m) => [m.iid, m.target]), [[502, 'Adhoc-2026-09-01']]);
});

test('an MR from another project is ignored', () => {
  const r = decide({ issue: { state: 'closed' }, mrs: [mr(503, 'merged', 'fix/elsewhere', 'dev', 99)] });
  assert.equal(r.verdict, 'not-ready');
  assert.deepEqual(r.merged, []);
  assert.equal(reason(r, 'mr-not-merged').text, 'No merge request is linked to this ticket.');
});

test('no linked MR is said plainly', () => {
  const r = decide({ issue: { state: 'closed' }, mrs: [] });
  const why = reason(r, 'mr-not-merged');
  assert.match(why.text, /^No merge request is linked/);
  assert.equal(why.detail, 'none');
  assert.equal(
    why.fix,
    'Merge the fix MR, or mention `#101` in the description of the MR that fixed it so GitLab links it. ' +
    'Oneshot checks again by itself.',
  );
});

test('an open leftover MR is a warning, never a blocker', () => {
  const r = decide({
    issue: { state: 'closed' },
    mrs: [mr(401, 'opened', 'fix/leftover'), FIX],
  });
  assert.equal(r.verdict, 'ready');
  assert.deepEqual(r.warnings, ['!401 is still open — it is not what shipped, and is ignored']);
  assert.deepEqual(r.open.map((m) => m.iid), [401]);
});

test('an unmerged MR is described by its state', () => {
  const r = decide({
    issue: { state: 'closed' },
    mrs: [mr(401, 'closed', 'fix/abandoned'), mr(400, 'opened', 'fix/pending')],
  });
  const why = reason(r, 'mr-not-merged');
  assert.equal(why.text, 'No linked merge request is merged yet: !400 is still open; !401 was closed without merging.');
  assert.equal(why.detail, '!400:opened,!401:closed');
  // Not merged, so not a leftover beside a fix: the reason already names it.
  assert.deepEqual(r.warnings, []);
});

test('both rules failing reports both, rule A first', () => {
  const r = decide({ issue: { labels: [L, T] }, events: [add(T, '2026-09-20T10:00:00+05:00')], mrs: [] });
  assert.deepEqual(codes(r), ['rfd-order', 'mr-not-merged']);
  assert.equal(reason(r, 'rfd-order').detail, 'absent');
  assert.equal(r.state, 'opened');
});

test('the fingerprint ignores wording and order but changes with the facts', () => {
  const a = { code: 'rfd-order' as const, detail: 'after', text: 'one wording' };
  const b = { code: 'mr-not-merged' as const, detail: '!400:opened', text: 'some words' };
  const fp = hook.fingerprint([a, b]);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(hook.fingerprint([{ ...b, text: 'other words' }, { ...a, text: 'another wording' }]), fp);
  assert.notEqual(hook.fingerprint([a, { ...b, detail: '!400:closed' }]), fp);
  assert.notEqual(hook.fingerprint([a]), fp);

  // The same ticket re-checked later, with the same facts, keeps its fingerprint.
  const later = { events: [add(T, '2026-09-20T10:00:00+05:00'), add(D, '2026-09-20T11:00:00+05:00')], mrs: [] };
  assert.equal(decide(later).fingerprint, decide({ ...later, now: '2026-09-29T00:00:00.000Z' }).fingerprint);
});

test('renderOutput: ready allows and carries additionalContext with the event name UserPromptSubmit', () => {
  const r = decide({ issue: { state: 'closed' }, mrs: [FIX, mr(400, 'opened', 'fix/old')] });
  const out = hook.renderOutput(r);
  assert.equal('decision' in out, false);
  assert.deepEqual(out.hookSpecificOutput, {
    hookEventName: 'UserPromptSubmit',
    additionalContext:
      "Readiness verified by oneshot's automation-ready hook: merged !501 (fix/profile-docs → dev). Ignore !400 (still open).",
  });
  assert.deepEqual(out.automationReadiness, r);
});

test('renderOutput: not-ready and unknown block with decision:block and a string reason, and never set continue or stopReason', () => {
  const notReady = decide({ issue: { state: 'closed', labels: [] }, mrs: [] });
  const unknown: Readiness = {
    ...notReady, verdict: 'unknown', reasons: [], fingerprint: null,
    error: 'GitLab answered 500 for the ticket', errorKind: 'server',
  };
  for (const [r, prefix] of [[notReady, 'Not ready for automation test cases: '], [unknown, 'Cannot check readiness: ']] as const) {
    const out = hook.renderOutput(r);
    assert.equal(out.decision, 'block');
    assert.equal(typeof out.reason, 'string');
    assert.ok(String(out.reason).startsWith(prefix), String(out.reason));
    assert.equal('continue' in out, false);
    assert.equal('stopReason' in out, false);
    assert.equal('hookSpecificOutput' in out, false);
    assert.deepEqual(out.automationReadiness, r);
  }
  assert.equal(hook.renderOutput(unknown).reason, 'Cannot check readiness: GitLab answered 500 for the ticket');
  assert.match(String(hook.renderOutput(notReady).reason), /is not on the ticket\. No merge request is linked/);
});

test('labelEventPages fetches every page up to ten, and more than ten is unknown', () => {
  assert.deepEqual(hook.labelEventPages('1', 100), { pages: [] });
  assert.deepEqual(hook.labelEventPages('3', 40), { pages: [] });
  assert.deepEqual(hook.labelEventPages(null, 28), { pages: [] });
  assert.deepEqual(hook.labelEventPages('3', 100), { pages: [2, 3] });
  assert.deepEqual(hook.labelEventPages('10', 100), { pages: [2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.deepEqual(hook.labelEventPages('11', 100), { tooMany: 11 });
  assert.deepEqual(hook.labelEventPages(null, 100), { sequential: true });
  assert.deepEqual(hook.labelEventPages('', 100), { sequential: true });
});

test('classifyHttp: 401 and 403 are auth, 404 notfound, 429 and 5xx server', () => {
  assert.equal(hook.classifyHttp(401), 'auth');
  assert.equal(hook.classifyHttp(403), 'auth');
  assert.equal(hook.classifyHttp(404), 'notfound');
  assert.equal(hook.classifyHttp(429), 'server');
  assert.equal(hook.classifyHttp(500), 'server');
  assert.equal(hook.classifyHttp(503), 'server');
  assert.equal(hook.classifyHttp(400), 'other');
  assert.equal(hook.classifyHttp(302), 'other');
});

test('readinessFromHookOutput reads a payload without a verdict as unknown, with its reason', () => {
  const why = 'the readiness check could not start (GITLAB_REPO_URL is not set)';
  const r = readinessFromHookOutput({ reason: why }, 101);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.errorKind, 'other');
  assert.equal(r.error, why);
  assert.equal(r.iid, 101);
  assert.deepEqual([r.reasons, r.merged, r.open, r.fingerprint], [[], [], [], null]);

  assert.equal(readinessFromHookOutput({}, 101).error, 'the readiness hook gave no verdict');
  assert.equal(readinessFromHookOutput({ automationReadiness: { verdict: 'ready' } }, 101).verdict, 'unknown');
  assert.equal(readinessFromHookOutput(null as unknown as Record<string, unknown>, 101).verdict, 'unknown');
  assert.equal(
    readinessFromHookOutput({ hookSpecificOutput: { permissionDecisionReason: 'Denied: nope' } }, 101).error,
    'Denied: nope',
  );
});

test('readinessFromHookOutput round-trips a ready payload', () => {
  const r = decide({ issue: { state: 'closed' }, mrs: [FIX] });
  const wire = JSON.parse(JSON.stringify(hook.renderOutput(r))) as Record<string, unknown>;
  assert.deepEqual(readinessFromHookOutput(wire, 101), r);

  // A verdict about another ticket is not a verdict about this one.
  const other = readinessFromHookOutput(wire, 102);
  assert.equal(other.verdict, 'unknown');
  assert.match(other.error ?? '', /answered for #101, not #102/);
});

test('withdrawnLabels names the missing switch labels, Loop first, and nothing when only the rules fail', () => {
  const names = { loop: L, trigger: T };
  assert.deepEqual(withdrawnLabels(decide({ issue: { labels: [] }, mrs: [] }), names), [L, T]);
  assert.deepEqual(withdrawnLabels(decide({ issue: { labels: [T, D] }, mrs: [] }), names), [L]);
  assert.deepEqual(withdrawnLabels(decide({ issue: { labels: [L, D] }, mrs: [] }), names), [T]);
  assert.deepEqual(withdrawnLabels(decide({ mrs: [] }), names), []);
  assert.deepEqual(withdrawnLabels(decide({ issue: { state: 'closed' }, mrs: [FIX] }), names), []);
});

// ---------------------------------------------------------------- the master switch

test('a ticket that is otherwise ready but has no Loop is not ready, for that one reason', () => {
  const r = decide({
    issue: { state: 'closed', labels: [T, D] },
    events: [add(D, '2026-09-17T20:42:40+05:00'), add(T, '2026-09-28T16:11:43+05:00')],
    mrs: [FIX],
  });
  assert.equal(r.verdict, 'not-ready');
  assert.deepEqual(codes(r), ['loop-missing']);
  const why = reason(r, 'loop-missing');
  assert.equal(why.detail, 'absent');
  assert.equal(why.text, `\`${L}\` is not on the ticket.`);
  assert.match(why.fix, new RegExp(`^Add \`${L}\``));
  // Everything else was still judged: the merged fix is named, as for a ready ticket.
  assert.deepEqual(r.merged.map((m) => m.iid), [501]);
  assert.match(r.fingerprint ?? '', /^[0-9a-f]{12}$/);
});

test('loop-missing comes first beside the other reasons, and is part of the fingerprint', () => {
  const facts = { events: [add(T, '2026-09-20T10:00:00+05:00')], mrs: [] };
  const without = decide({ ...facts, issue: { labels: [T] } });
  assert.deepEqual(codes(without), ['loop-missing', 'rfd-order', 'mr-not-merged']);
  const withLoop = decide({ ...facts, issue: { labels: [L, T] } });
  assert.deepEqual(codes(withLoop), ['rfd-order', 'mr-not-merged']);
  assert.notEqual(without.fingerprint, withLoop.fingerprint);

  const neither = decide({ issue: { state: 'closed', labels: [D] }, mrs: [] });
  assert.deepEqual(codes(neither), ['loop-missing', 'rfa-missing', 'mr-not-merged']);
});

test('the script answers a ticket without Loop with a block that says why', () => {
  const r = decide({ issue: { state: 'closed', labels: [T, D] }, mrs: [FIX] });
  const out = hook.renderOutput(r);
  assert.equal(out.decision, 'block');
  assert.equal('hookSpecificOutput' in out, false);
  assert.equal(out.reason, `Not ready for automation test cases: \`${L}\` is not on the ticket.`);
});

test('the hook and the conductor agree on the phase name', () => {
  assert.equal(hook.PHASE, AUTOMATION_PHASE);
});
