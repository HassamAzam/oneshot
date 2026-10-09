/**
 * The local automation tests mode's readiness rules, tested through the hook
 * file itself, and the call that runs it.
 *
 * hooks/local-tests-ready.cjs is dependency-free CJS the conductor runs as its
 * own process; its pure decision function is reached here with createRequire
 * rather than re-implemented, so the rules under test are the rules that run.
 * The last tests run the REAL script as a process against a fixture GitLab on
 * 127.0.0.1, with a scratch ONESHOT_HOME so its verdict log lands in a temp
 * dir, not this checkout's live state/.
 *
 * Every iid, MR number and sha is invented. The shapes mirror real tickets: a
 * merged fix beside a `stage → dev` backmerge, a fix still open, a fix merged
 * into stage instead of dev, two fixes merged one after the other, the
 * ticket's own fix still open while another ticket's MR that mentions it is
 * merged, and a squash or fast-forward merge with no merge commit.
 */
import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { scratchHome } from '../lib/test-scratch-home.js';
import {
  checkLocalTestsReady, mergedBase, mergedRanges, readinessFromOutput, unknownVerdict, type LocalTestsReadiness,
} from './readiness.js';

interface Mr {
  iid: number; project_id?: number; state: string; source_branch: string; target_branch: string; title?: string;
  merged_at?: string | null; merge_commit_sha?: string | null; squash_commit_sha?: string | null; sha?: string;
  author?: { username: string }; web_url?: string; closesIssue?: boolean;
  diff_refs?: { base_sha: string | null; head_sha?: string; start_sha?: string } | null;
}
interface Facts {
  issue: { iid: number; labels: string[]; project_id: number; updated_at?: string };
  mrs: Mr[];
  trigger: string;
  base: string;
  protectedBranches: string[];
  releaseBranch: RegExp | null;
  assumeLabel?: boolean;
}
interface ReadyHook {
  decideReadiness(f: Facts): LocalTestsReadiness;
  isPromotion(mr: Partial<Mr>, protectedBranches: string[], releaseBranch: RegExp | null): boolean;
  mergeShaOf(mr: Partial<Mr>): string;
  baseOf(mr: Partial<Mr>): string | null;
  mergeLinked(related: Mr[], closing: Mr[]): Mr[];
  renderOutput(r: LocalTestsReadiness): Record<string, unknown>;
  classifyHttp(status: number): string;
}

const hook = createRequire(import.meta.url)('../../hooks/local-tests-ready.cjs') as ReadyHook;

const TRIGGER = 'Ready for Automation Testing';
const PROTECTED = ['dev', 'stage', 'master', 'main'];
const RELEASE = /^Adhoc-\d{4}-\d{2}-\d{2}$/i;
const SHA = (c: string): string => c.repeat(40);

const fix = (over: Partial<Mr> = {}): Mr => ({
  iid: 301, project_id: 7, state: 'merged', source_branch: 'oneshot/ticket-990601-leave-form', target_branch: 'dev',
  title: 'Fix the leave form total', merged_at: '2026-10-08T10:00:00Z', merge_commit_sha: SHA('a'),
  author: { username: 'hira.ijaz' }, web_url: 'https://gitlab.example.com/acme/erp/-/merge_requests/301', ...over,
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  issue: { iid: 990601, labels: [TRIGGER], project_id: 7, updated_at: '2026-10-08T11:00:00Z' },
  mrs: [fix()], trigger: TRIGGER, base: 'dev', protectedBranches: PROTECTED, releaseBranch: RELEASE, ...over,
});

test('a merged fix into the base is ready, and its merge commit is the code under test', () => {
  const r = hook.decideReadiness(facts());
  assert.equal(r.verdict, 'ready');
  assert.equal(r.ready, true);
  assert.deepEqual(r.mergedMr, {
    iid: 301, title: 'Fix the leave form total', mergeSha: SHA('a'), base: null, sourceBranch: 'oneshot/ticket-990601-leave-form',
    targetBranch: 'dev', author: 'hira.ijaz', mergedAt: '2026-10-08T10:00:00Z',
    url: 'https://gitlab.example.com/acme/erp/-/merge_requests/301',
    ranges: [{ mrIid: 301, base: null, head: SHA('a') }],
  }, 'a merge commit\'s base is its first parent, which the runner reads from git');
  assert.match(r.reason, /!301 .* is merged as aaaaaaa/);
  assert.deepEqual(r.warnings, []);
});

test('a promotion or a backmerge is never the change, whatever it merged', () => {
  for (const promo of [
    fix({ iid: 302, source_branch: 'stage', title: 'stage -> dev' }),
    fix({ iid: 303, source_branch: 'Adhoc-2026-10-01', title: 'release' }),
    fix({ iid: 304, source_branch: 'sync-stage', title: 'Backmerge stage into dev' }),
    fix({ iid: 305, source_branch: 'promote-x', title: 'master → dev' }),
  ]) {
    const r = hook.decideReadiness(facts({ mrs: [promo] }));
    assert.equal(r.verdict, 'not-ready', promo.title);
    assert.match(r.reason, /only branch promotions/, promo.title);
    assert.equal(r.mergedMr, null);
  }
  // Beside a real fix, a promotion changes nothing.
  const both = hook.decideReadiness(facts({ mrs: [fix({ iid: 302, source_branch: 'stage', merged_at: '2026-10-09T00:00:00Z' }), fix()] }));
  assert.equal(both.mergedMr?.iid, 301);
  assert.equal(hook.isPromotion({ source_branch: 'oneshot/x', title: 'Fix stage date picker' }, PROTECTED, RELEASE), false,
    'a fix that names a branch is still a fix');
});

test('an open or unmerged fix is a quiet wait, with what is missing named', () => {
  const open = hook.decideReadiness(facts({ mrs: [fix({ state: 'opened', merged_at: null, merge_commit_sha: null })] }));
  assert.equal(open.verdict, 'not-ready');
  assert.match(open.reason, /no linked merge request is merged into dev yet: !301 is still open/);

  const closed = hook.decideReadiness(facts({ mrs: [fix({ state: 'closed', merged_at: null })] }));
  assert.match(closed.reason, /!301 was closed without merging/);

  const none = hook.decideReadiness(facts({ mrs: [] }));
  assert.match(none.reason, /no merge request is linked to this ticket/);

  const stage = hook.decideReadiness(facts({ mrs: [fix({ target_branch: 'stage' })] }));
  assert.equal(stage.verdict, 'not-ready', 'merged, but not into the base');
  assert.match(stage.reason, /!301 was merged into stage/);
});

test('the trigger is required, unless a dry run assumes it; the merged check applies either way', () => {
  const unlabelled = facts({ issue: { iid: 990601, labels: [], project_id: 7 } });
  const r = hook.decideReadiness(unlabelled);
  assert.equal(r.verdict, 'not-ready');
  assert.equal(r.labelled, false);
  assert.match(r.reason, /"Ready for Automation Testing" is not on the ticket/);

  assert.equal(hook.decideReadiness({ ...unlabelled, assumeLabel: true }).verdict, 'ready');
  const notMerged = hook.decideReadiness({ ...unlabelled, assumeLabel: true, mrs: [fix({ state: 'opened' })] });
  assert.equal(notMerged.verdict, 'not-ready', '--assume-label never stands in for the merge');
  assert.equal(notMerged.labelled, true);
});

test('the latest of several merged fixes is tested; leftovers and the rest are warnings', () => {
  const r = hook.decideReadiness(facts({
    mrs: [
      fix({ iid: 310, merged_at: '2026-10-08T09:00:00Z', merge_commit_sha: SHA('1') }),
      fix({ iid: 311, merged_at: '2026-10-08T12:00:00Z', merge_commit_sha: SHA('2') }),
      fix({ iid: 312, state: 'opened', merged_at: null }),
      fix({ iid: 313, target_branch: 'stage', merge_commit_sha: SHA('3') }),
    ],
  }));
  assert.equal(r.mergedMr?.iid, 311);
  assert.equal(r.mergedMr?.mergeSha, SHA('2'));
  assert.deepEqual(r.mergedMr?.ranges, [{ mrIid: 310, base: null, head: SHA('1') }, { mrIid: 311, base: null, head: SHA('2') }],
    'both merges are scoped, oldest first');
  assert.ok(r.warnings.some((w) => /!310 also merged into dev; !311, the latest of the ticket's own/.test(w)));
  assert.ok(r.warnings.some((w) => /!312 is still open/.test(w)));
  assert.ok(r.warnings.some((w) => /!313 was merged into stage, not dev/.test(w)));
});

test('the ticket\'s own change wins over a later MR that only mentions it', () => {
  // Another ticket's MR saying "see also #990601" is linked too, and merged later.
  const own = fix({ iid: 350, source_branch: 'hira/990601-leave-total', merged_at: '2026-10-08T09:00:00Z', merge_commit_sha: SHA('6') });
  const mention = fix({ iid: 351, source_branch: 'hira/8338-training-link', title: 'Training link', merged_at: '2026-10-08T12:00:00Z', merge_commit_sha: SHA('7') });
  const r1 = hook.decideReadiness(facts({ mrs: [own, mention] }));
  assert.equal(r1.mergedMr?.iid, 350, 'the branch names the ticket');
  assert.deepEqual(r1.mergedMr?.ranges, [{ mrIid: 350, base: null, head: SHA('6') }], 'the mention is never scoped');
  assert.ok(r1.warnings.some((w) => /!351 also merged into dev but only mentions the ticket, so not tested/.test(w)));

  // An older MR that closes the ticket and a later one that names it are both
  // its own: the later one is the newest code, and the older one's change is scoped too.
  const closes = fix({ iid: 352, source_branch: 'hira/leave-total-v2', title: 'Leave total', merged_at: '2026-10-08T08:00:00Z', merge_commit_sha: SHA('8') });
  const linked = hook.mergeLinked([own, mention, closes], [closes]);
  const r = hook.decideReadiness(facts({ mrs: linked }));
  assert.equal(r.verdict, 'ready');
  assert.equal(r.mergedMr?.iid, 350, 'the latest own merge, not the older closing one');
  assert.equal(r.mergedMr?.mergeSha, SHA('6'));
  assert.deepEqual(r.mergedMr?.ranges, [{ mrIid: 352, base: null, head: SHA('8') }, { mrIid: 350, base: null, head: SHA('6') }]);
  assert.ok(r.warnings.some((w) => /!352 also merged into dev; !350, the latest of the ticket's own, is the commit tested, and all 2 are scoped/.test(w)));
  assert.ok(r.warnings.some((w) => /!351 also merged into dev but only mentions the ticket/.test(w)));

  // Nothing closes or names it: the latest linked merge, as before, and it alone is scoped.
  const other = fix({ iid: 353, source_branch: 'x', title: 'y', merged_at: '2026-10-07T00:00:00Z', merge_commit_sha: SHA('9') });
  const fb = hook.decideReadiness(facts({ mrs: [mention, other] }));
  assert.equal(fb.mergedMr?.iid, 351);
  assert.deepEqual(fb.mergedMr?.ranges, [{ mrIid: 351, base: null, head: SHA('7') }]);
  assert.ok(fb.warnings.some((w) => /nothing linked closes or names #990601, so !351, the latest linked merge into dev, is taken as its change \(!353 also merged into dev\)/.test(w)));
});

test('the ticket\'s own MR still open is a wait, even with another ticket\'s MR that mentions it merged', () => {
  const ownOpen = fix({ iid: 360, source_branch: 'oneshot/ticket-990601-fix', state: 'opened', merged_at: null, merge_commit_sha: null });
  const mention = fix({ iid: 361, source_branch: 'hira/8801-x', title: 'Unrelated fix (its description says see also the leave ticket)', merged_at: '2026-10-08T12:00:00Z', merge_commit_sha: SHA('b') });
  const r = hook.decideReadiness(facts({ mrs: [ownOpen, mention] }));
  assert.equal(r.verdict, 'not-ready');
  assert.equal(r.ready, false);
  assert.equal(r.mergedMr, null, 'the mention is never the change under test');
  assert.match(r.reason, /no merge request of the ticket's own is merged into dev yet: !360 is still open \(!361 is merged into dev but only mentions the ticket, so it is not its change\)/);

  // Own by closing it alone: its branch and title name nothing, but closed_by lists it.
  const closesOpen = fix({ iid: 362, source_branch: 'hira/leave-work', title: 'Leave work', state: 'opened', merged_at: null, merge_commit_sha: null });
  const waiting = hook.decideReadiness(facts({ mrs: hook.mergeLinked([closesOpen, mention], [closesOpen]) }));
  assert.equal(waiting.verdict, 'not-ready');
  assert.match(waiting.reason, /!362 is still open \(!361 is merged into dev/);

  // Merged into stage only is not into dev either.
  const ownStage = fix({ iid: 363, source_branch: 'oneshot/ticket-990601-fix', target_branch: 'stage', merge_commit_sha: SHA('c') });
  assert.match(hook.decideReadiness(facts({ mrs: [ownStage, mention] })).reason, /!363 was merged into stage \(!361 is merged into dev/);

  // Once the own MR merges, it is the change and the mention is a warning.
  const merged = hook.decideReadiness(facts({ mrs: [{ ...ownOpen, state: 'merged', merged_at: '2026-10-08T13:00:00Z', merge_commit_sha: SHA('d') }, mention] }));
  assert.equal(merged.mergedMr?.iid, 360);
  assert.deepEqual(merged.mergedMr?.ranges, [{ mrIid: 360, base: null, head: SHA('d') }]);
});

test('a squash or fast-forward merge is tested at the commit it left, and says so', () => {
  const refs = { base_sha: SHA('b'), head_sha: SHA('c'), start_sha: SHA('f') };
  const squash = hook.decideReadiness(facts({ mrs: [fix({ merge_commit_sha: null, squash_commit_sha: SHA('5'), diff_refs: refs })] }));
  assert.equal(squash.mergedMr?.mergeSha, SHA('5'));
  assert.equal(squash.mergedMr?.base, null, 'a squash commit\'s first parent is the base before the merge');
  assert.ok(squash.warnings.some((w) => /squash commit 5555555 is tested/.test(w)));

  // A merge commit's first parent is the base, whatever the diff base says.
  assert.equal(hook.decideReadiness(facts({ mrs: [fix({ diff_refs: refs })] })).mergedMr?.base, null);

  const nothing = hook.decideReadiness(facts({ mrs: [fix({ merge_commit_sha: null })] }));
  assert.equal(nothing.verdict, 'not-ready', 'no commit named, nothing to run against');
  assert.equal(hook.mergeShaOf({ sha: 'not-a-sha' }), '');
});

test('a fast-forward merge has its base from GitLab\'s diff base, not its own previous commit', () => {
  // No merge commit and no squash commit: the MR's head is what reached dev.
  const ff = fix({ merge_commit_sha: null, squash_commit_sha: null, sha: SHA('c'), diff_refs: { base_sha: SHA('b'), head_sha: SHA('c') } });
  const r = hook.decideReadiness(facts({ mrs: [ff] }));
  assert.equal(r.verdict, 'ready');
  assert.equal(r.mergedMr?.mergeSha, SHA('c'));
  assert.equal(r.mergedMr?.base, SHA('b'), 'head^1 would cover only the last of several commits');
  assert.deepEqual(r.mergedMr?.ranges, [{ mrIid: 301, base: SHA('b'), head: SHA('c') }]);
  assert.ok(r.warnings.some((w) => /head commit ccccccc is tested, against its diff base bbbbbbb/.test(w)));

  // No diff base (a list item, an odd GitLab): null, and the warning says only the last commit is scoped.
  const bare = hook.decideReadiness(facts({ mrs: [fix({ merge_commit_sha: null, sha: SHA('c') })] }));
  assert.equal(bare.mergedMr?.base, null);
  assert.ok(bare.warnings.some((w) => /GitLab gave no diff base: only its last commit is scoped/.test(w)));

  // A diff base that is not a commit id, or is the head itself, is never passed on.
  assert.equal(hook.baseOf({ merge_commit_sha: null, sha: SHA('c'), diff_refs: { base_sha: '--output=/tmp/x' } }), null);
  assert.equal(hook.baseOf({ merge_commit_sha: null, sha: SHA('c'), diff_refs: { base_sha: SHA('c') } }), null);
  assert.equal(hook.baseOf({ merge_commit_sha: null, sha: SHA('c'), diff_refs: null }), null);

  // An earlier own fast-forward among the ranges keeps its own diff base.
  const earlier = fix({ iid: 370, merged_at: '2026-10-08T08:00:00Z', merge_commit_sha: null, sha: SHA('4'), diff_refs: { base_sha: SHA('3') } });
  const both = hook.decideReadiness(facts({ mrs: [earlier, fix()] }));
  assert.equal(both.mergedMr?.iid, 301);
  assert.deepEqual(both.mergedMr?.ranges, [{ mrIid: 370, base: SHA('3'), head: SHA('4') }, { mrIid: 301, base: null, head: SHA('a') }]);
});

test('MRs from another project are not this ticket\'s change; related and closing lists merge by MR', () => {
  assert.equal(hook.decideReadiness(facts({ mrs: [fix({ project_id: 99 })] })).verdict, 'not-ready');
  const merged = hook.mergeLinked([fix({ iid: 1 }), fix({ iid: 2 })], [fix({ iid: 2, title: 'fuller' })]);
  assert.deepEqual(merged.map((m) => [m.iid, m.title, (m as { closesIssue?: boolean }).closesIssue ?? false]),
    [[1, 'Fix the leave form total', false], [2, 'fuller', true]]);
});

test('the script answers in the guard shape, and the conductor reads only a verdict for this ticket', () => {
  const ready = hook.decideReadiness(facts());
  assert.deepEqual(hook.renderOutput(ready), { localTestsReadiness: ready });
  const waiting = hook.decideReadiness(facts({ mrs: [] }));
  const out = hook.renderOutput(waiting);
  assert.equal(out.decision, 'block');
  assert.match(String(out.reason), /Not ready for the local automation tests/);

  assert.deepEqual(readinessFromOutput(hook.renderOutput(ready), 990601), ready);
  assert.equal(readinessFromOutput(hook.renderOutput(ready), 990602).verdict, 'unknown', 'another ticket\'s verdict');
  assert.equal(readinessFromOutput({}, 990601).verdict, 'unknown');
  assert.equal(readinessFromOutput('garbage', 990601).verdict, 'unknown');
  assert.match(readinessFromOutput({ reason: 'Cannot check readiness: x' }, 990601).reason, /Cannot check readiness: x/);
  const forged = { localTestsReadiness: { ...ready, mergedMr: null } };
  assert.equal(readinessFromOutput(forged, 990601).verdict, 'unknown', 'a ready with nothing to run is no verdict');
  assert.ok(ready.mergedMr);
  const bad = (m: Record<string, unknown>): string => readinessFromOutput({ localTestsReadiness: { ...ready, mergedMr: { ...ready.mergedMr, ...m } } }, 990601).verdict;
  assert.equal(bad({ base: '--output=/tmp/x' }), 'unknown', 'a base that is not a commit id never reaches git');
  assert.equal(bad({ ranges: [{ mrIid: 301, base: null, head: '-x' }] }), 'unknown');
  assert.equal(bad({ ranges: [] }), 'unknown', 'ranges, when given, name the tested merge');
  assert.equal(bad({ ranges: [{ mrIid: 300, base: null, head: SHA('a') }] }), 'unknown', 'the last range is the tested merge');
  assert.equal(bad({ mergeSha: 'HEAD' }), 'unknown');
  // A verdict made before base and ranges existed still reads, with both filled in.
  const { base: _b, ranges: _r, ...older } = ready.mergedMr;
  const read = readinessFromOutput({ localTestsReadiness: { ...ready, mergedMr: older } }, 990601);
  assert.equal(read.verdict, 'ready');
  assert.equal(read.mergedMr?.base, null);
  assert.deepEqual(read.mergedMr?.ranges, [{ mrIid: 301, base: null, head: SHA('a') }]);
  assert.deepEqual(mergedRanges(older), [{ mrIid: 301, base: null, head: SHA('a') }]);
  assert.equal(mergedBase(older), null);
  assert.equal(unknownVerdict(1, 'x').ready, false);
  assert.equal(hook.classifyHttp(401), 'auth');
  assert.equal(hook.classifyHttp(503), 'server');
});

// ------------------------------------------------- the real script, as a process

const world = {
  issue: { iid: 990601, project_id: 7, title: 'Leave form', labels: [TRIGGER] as string[], updated_at: '2026-10-08T11:00:00Z' },
  related: [] as Mr[],
  closing: [] as Mr[] | null,
  details: new Map<number, Mr>(),
  requests: [] as string[],
};

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  world.requests.push(url);
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const base = '/api/v4/projects/acme%2Ferp';
  if (req.headers['private-token'] !== 'fixture-token') return send(401, { message: '401 Unauthorized' });
  if (url.startsWith(`${base}/issues/990601/related_merge_requests`)) return send(200, world.related);
  if (url.startsWith(`${base}/issues/990601/closed_by`)) return world.closing ? send(200, world.closing) : send(404, {});
  if (url === `${base}/issues/990601`) return send(200, world.issue);
  const mr = /^\/api\/v4\/projects\/acme%2Ferp\/merge_requests\/(\d+)$/.exec(url);
  if (mr && world.details.has(Number(mr[1]))) return send(200, world.details.get(Number(mr[1])));
  return send(404, { message: `not in the fixture: ${url}` });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
server.unref();
const port = (server.address() as AddressInfo).port;
const scratch = scratchHome();
after(() => { scratch.cleanup(); server.close(); });

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ONESHOT_HOME: scratch.home,
  ONESHOT_LOCAL_TESTS_API: `http://127.0.0.1:${port}/api/v4`,
  ONESHOT_LOCAL_TESTS_PROJECT: 'acme/erp',
  ONESHOT_LOCAL_TESTS_TOKEN: 'fixture-token',
  ...over,
});

test('the real script: a merged fix found through the closing list, its merge commit read from the MR itself', async () => {
  // The related list leaves the merge commit out; the MR itself names it.
  world.related = [fix({ iid: 320, merge_commit_sha: null, author: undefined }), fix({ iid: 321, source_branch: 'stage', title: 'stage -> dev' })];
  world.closing = [fix({ iid: 320, merge_commit_sha: null, author: undefined })];
  world.details.set(320, fix({ iid: 320, merge_commit_sha: SHA('e'), author: { username: 'usman.nasir' } }));
  world.requests = [];

  const r = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev' }, env());

  assert.equal(r.verdict, 'ready', r.reason);
  assert.equal(r.mergedMr?.iid, 320);
  assert.equal(r.mergedMr?.mergeSha, SHA('e'));
  assert.equal(r.mergedMr?.author, 'usman.nasir');
  assert.ok(world.requests.some((u) => u.endsWith('/merge_requests/320')), 'one more GET, for the MR that matters');
  assert.ok(!world.requests.some((u) => u.endsWith('/merge_requests/321')), 'never for a promotion');
});

test('the real script: two own merges, each read in full, the latest tested and both scoped', async () => {
  // The list leaves merge commits and diff bases out. !380 is a fast-forward; !381 a merge commit.
  world.related = [
    fix({ iid: 380, merged_at: '2026-10-08T08:00:00Z', merge_commit_sha: null }),
    fix({ iid: 381, merged_at: '2026-10-08T12:00:00Z', merge_commit_sha: null }),
    fix({ iid: 382, source_branch: 'hira/8801-x', title: 'Other ticket', merged_at: '2026-10-08T13:00:00Z', merge_commit_sha: null }),
  ];
  world.closing = [];
  world.details.set(380, fix({ iid: 380, merged_at: '2026-10-08T08:00:00Z', merge_commit_sha: null, sha: SHA('4'), diff_refs: { base_sha: SHA('3') } }));
  world.details.set(381, fix({ iid: 381, merged_at: '2026-10-08T12:00:00Z', merge_commit_sha: SHA('5') }));
  world.requests = [];

  const r = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev' }, env());

  assert.equal(r.verdict, 'ready', r.reason);
  assert.equal(r.mergedMr?.iid, 381);
  assert.equal(r.mergedMr?.mergeSha, SHA('5'));
  assert.equal(r.mergedMr?.base, null);
  assert.deepEqual(r.mergedMr?.ranges, [{ mrIid: 380, base: SHA('3'), head: SHA('4') }, { mrIid: 381, base: null, head: SHA('5') }]);
  assert.ok(world.requests.some((u) => u.endsWith('/merge_requests/380')) && world.requests.some((u) => u.endsWith('/merge_requests/381')));
  assert.ok(!world.requests.some((u) => u.endsWith('/merge_requests/382')), 'never for an MR that only mentions the ticket');
});

test('the real script: a fast-forward merge reads its diff base from the MR itself', async () => {
  world.related = [fix({ iid: 390, merge_commit_sha: null })];
  world.closing = [];
  world.details.set(390, fix({ iid: 390, merge_commit_sha: null, squash_commit_sha: null, sha: SHA('c'), diff_refs: { base_sha: SHA('b'), head_sha: SHA('c') } }));
  const r = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev' }, env());
  assert.equal(r.verdict, 'ready', r.reason);
  assert.equal(r.mergedMr?.mergeSha, SHA('c'));
  assert.equal(r.mergedMr?.base, SHA('b'));
});

test('the real script: the ticket\'s own MR open and a mention merged is a wait, with no GET for the mention', async () => {
  world.related = [
    fix({ iid: 395, source_branch: 'oneshot/ticket-990601-fix', state: 'opened', merged_at: null, merge_commit_sha: null }),
    fix({ iid: 396, source_branch: 'hira/8801-x', title: 'Other ticket', merge_commit_sha: SHA('d') }),
  ];
  world.closing = [];
  world.requests = [];
  const r = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev' }, env());
  assert.equal(r.verdict, 'not-ready');
  assert.equal(r.mergedMr, null);
  assert.match(r.reason, /!395 is still open \(!396 is merged into dev but only mentions the ticket/);
  assert.ok(!world.requests.some((u) => /\/merge_requests\/\d+$/.test(u)), 'nothing to read in full');
});

test('the real script: labelled, not merged, and an old GitLab without closed_by', async () => {
  world.related = [fix({ iid: 330, state: 'opened', merged_at: null, merge_commit_sha: null })];
  world.closing = null;
  const r = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev' }, env());
  assert.equal(r.verdict, 'not-ready');
  assert.match(r.reason, /!330 is still open/);
});

test('the real script: a refused token is `unknown`, never a verdict', async () => {
  const r = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev' }, env({ ONESHOT_LOCAL_TESTS_TOKEN: 'wrong' }));
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.errorKind, 'auth');
  assert.doesNotMatch(JSON.stringify(r), /wrong/, 'the token is never repeated');
});

test('the real script: --assume-label stands in for the trigger only', async () => {
  world.issue.labels = [];
  world.related = [fix({ iid: 340 })];
  world.closing = [];
  world.details.set(340, fix({ iid: 340 }));
  try {
    const plain = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev' }, env());
    assert.equal(plain.verdict, 'not-ready');
    assert.equal(plain.labelled, false);
    const assumed = await checkLocalTestsReady(990601, { trigger: TRIGGER, base: 'dev', assumeLabel: true }, env());
    assert.equal(assumed.verdict, 'ready');
  } finally {
    world.issue.labels = [TRIGGER];
  }
});
