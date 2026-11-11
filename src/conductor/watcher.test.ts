import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWaitRemaining, orderCandidates, triage } from './watcher.js';
import type { RunJournal } from '../lib/artifacts.js';
import { db } from '../lib/db.js';
import { issuesWithEntryLabel, type Issue } from '../lib/gitlab.js';

// Set rather than inherited, so this machine's .env and desk token cannot change the answer.
process.env.GITLAB_READ_TOKEN = 'test-read-token';
process.env.ONESHOT_GITLAB_TOKEN = 'test-write-token';

function issue(iid: number): Issue {
  return {
    iid,
    title: `#${iid}`,
    description: null,
    labels: ['Loop'],
    assignees: [{ username: 'hassam.azam' }],
    state: 'opened',
    web_url: `https://example/${iid}`,
    updated_at: '2026-09-15T00:00:00.000Z',
  };
}

const iids = (list: Issue[]): number[] => list.map((i) => i.iid);

test('a parked head ticket no longer starves fresh work behind it', () => {
  const candidates = [issue(87), issue(235), issue(237)];
  const status = (iid: number): string | null =>
    ({ 87: 'parked', 237: 'blocked' } as Record<number, string>)[iid] ?? null;

  assert.deepEqual(iids(orderCandidates(candidates, status)), [235, 87, 237]);
});

test('order is preserved within the ready and stalled halves', () => {
  const candidates = [issue(10), issue(11), issue(12), issue(13)];
  const status = (iid: number): string | null =>
    ({ 10: 'parked', 12: 'blocked' } as Record<number, string>)[iid] ?? null;

  assert.deepEqual(iids(orderCandidates(candidates, status)), [11, 13, 10, 12]);
});

test('all-ready and all-stalled lists are returned unchanged', () => {
  const ready = [issue(1), issue(2)];
  assert.deepEqual(iids(orderCandidates(ready, () => null)), [1, 2]);

  const stalled = [issue(3), issue(4)];
  assert.deepEqual(iids(orderCandidates(stalled, () => 'parked')), [3, 4]);
});

test('resumable in-progress work counts as ready, not stalled', () => {
  const candidates = [issue(50), issue(51)];
  const status = (iid: number): string | null =>
    ({ 50: 'parked', 51: 'aborted' } as Record<number, string>)[iid] ?? null;

  assert.deepEqual(iids(orderCandidates(candidates, status)), [51, 50]);
});

// ------------------------------------------------ the scan, over a stubbed GitLab

const API = 'https://gitlab.example.com/api/v4/projects/acme%2Ferp';
const SCANNED = [990401, 990402, 990403];
after(() => {
  for (const iid of SCANNED) db.prepare('DELETE FROM tickets_seen WHERE iid = ?').run(iid);
});

/** Records every request; `answer` gives the JSON body, or undefined for a 404. */
function stubFetch(answer: (url: string) => unknown): { urls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const body = answer(String(input));
    return body === undefined
      ? new Response('{"message":"404 Not Found"}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = real; } };
}

test('the Loop\'s scan reads the entry label alone: no label is left to another mode', async () => {
  const f = stubFetch(() => []);
  try {
    assert.equal((await issuesWithEntryLabel()).ok, true);
    assert.deepEqual(f.urls, [`GET ${API}/issues?state=opened&labels=Loop&per_page=50&order_by=updated_at&sort=asc`]);
  } finally {
    f.restore();
  }
});

test('a Loop ticket that also carries the retired Ready For Automation label is the Loop\'s like any other', async () => {
  // The Ready For Automation mode (test cases into the sheet) is gone, so its
  // label no longer keeps the pipeline off a ticket.
  const unassigned = (iid: number, labels: string[]): Issue => ({ ...issue(iid), labels, assignees: [] });
  const f = stubFetch((url) => (url.includes('/notes') ? [] : undefined));
  try {
    const r = await triage([
      unassigned(990401, ['Loop', 'Ready For Automation']),
      unassigned(990402, ['Loop']),
      unassigned(990403, ['Loop', 'Merged']),
    ]);
    assert.deepEqual(iids(r.candidates), [990401, 990402]);
    assert.deepEqual(r.skipped, [{ iid: 990403, why: 'already Merged' }]);
  } finally {
    f.restore();
  }
});

const claimNote = (id: number, runId: string, daysAgo: number): Record<string, unknown> => ({
  id, system: false, author: { username: 'a.teammate' },
  body: `Oneshot claimed this ticket — run \`${runId}\` (desk).\n\n<!-- oneshot:claim:${runId} -->`,
  created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
});

test('with ONESHOT_PICKUP_ANY_ASSIGNEE a teammate\'s unclaimed ticket is a candidate', async () => {
  process.env.ONESHOT_PICKUP_ANY_ASSIGNEE = '1';
  const f = stubFetch((url) => (url.includes('/notes') ? [] : undefined));
  try {
    const r = await triage([{ ...issue(990701), assignees: [{ username: 'usman.nasir' }] }]);
    assert.deepEqual(iids(r.candidates), [990701]);
  } finally {
    f.restore();
    delete process.env.ONESHOT_PICKUP_ANY_ASSIGNEE;
  }
});

test('with ONESHOT_PICKUP_ANY_ASSIGNEE another conductor\'s claim keeps the ticket off, however old', async () => {
  process.env.ONESHOT_PICKUP_ANY_ASSIGNEE = '1';
  const f = stubFetch((url) => (url.includes('/notes') ? [claimNote(5, 'r-elsewhere-abc123', 3)] : undefined));
  try {
    const r = await triage([{ ...issue(990702), assignees: [{ username: 'usman.nasir' }] }]);
    assert.deepEqual(iids(r.candidates), []);
    assert.match(r.skipped[0]!.why, /claimed by another conductor — run r-elsewhere-abc123/);
  } finally {
    f.restore();
    delete process.env.ONESHOT_PICKUP_ANY_ASSIGNEE;
  }
});

test('ONESHOT_PICKUP_ONLY limits candidates to the listed tickets, and a typo narrows rather than opens', async () => {
  process.env.ONESHOT_PICKUP_ANY_ASSIGNEE = '1';
  const f = stubFetch((url) => (url.includes('/notes') ? [] : undefined));
  const board = [990801, 990802, 990803].map((iid) => ({ ...issue(iid), assignees: [{ username: 'usman.nasir' }] }));
  try {
    process.env.ONESHOT_PICKUP_ONLY = '990801, 990803';
    assert.deepEqual(iids((await triage(board)).candidates), [990801, 990803]);
    process.env.ONESHOT_PICKUP_ONLY = 'abc';
    assert.deepEqual(iids((await triage(board)).candidates), []);
    process.env.ONESHOT_PICKUP_ONLY = '';
    assert.deepEqual(iids((await triage(board)).candidates), [990801, 990802, 990803]);
  } finally {
    f.restore();
    delete process.env.ONESHOT_PICKUP_ANY_ASSIGNEE;
    delete process.env.ONESHOT_PICKUP_ONLY;
  }
});

test('ONESHOT_PICKUP_SINCE takes only tickets labelled Loop after the cutoff, and skips one it cannot read', async () => {
  process.env.ONESHOT_PICKUP_ANY_ASSIGNEE = '1';
  process.env.ONESHOT_PICKUP_SINCE = '2026-11-12T00:00:00Z';
  const added = (iso: string): Record<string, unknown> => ({ action: 'add', created_at: iso, label: { name: 'Loop' } });
  const history: Record<number, unknown> = {
    990901: [added('2026-10-01T00:00:00Z')],
    990902: [added('2026-11-12T08:00:00Z')],
    990904: [added('2026-10-01T00:00:00Z'), { action: 'remove', created_at: '2026-10-02T00:00:00Z', label: { name: 'Loop' } }, added('2026-11-13T00:00:00Z')],
  };
  const f = stubFetch((url) => {
    if (url.includes('/notes')) return [];
    const m = /issues\/(\d+)\/resource_label_events/.exec(url);
    return m ? history[Number(m[1])] : undefined;
  });
  try {
    const board = [990901, 990902, 990903, 990904].map((iid) => ({ ...issue(iid), updated_at: `2026-11-12T09:00:0${iid % 10}Z` }));
    const r = await triage(board);
    assert.deepEqual(iids(r.candidates), [990902, 990904]);
    assert.deepEqual(r.skipped, [{ iid: 990903, why: 'could not read when Loop was added' }]);
  } finally {
    f.restore();
    delete process.env.ONESHOT_PICKUP_ANY_ASSIGNEE;
    delete process.env.ONESHOT_PICKUP_SINCE;
  }
});

test('an unparseable ONESHOT_PICKUP_SINCE picks up nothing new', async () => {
  process.env.ONESHOT_PICKUP_SINCE = 'tomorrow-ish';
  const f = stubFetch((url) => (url.includes('resource_label_events')
    ? [{ action: 'add', created_at: '2026-11-12T08:00:00Z', label: { name: 'Loop' } }] : []));
  try {
    assert.deepEqual(iids((await triage([{ ...issue(990911), assignees: [] }])).candidates), []);
  } finally {
    f.restore();
    delete process.env.ONESHOT_PICKUP_SINCE;
  }
});

test('ONESHOT_PICKUP_LABEL takes only tickets that also carry that label', async () => {
  process.env.ONESHOT_PICKUP_ANY_ASSIGNEE = '1';
  process.env.ONESHOT_PICKUP_LABEL = 'Loop Server';
  const f = stubFetch((url) => (url.includes('/notes') ? [] : undefined));
  try {
    const r = await triage([
      { ...issue(991001), labels: ['Loop', 'Loop Server'] },
      { ...issue(991002), labels: ['Loop'] },
      { ...issue(991003), labels: ['Loop', 'loop server'] },
    ]);
    assert.deepEqual(iids(r.candidates), [991001]);
    assert.deepEqual(r.skipped, []);
  } finally {
    f.restore();
    delete process.env.ONESHOT_PICKUP_ANY_ASSIGNEE;
    delete process.env.ONESHOT_PICKUP_LABEL;
  }
});

test('a run parked on a human merge holds no slot until its next check is due', () => {
  const now = Date.parse('2026-11-12T03:30:00Z');
  const j = (over: Partial<RunJournal>): RunJournal =>
    ({ phases: [], reviewMode: true, humanMergeCheckAt: now - 2 * 60_000, ...over }) as RunJournal;
  assert.equal(mergeWaitRemaining(j({}), 'parked', now), 28 * 60_000);
  assert.equal(mergeWaitRemaining(j({ humanMergeCheckAt: now - 31 * 60_000 }), 'parked', now), null);
  assert.equal(mergeWaitRemaining(j({}), 'running', now), null);
  assert.equal(mergeWaitRemaining(j({ reviewMode: false }), 'parked', now), null);
  assert.equal(mergeWaitRemaining(j({ humanMergeCheckAt: undefined }), 'parked', now), null);
  assert.equal(mergeWaitRemaining(j({ phases: [{ phase: 'merge', status: 'ok' }] as RunJournal['phases'] }), 'parked', now), null);
  assert.equal(mergeWaitRemaining(null, 'parked', now), null);
});

test('a Loop ticket assigned to someone else is never a candidate; an unassigned one is', async () => {
  // On 2026-11-10 a server holding a bot token briefly ran without this rule and
  // claimed three teammates' tickets out of 43 carrying Loop. The token's user
  // (empty here: no identity resolved in tests) never matches a teammate.
  const assigned = (iid: number, to: string[]): Issue => ({ ...issue(iid), assignees: to.map((username) => ({ username })) });
  const f = stubFetch((url) => (url.includes('/notes') ? [] : undefined));
  try {
    const r = await triage([assigned(990601, ['haider.usman']), assigned(990602, [])]);
    assert.deepEqual(iids(r.candidates), [990602]);
    assert.ok(!r.skipped.some((s) => s.iid === 990602));
    assert.ok(!iids(r.candidates).includes(990601));
  } finally {
    f.restore();
  }
});
