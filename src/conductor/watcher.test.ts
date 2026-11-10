import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { orderCandidates, triage } from './watcher.js';
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
