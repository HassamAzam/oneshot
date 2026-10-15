import '../lib/test-project-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { automationOwns, orderCandidates, triage } from './watcher.js';
import { automationTriggerLabel, projectConfig } from '../lib/config.js';
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

// ------------------------------------------------ Loop vs the automation mode

const TRIGGER = 'Ready For Automation';

test('the Loop skips a ticket carrying Ready For Automation beside Loop, and says the automation mode owns it', () => {
  // The default reads the trigger from config/project.json: the rule the scan applies.
  assert.equal(automationTriggerLabel(), TRIGGER);
  assert.equal(automationOwns(['Loop', TRIGGER]), `carries "${TRIGGER}" — the automation mode owns it`);
  assert.equal(automationOwns(['Loop', 'Bug', TRIGGER, 'Ready For Deployment']),
    `carries "${TRIGGER}" — the automation mode owns it`);
});

test('the trigger without Loop keeps the pipeline off, and the reason names both ways out instead of an owner', () => {
  assert.equal(automationOwns([TRIGGER]),
    `carries "${TRIGGER}", which keeps the pipeline off it — add "Loop" for automation test cases, `
    + `or remove "${TRIGGER}" to run the pipeline`);
  assert.equal(automationOwns(['Bug', TRIGGER, 'Ready For Deployment'])?.includes('the automation mode owns it'), false);
});

test('a plain Loop ticket is still the Loop\'s, whatever else it carries', () => {
  assert.equal(automationOwns(['Loop']), null);
  assert.equal(automationOwns(['Loop', 'Bug', 'Ready For Deployment', 'Automation Done']), null);
  // Exact, case-sensitive names, like every other label check.
  assert.equal(automationOwns(['Loop', 'Ready for Automation']), null);
});

test('the rule holds with the automation mode switched off on this desk', () => {
  const was = process.env.ONESHOT_AUTOMATION;
  delete process.env.ONESHOT_AUTOMATION;
  try {
    assert.notEqual(automationOwns(['Loop', TRIGGER]), null);
  } finally {
    if (was !== undefined) process.env.ONESHOT_AUTOMATION = was;
  }
});

test('with no usable automation block there is no trigger to route on, and the Loop is unchanged', () => {
  type Cfg = Parameters<typeof automationTriggerLabel>[0];
  const real = projectConfig().automation!;
  for (const cfg of [{}, { automation: undefined }, { automation: 'nope' }, { automation: { labels: {} } },
    { automation: { labels: { trigger: '  ' } } }, { automation: { labels: { trigger: 7 } } },
    // Names its trigger, but the mode could never run with it: nobody would work the ticket.
    { automation: { labels: { trigger: TRIGGER } } },
    { automation: { ...real, sheet: { ...real.sheet, spreadsheetId: '' } } },
    { automation: { ...real, recheckMinutes: 0 } }]) {
    const trigger = automationTriggerLabel(cfg as Cfg);
    assert.equal(trigger, null, JSON.stringify(cfg));
    assert.equal(automationOwns(['Loop', TRIGGER], trigger), null, JSON.stringify(cfg));
  }
  // A usable block routes on its trigger, and the real config reads without throwing.
  assert.equal(automationTriggerLabel({ automation: { ...real } }), TRIGGER);
  assert.doesNotThrow(() => automationTriggerLabel());
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

test('the Loop\'s scan asks GitLab to leave Ready For Automation tickets off its one page', async () => {
  const f = stubFetch(() => []);
  try {
    assert.equal((await issuesWithEntryLabel()).ok, true);
    assert.deepEqual(f.urls, [
      `GET ${API}/issues?state=opened&labels=Loop&not%5Blabels%5D=Ready%20For%20Automation`
        + '&per_page=50&order_by=updated_at&sort=asc',
    ]);
  } finally {
    f.restore();
  }
});

test('the scan skips a Loop + Ready For Automation ticket that reaches it anyway, before any claim is read', async () => {
  const unassigned = (iid: number, labels: string[]): Issue => ({ ...issue(iid), labels, assignees: [] });
  const f = stubFetch((url) => (url.includes('/notes') ? [] : undefined));
  try {
    const r = await triage([
      unassigned(990401, ['Loop', TRIGGER]),
      unassigned(990402, ['Loop']),
      unassigned(990403, ['Loop', 'Bug', TRIGGER, 'Ready For Deployment']),
    ]);
    assert.deepEqual(iids(r.candidates), [990402]);
    assert.deepEqual(r.skipped, [
      { iid: 990401, why: `carries "${TRIGGER}" — the automation mode owns it` },
      { iid: 990403, why: `carries "${TRIGGER}" — the automation mode owns it` },
    ]);
    // Only the Loop's own ticket had its claim notes read.
    assert.ok(f.urls.length > 0 && f.urls.every((u) => u.includes('/issues/990402/notes')), f.urls.join('\n'));
  } finally {
    f.restore();
  }
});
