/**
 * The Loop master switch at the call sites that act on it: advanceTicket and
 * `--automation`, driven end to end against a fixture GitLab on 127.0.0.1 that
 * answers both the conductor and the REAL readiness hook, which runs as its own
 * process exactly as it does in production. Nothing leaves the machine: the
 * repo URL points at the fixture before anything imports config, no session is
 * started (every journal here is past or before authoring), and the sheet is
 * never written (an approved journal already carries its sheet result).
 *
 * What these pin, each of which a helper-only test let through:
 * - `Loop` gone is a SILENT stop at every gate — no comment, no label, the
 *   journal byte for byte as it was — and the ticket resumes with no duplicate
 *   comment when `Loop` is back (gateOnReadiness).
 * - The writes that follow a session re-read the labels, so a `Loop` taken off
 *   while it ran stops the version comment and the stuck comment (switchedOff).
 * - The version comment waits on the whole readiness check, not only the
 *   labels: a ticket reopened while its list was being written gets the
 *   not-ready comment instead of the list (stepPost).
 * - A pause holds every step, not only the session: a version comment and a
 *   finishing label edit both wait while paused, and go once when it lifts
 *   (advanceTicket). The pause is AutomationOpts.paused, never the real
 *   state/PAUSE, which would pause every phase in flight on the machine.
 * - Finishing takes `Automation Test Case Review` AND `Loop` off in the one
 *   label edit, and the done comment still posts once `Loop` is gone (stepSheet,
 *   stepDoneNote, `--automation`).
 *
 * - A lost journal numbers its fresh list from every note on the ticket, not
 *   from issueNotes()'s newest hundred (highestVersionOnTicket).
 *
 * Journals live under STATE/automation/<IID> like journal.test.ts's, with an
 * invented iid, and are removed afterwards together with the event rows this
 * file's runs log in the database. The readiness script runs with a scratch
 * ONESHOT_HOME (AutomationOpts.guardEnv), so the verdicts it appends to
 * hook-events.jsonl go to a temp dir, not this checkout's live state/.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Issue } from '../lib/gitlab.js';
import { scratchHome } from '../lib/test-scratch-home.js';

const T = 'Ready For Automation';
const L = 'Loop';
const D = 'Ready For Deployment';
const R = 'Automation Test Case Review';
const DONE = 'Automation Done';
const IID = 990501;
const BASE = `/api/v4/projects/acme%2Ferp/issues/${IID}`;

interface Note { id: number; body: string; system: boolean; author: { username: string }; created_at: string }

const world = {
  issue: {
    iid: IID, project_id: 7, title: 'Profile preferences', description: '', labels: [] as string[],
    assignees: [] as Array<{ username: string }>, state: 'closed', web_url: `http://127.0.0.1/issues/${IID}`,
    updated_at: '2026-09-28T10:00:00Z',
  },
  events: [] as unknown[],
  mrs: [] as unknown[],
  notes: [] as Note[],
  /** Every request that is not a GET, in order. */
  writes: [] as Array<{ method: string; url: string; body: Record<string, unknown> | null }>,
  nextNote: 1000,
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    let body: Record<string, unknown> | null = null;
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { body = null; }
    if (method !== 'GET') world.writes.push({ method, url, body });
    if (url.startsWith(`${BASE}/resource_label_events`)) return send(200, world.events, { 'x-total-pages': '1' });
    if (url.startsWith(`${BASE}/related_merge_requests`)) return send(200, world.mrs);
    if (url.startsWith(`${BASE}/notes`)) {
      if (method === 'POST') {
        const n: Note = {
          id: world.nextNote++, body: String(body?.body ?? ''), system: false,
          author: { username: 'desk' }, created_at: new Date().toISOString(),
        };
        world.notes.push(n);
        return send(201, n);
      }
      // Paged like GitLab: per_page, page and sort (newest first unless asked).
      const q = new URL(url, 'http://fixture').searchParams;
      const perPage = Number(q.get('per_page') ?? 20);
      const page = Number(q.get('page') ?? 1);
      const ordered = q.get('sort') === 'asc' ? [...world.notes] : [...world.notes].reverse();
      return send(200, ordered.slice((page - 1) * perPage, page * perPage));
    }
    if (url === BASE || url.startsWith(`${BASE}?`)) {
      if (method === 'PUT') {
        const add = String(body?.add_labels ?? '').split(',').filter(Boolean);
        const rm = String(body?.remove_labels ?? '').split(',').filter(Boolean);
        world.issue.labels = [...world.issue.labels.filter((l) => !rm.includes(l)), ...add.filter((l) => !world.issue.labels.includes(l))];
        world.issue.updated_at = new Date().toISOString();
      }
      return send(200, world.issue);
    }
    // Uploads included: the CSV then goes unattached, and the note says so.
    return send(404, { message: `not in the fixture: ${method} ${url}` });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
server.unref();
const port = (server.address() as AddressInfo).port;

// Set before anything imports config, so dotenv (which never overrides a key
// already set) cannot point any of this at the real GitLab, token or Slack.
process.env.GITLAB_REPO_URL = `http://127.0.0.1:${port}/acme/erp`;
process.env.GITLAB_READ_TOKEN = 'test-read-token';
process.env.ONESHOT_GITLAB_TOKEN = 'test-write-token';
process.env.SLACK_BOT_TOKEN = '';
process.env.DRY_RUN = '';

const { advanceTicket, highestVersionOnTicket, runAutomationOnce } = await import('./runner.js');
const J = await import('./journal.js');
const { getIssue, issueNotes } = await import('../lib/gitlab.js');
const { db } = await import('../lib/db.js');

const scratch = scratchHome();
// Never the machine's real state/PAUSE: an operator's pause must not change what these assert.
const opts = {
  conductor: 'test-conductor', signal: new AbortController().signal, paused: () => false,
  guardEnv: { ONESHOT_HOME: scratch.home },
};
const MERGED = {
  iid: 51, project_id: 7, state: 'merged', source_branch: 'fix/profile', target_branch: 'dev',
  merged_at: '2026-09-20T00:00:00Z', title: 'Fix profile', web_url: 'http://127.0.0.1/mr/51',
};
const runIds = new Set<string>();

after(() => {
  rmSync(J.automationDir(IID), { recursive: true, force: true });
  for (const id of runIds) db.prepare('DELETE FROM events WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM events WHERE detail LIKE ?').run(`%"iid":${IID}%`);
  scratch.cleanup();
  server.close();
});

/** A fresh world: the ticket with these labels, the trigger added once, one merged fix MR, no notes, no journal. */
function reset(labels: string[], state = 'closed'): void {
  rmSync(J.automationDir(IID), { recursive: true, force: true });
  Object.assign(world.issue, { labels, state, updated_at: '2026-09-28T10:00:00Z' });
  world.events = [{ action: 'add', created_at: '2026-09-27T00:00:00Z', label: { name: T } }];
  world.mrs = [MERGED];
  world.notes = [];
  world.writes = [];
}

async function readIssue(): Promise<Issue> {
  const r = await getIssue(IID);
  assert.ok(r.ok && r.data, 'the fixture answers the ticket');
  return r.data;
}

function journalText(): string {
  return readFileSync(join(J.automationDir(IID), 'journal.json'), 'utf8');
}

function save(j: ReturnType<typeof J.newAutoJournal>): void {
  runIds.add(j.runId);
  J.writeAutoJournal(j);
}

const writesTo = (suffix: string, method: string): number =>
  world.writes.filter((w) => w.method === method && w.url.split('?')[0]!.endsWith(suffix)).length;

/** An approved journal whose sheet is already written: the next step is the label edit. */
function approvedJournal(extra: Partial<ReturnType<typeof J.newAutoJournal>> = {}): void {
  const j = J.newAutoJournal(IID, 'Profile preferences');
  Object.assign(j, {
    state: 'approved',
    versions: [{ v: 1, module: 'Profile', count: 3, hash: 'h', noteId: 900, postedAt: 1, reviewLabelled: true, changes: [] }],
    watermark: 900,
    approval: { version: 1, by: 'anosha.saeed', noteId: 950, at: '2026-09-28T09:00:00Z' },
    sheet: {
      spreadsheetId: 's', moduleTab: 'TestCases_Profile', moduleGid: 1, blockRange: 'A1:H4', blockLink: 'http://127.0.0.1/sheet#a',
      trackerTab: 'TestCases 2026', trackerGid: 2, trackerRow: 5, trackerLink: 'http://127.0.0.1/sheet#t',
      automationStatus: 'Not started', created: { moduleTab: false, trackerTab: false, section: false, legend: false },
      alreadyThere: { block: true, trackerRow: true }, dryRun: false,
    },
    ...extra,
  });
  save(j);
}

/** A journal holding v1 written but not yet posted: what stepAuthor leaves when its session ends. */
function unpostedVersionJournal(): void {
  const j = J.newAutoJournal(IID, 'Profile preferences');
  J.saveVersion(IID, 1, {
    summary: 'Profile preferences are saved per user.',
    module: 'Profile',
    cases: [{
      id: 'TC-01', scenario: 'Verify that a saved preference is shown after a reload', precondition: 'A signed-in employee',
      steps: ['Open Profile', 'Change the theme to Dark', 'Click Save', 'Reload the page'],
      expected: 'The theme select shows Dark', automatable: 'yes', reason: 'Only UI actions and one assertion',
    }],
    changes: [],
    sources: ['!51 apps/profile/views.py'],
  });
  Object.assign(j, {
    state: 'in-review',
    readiness: { verdict: 'ready', at: Date.now(), issueUpdatedAt: world.issue.updated_at, fingerprint: null, merged: [], open: [] },
    versions: [{ v: 1, module: 'Profile', count: 1, hash: 'h1', noteId: null, postedAt: null, reviewLabelled: false, changes: [] }],
  });
  save(j);
}

// ------------------------------------------------------------------ gateOnReadiness

test('Loop taken off after the scan: the readiness gate stops silently — nothing written, no note', async () => {
  reset([L, T]);
  const scanned = await readIssue();             // the scan's copy still has Loop
  world.issue.labels = [T];                      // a person takes it off before the check
  const o = await advanceTicket(scanned, opts);
  assert.equal(o.did, `"${L}" is not on the ticket — stopped`);
  assert.deepEqual(world.writes, []);
  const j = J.readAutoJournal(IID);
  assert.equal(j?.state, 'new');
  assert.equal(j?.readiness, undefined, 'no verdict is recorded for a withdrawn request');
  runIds.add(j!.runId);
});

test('not ready: one note with Loop on; Loop off is silent and keeps the journal; Loop back posts no second note', async () => {
  reset([L, T], 'opened');
  world.mrs = [];                                // rfd-order and mr-not-merged
  const first = await advanceTicket(await readIssue(), opts);
  assert.match(first.did, /^not ready \([0-9a-f]{12}: rfd-order, mr-not-merged\) — commented$/);
  assert.equal(writesTo('/notes', 'POST'), 1);
  const before = journalText();
  runIds.add(J.readAutoJournal(IID)!.runId);

  // Off, with the other reasons still standing: loop-missing alone decides — no note for them either.
  world.issue.labels = [T];
  world.issue.updated_at = '2026-09-28T11:00:00Z';
  const off = await advanceTicket(await readIssue(), opts);
  assert.equal(off.did, `"${L}" is not on the ticket — stopped`);
  assert.equal(world.writes.length, 1, 'still only the first note');
  assert.equal(journalText(), before, 'the journal is kept byte for byte');

  world.issue.labels = [T, L];
  world.issue.updated_at = '2026-09-28T12:00:00Z';
  const back = await advanceTicket(await readIssue(), opts);
  assert.match(back.did, /— already commented$/);
  assert.equal(world.writes.length, 1, 'the same facts are not commented on twice');
});

test('approved, but Loop taken off before the sheet step: silent stop, labels untouched, still approved', async () => {
  reset([T, R]);
  approvedJournal();
  const before = journalText();
  const o = await advanceTicket({ ...(await readIssue()), labels: [L, T, R] }, opts);
  assert.equal(o.did, `"${L}" is not on the ticket — stopped`);
  assert.deepEqual(world.writes, []);
  assert.equal(journalText(), before);
});

// ------------------------------------------------------------------ a lost journal

test('the highest posted version is found behind 149 newer notes, where the newest-hundred window shows none', async () => {
  reset([L, T]);
  const note = (body: string): Note => ({
    id: world.nextNote++, body, system: false, author: { username: 'desk' }, created_at: '2026-09-28T10:00:00Z',
  });
  world.notes = [note('**Automation test cases: v3**\n\n<!-- oneshot:automation:cases:v3:0123456789ab -->')];
  for (let i = 0; i < 149; i++) world.notes.push(note(`comment ${i}`));

  const windowed = await issueNotes(IID);
  assert.equal(windowed.data?.some((n) => n.body.includes('oneshot:automation:cases:')), false,
    'issueNotes alone would number the fresh list v1');
  const r = await highestVersionOnTicket(IID);
  assert.equal(r.ok, true);
  assert.equal(r.data, 3, 'the fresh list is v4');
});

// ------------------------------------------------------------------ pause

test('paused while the session ran: the version comment waits, then posts once when the pause lifts', async () => {
  reset([L, T]);
  unpostedVersionJournal();
  const before = journalText();
  const held = await advanceTicket(await readIssue(), { ...opts, paused: () => true });
  assert.equal(held.did, 'hold — paused (state/PAUSE)');
  assert.equal(world.writes.length, 0, `no comment, no upload, no label: ${JSON.stringify(world.writes)}`);
  assert.equal(journalText(), before);

  const on = await advanceTicket(await readIssue(), opts);
  assert.equal(on.did, 'v1 waiting on QA');
  assert.equal(writesTo('/notes', 'POST'), 1);
});

test('paused with an approved list: no label edit and no done note until the pause lifts', async () => {
  reset([L, T, R]);
  approvedJournal();
  const before = journalText();
  const held = await advanceTicket(await readIssue(), { ...opts, paused: () => true });
  assert.equal(held.did, 'hold — paused (state/PAUSE)');
  assert.equal(world.writes.length, 0, JSON.stringify(world.writes));
  assert.equal(journalText(), before);

  const done = await advanceTicket(await readIssue(), opts);
  assert.equal(done.state, 'done');
  assert.equal(world.writes.filter((w) => w.method === 'PUT').length, 1);
  assert.equal(writesTo('/notes', 'POST'), 1);
});

// ------------------------------------------------------------------ finishing

test('finishing: one label edit takes the review label AND Loop off and puts Automation Done on, then the done note says so', async () => {
  reset([L, T, R]);
  approvedJournal();
  const o = await advanceTicket(await readIssue(), opts);
  assert.equal(o.state, 'done');
  const puts = world.writes.filter((w) => w.method === 'PUT');
  assert.deepEqual(puts.map((w) => w.body), [{ add_labels: DONE, remove_labels: `${R},${L}` }]);
  assert.deepEqual([...world.issue.labels].sort(), [DONE, T].sort(), 'one label in, one label out');
  const notes = world.writes.filter((w) => w.method === 'POST');
  assert.equal(notes.length, 1);
  assert.match(String(notes[0]!.body?.body), new RegExp(`Labels: removed \`${R}\` and \`${L}\`, added \`${DONE}\`\\.`));
  assert.equal(J.readAutoJournal(IID)?.state, 'done');
});

test('--automation still posts an owed done note on a ticket the finishing edit already took Loop off', async () => {
  reset([T, DONE]);
  approvedJournal({ labelsDone: true, donePostedAt: null });
  const o = await runAutomationOnce(IID, opts);
  assert.equal(o.state, 'done');
  assert.equal(writesTo('/notes', 'POST'), 1);
  assert.equal(world.writes.filter((w) => w.method === 'PUT').length, 0, 'the labels were already done');
});

// ------------------------------------------------------------------ writes after a session

test('Loop taken off while the session ran: the version comment and review label wait, then post once when it is back', async () => {
  reset([T]);                                    // off by the time the session returned
  unpostedVersionJournal();
  const before = journalText();
  const stale = { ...(await readIssue()), labels: [L, T] };  // the scan's copy, from before the session
  const off = await advanceTicket(stale, opts);
  assert.equal(off.did, `"${L}" is not on the ticket — stopped`);
  assert.equal(world.writes.length, 0, `no comment, no upload, no label: ${JSON.stringify(world.writes)}`);
  assert.equal(journalText(), before, 'v1 is kept, unposted, for when Loop is back');

  world.issue.labels = [L, T];
  const on = await advanceTicket(await readIssue(), opts);
  assert.equal(on.did, 'v1 waiting on QA');
  assert.equal(writesTo('/notes', 'POST'), 1, 'v1 is posted once');
  assert.match(String(world.writes.find((w) => w.url.endsWith('/notes'))?.body?.body), /oneshot:automation:cases:v1:/);
  assert.deepEqual(world.writes.filter((w) => w.method === 'PUT').map((w) => w.body), [{ add_labels: R }]);
});

test('a ticket reopened while its list was written gets the not-ready note, not the list; closed again, the list posts once', async () => {
  reset([L, T], 'opened');                       // reopened: no RFD before the trigger, so rule A fails
  unpostedVersionJournal();
  const o = await advanceTicket(await readIssue(), opts);
  assert.match(o.did, /^not ready \([0-9a-f]{12}: rfd-order\) — commented$/);
  const posted = world.writes.filter((w) => w.method === 'POST').map((w) => String(w.body?.body));
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /oneshot:automation:not-ready:/);
  assert.equal(posted.some((b) => /oneshot:automation:cases:/.test(b)), false, 'no list in front of QA');
  assert.equal(world.writes.filter((w) => w.method === 'PUT').length, 0, 'no review label either');
  const j = J.readAutoJournal(IID)!;
  assert.equal(j.state, 'not-ready');
  assert.equal(j.versions[0]?.postedAt, null, 'v1 is kept, unposted');

  world.issue.state = 'closed';
  world.issue.updated_at = '2026-09-28T13:00:00Z';
  const back = await advanceTicket(await readIssue(), opts);
  assert.equal(back.did, 'v1 waiting on QA');
  assert.equal(world.writes.filter((w) => w.url.endsWith('/notes') && /oneshot:automation:cases:v1:/.test(String(w.body?.body))).length, 1);
});

test('the review label waits too when Loop comes off between the comment and the label', async () => {
  reset([L, T]);
  unpostedVersionJournal();
  const j = J.readAutoJournal(IID)!;
  j.versions[0]!.postedAt = Date.now();
  j.versions[0]!.noteId = 1234;
  J.writeAutoJournal(j);
  const stale = await readIssue();
  world.issue.labels = [T];
  const o = await advanceTicket(stale, opts);
  assert.equal(o.did, `"${L}" is not on the ticket — stopped`);
  assert.deepEqual(world.writes, []);
  assert.equal(J.readAutoJournal(IID)?.versions[0]?.reviewLabelled, false);
});

test('a stuck ticket whose Loop came off gets no stuck note until Loop is back', async () => {
  reset([T]);
  const j = J.newAutoJournal(IID, 'Profile preferences');
  Object.assign(j, {
    state: 'stuck', attempts: 2,
    stuck: { at: Date.now(), reason: 'the session ended without returning a list', fp: 'abcdef012345', notePostedAt: null, sinceNoteId: null },
  });
  save(j);
  const off = await advanceTicket({ ...(await readIssue()), labels: [L, T] }, opts);
  assert.equal(off.did, `stuck — "${L}" is not on the ticket — stopped`);
  assert.equal(world.writes.length, 0, JSON.stringify(world.writes));

  world.issue.labels = [L, T];
  const on = await advanceTicket(await readIssue(), opts);
  assert.equal(on.did, 'stuck — waiting for a QA approver to comment');
  assert.equal(writesTo('/notes', 'POST'), 1);
});
