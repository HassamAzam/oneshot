/**
 * The sweep, with label history injected rather than fetched.
 *
 * The three failures worth pinning are all about what the sweep DOESN'T see:
 * an archived journal it forgot to look for, a ticket it could not read, and a
 * live run that has not shipped. Each of them, left wrong, reports a cleaner
 * record than the truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DRY_RUN = '1';
const { collectEscapes, escapeLine, shippedRuns } = await import('./escapecollect.js');
const { writeJournal } = await import('./artifacts.js');
const { runDir, STATE } = await import('./config.js');
const { readArtifact } = await import('./artifacts.js');
const { currentProjectKey } = await import('./journalproject.js');

/**
 * iids only mean anything within a project, so the sweep only takes journals
 * belonging to the configured one. Fixtures must say which project they are
 * for, exactly as a real journal does.
 */
const OURS = currentProjectKey();
type Row = Awaited<ReturnType<typeof collectEscapes>>[number];

const ARCHIVE = join(STATE, 'runs-archive');
const made: string[] = [];

function live(iid: number, over: Record<string, unknown> = {}): void {
  writeJournal({
    runId: `r-${iid}`, iid, title: 't', url: 'u', createdAt: 1, status: 'done',
    phases: [], project: OURS, ...over,
  } as never);
  made.push(runDir(iid));
}

function archived(iid: number, over: Record<string, unknown> = {}): void {
  const dir = join(ARCHIVE, `${iid}-r-${iid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    runId: `r-${iid}`, iid, title: 't', url: 'u', createdAt: 1, status: 'done',
    phases: [], project: OURS, ...over,
  }));
  made.push(dir);
}

const ev = (iso: string, action: 'add' | 'remove', label: string) =>
  ({ at: Date.parse(iso), action, label, by: 'anosha.saeed' });

/** erp#8781's shape: merged, flagged, signed off. */
const ESCAPED = [
  ev('2026-10-13T15:16Z', 'add', 'Merged'),
  ev('2026-10-15T17:14Z', 'add', 'QA Issues'),
  ev('2026-10-15T21:58Z', 'add', 'Ready For Deployment'),
];
const CLEAN = [
  ev('2026-10-12T14:26Z', 'add', 'Merged'),
  ev('2026-10-13T06:15Z', 'add', 'Ready For Deployment'),
];

process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('an ARCHIVED shipped run is swept, not missed', async () => {
  live(99101, { mergedSha: 'aaa111', oneshotSha: 'sha-live' });
  archived(99102, { mergedSha: 'bbb222', oneshotSha: 'sha-arch' });
  // A delivered run is moved out of state/runs on the next claim, so by the
  // time QA has finished the journal is usually only in the archive. Sweeping
  // the live dir alone would measure none of the settled tickets.
  const ids = shippedRuns().map((r) => r.iid);
  assert.ok(ids.includes(99101), 'live run missing');
  assert.ok(ids.includes(99102), 'archived run missing');

  const rows = await collectEscapes(
    async (iid) => ({ ok: true, events: iid === 99101 ? ESCAPED : CLEAN }),
    { only: [99101, 99102] },
  );
  const by = new Map(rows.map((r) => [r.iid, r]));
  assert.equal(by.get(99101)!.record!.verdict, 'escaped');
  assert.equal(by.get(99102)!.record!.verdict, 'clean');
});

test('a run that never merged is not in the cohort at all', () => {
  live(99103);
  assert.equal(shippedRuns().some((r) => r.iid === 99103), false);
});

test('a ticket whose history cannot be read is an error, never a clean', async () => {
  live(99104, { mergedSha: 'ccc333' });
  const rows = await collectEscapes(
    async () => ({ ok: false, error: 'HTTP 403 RBAC: access denied' }),
    { only: [99104] },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.record, null);
  assert.match(rows[0]!.error!, /403/);
  // The line a reader sees must not resemble a verdict.
  assert.match(escapeLine(rows[0]!), /UNREADABLE/);
});

test('the sweep persists a record beside a live run but never into the archive', async () => {
  live(99105, { mergedSha: 'ddd444', oneshotSha: 'sha-x' });
  archived(99106, { mergedSha: 'eee555' });
  await collectEscapes(async () => ({ ok: true, events: ESCAPED }), { only: [99105, 99106] });

  const written = readArtifact<{ verdict: string; oneshotSha: string }>(99105, 'escapes.json');
  assert.equal(written?.verdict, 'escaped');
  assert.equal(written?.oneshotSha, 'sha-x');
  // The archive is the baseline; it stays immutable or it is not trustworthy.
  const inArchive = join(ARCHIVE, '99106-r-99106', 'escapes.json');
  assert.equal(readArtifact(99106, 'escapes.json'), null);
  assert.equal(existsSync(inArchive), false);
});

test('the reported sha is the version that shipped it, or an explicit unknown', async () => {
  live(99107, { mergedSha: 'fff666' });
  const [row] = await collectEscapes(async () => ({ ok: true, events: CLEAN }), { only: [99107] });
  // Absent on runs from before the stamp existed. 'unknown' rather than blank so
  // a reader cannot mistake it for a version.
  assert.match(escapeLine(row as Row), /by=unknown/);
});

/**
 * The bug this caught when the command was first run: two workstreamai runs on
 * a desk configured for erp came back 404 and sat in the output as permanent
 * UNREADABLE rows, holding the exit code at failure. They are not unreadable —
 * they are another project's, and an iid means nothing across projects.
 */
test("another project's shipped run is excluded, not reported unreadable", async () => {
  live(99108, { mergedSha: 'ggg777', project: 'gitlab.example.com/other/repo' });
  assert.equal(shippedRuns().some((r) => r.iid === 99108), false);

  let asked = 0;
  const rows = await collectEscapes(async () => { asked += 1; return { ok: true, events: CLEAN }; });
  assert.equal(rows.some((r) => r.iid === 99108), false);
  assert.equal(asked, rows.length, 'GitLab was asked about a ticket outside the cohort');
});

test('with no project configured the sweep takes nothing rather than guessing', async () => {
  live(99109, { mergedSha: 'hhh888', project: undefined, url: '' });
  // A journal with neither a project nor a resolvable url cannot be proven ours.
  assert.equal(shippedRuns().some((r) => r.iid === 99109), false);
});
