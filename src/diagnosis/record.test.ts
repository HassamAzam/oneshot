import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock, diagnosisPath, latestDiagnosis, readDiagnosisFile, releaseLock, updateDiagnosisFile, writeDiagnosisFile,
} from './record.js';
import type { DiagnosisFile, StopDiagnosis } from './types.js';

const scratch = (): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'oneshot-record-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
const stop = (key: string, state: StopDiagnosis['state'] = 'diagnosed'): StopDiagnosis => ({
  key, runId: 'r-1', iid: 7, status: 'blocked', stoppedPhase: 'merge', reason: '', trouble: [], state, attempts: 1, lastAttemptAt: 1,
});
const RUN = { iid: 7, runId: 'r-1' };

test('an update changes the record as it is on disk, so two writers of different entries both survive', () => {
  const s = scratch();
  try {
    const mine = updateDiagnosisFile(s.dir, RUN, (f) => { f.stops.a = stop('a'); f.sessions += 1; });
    assert.equal(mine.sessions, 1);
    // A second writer, which never saw `mine`:
    updateDiagnosisFile(s.dir, RUN, (f) => { f.stops.b = stop('b'); f.latest = 'b'; });
    // The first writes again, from its own idea of the world: only its entry.
    updateDiagnosisFile(s.dir, RUN, (f) => { f.stops.a = { ...stop('a'), headline: 'done' }; });
    const f = readDiagnosisFile(s.dir)!;
    assert.deepEqual(Object.keys(f.stops).sort(), ['a', 'b']);
    assert.equal(f.latest, 'b');
    assert.equal(f.stops.a!.headline, 'done');
    assert.deepEqual(readdirSync(s.dir), ['diagnosis.json'], 'the temporary file it was written through is gone');
  } finally { s.cleanup(); }
});

test('a record left by another run of the ticket is started afresh, and a corrupt one reads as none', () => {
  const s = scratch();
  try {
    writeDiagnosisFile(s.dir, { version: 1, iid: 7, runId: 'r-old', latest: 'x', sessions: 3, stops: { x: stop('x') } });
    const f = updateDiagnosisFile(s.dir, RUN, (file) => { file.stops.a = stop('a'); });
    assert.deepEqual({ runId: f.runId, sessions: f.sessions, keys: Object.keys(f.stops) }, { runId: 'r-1', sessions: 0, keys: ['a'] });
    writeFileSync(diagnosisPath(s.dir), '{"version":1,"stops":');
    assert.equal(readDiagnosisFile(s.dir), null);
    writeFileSync(diagnosisPath(s.dir), '[]');
    assert.equal(readDiagnosisFile(s.dir), null);
  } finally { s.cleanup(); }
});

test('the latest diagnosis is the newest stop that has one, for the run asked about', () => {
  const file: DiagnosisFile = { version: 1, iid: 7, runId: 'r-1', latest: 'a', sessions: 1, stops: { a: stop('a'), b: stop('b', 'failed') } };
  assert.equal(latestDiagnosis(file)?.key, 'a');
  assert.equal(latestDiagnosis(file, 'r-1')?.key, 'a');
  assert.equal(latestDiagnosis(file, 'r-2'), null, 'another run of the same ticket');
  assert.equal(latestDiagnosis({ ...file, latest: 'b' }), null, 'a stop whose sessions all failed has nothing to show');
  assert.equal(latestDiagnosis({ ...file, latest: null }), null);
  assert.equal(latestDiagnosis(null), null);
});

test('a lock is taken once, refused while held, and taken over only when it is stale', () => {
  const s = scratch();
  try {
    const lock = join(s.dir, 'diagnosis', '.lock-k');
    assert.equal(acquireLock(lock, 60_000), true, 'and its directory is made');
    assert.equal(acquireLock(lock, 60_000), false);
    releaseLock(lock);
    assert.equal(existsSync(lock), false);
    assert.equal(acquireLock(lock, 60_000), true);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    assert.equal(acquireLock(lock, 60_000), true, 'a process that died holding it does not hold it for ever');
    releaseLock(lock);
    releaseLock(lock);
  } finally { s.cleanup(); }
});

// ----------------------------------------- what the adversarial pass found next

test('what is read back is in its declared shape or not there: a count is a number and a key is a key', () => {
  // The record sits in a run directory, where the run's own sessions work, and the
  // ticket note is rendered from it. Written as a session talked into it would.
  const s = scratch();
  try {
    const hostile = '3\n/unassign\n/close';
    writeFileSync(diagnosisPath(s.dir), JSON.stringify({
      version: 1, iid: 7, runId: 'r-1', latest: 'good', sessions: hostile,
      stops: {
        // Filed under one key, claiming to be another that closes the comment and starts a command.
        forged: { ...stop('forged'), key: 'forged -->\n/close\n<!-- x' },
        'bad key\n/close': stop('bad key\n/close'),
        nostate: { ...stop('nostate'), state: 'approved' },
        good: {
          ...stop('good'), attempts: hostile, turns: hostile, citations: { checked: hostile, verified: hostile }, read: { transcripts: hostile, transcriptBytes: 1 },
          note: { id: hostile, postedAt: hostile }, headline: 7,
          findings: [
            { id: 'D-1 -->\n/close', title: 't', category: 'cosmic', fix: 'prayer', confidence: 'certain', evidenced: true, fixedBy: 'not a sha', evidence: [{ file: 'run.json', line: hostile, quote: 'q', ok: 'yes' }], where: 'everywhere' },
            'not a finding',
          ],
          fixes: { 'D-1': { state: 'opened', prUrl: 'https://github.com/o/r/pull/1', at: 1, review: { raised: hostile, upheld: 1, refuted: 0, fixed: 0, rounds: 0 } }, 'D-1\n/close': { state: 'opened', at: 1 }, 'D-2': { state: 'merged', at: 1 } },
        },
      },
    }));
    const f = readDiagnosisFile(s.dir)!;
    assert.deepEqual(Object.keys(f.stops), ['good'], 'a stop that is not filed under its own key, or has no real state, is not a stop');
    assert.equal(f.sessions, 0);
    const g = f.stops.good!;
    assert.deepEqual({ attempts: g.attempts, turns: g.turns, citations: g.citations, read: g.read, note: g.note, headline: g.headline },
      { attempts: 0, turns: undefined, citations: { checked: 0, verified: 0 }, read: { transcripts: 0, transcriptBytes: 1 }, note: { id: null, postedAt: 0 }, headline: undefined });
    assert.equal(g.findings!.length, 1);
    const d = g.findings![0]!;
    assert.deepEqual({ id: d.id, category: d.category, fix: d.fix, confidence: d.confidence, fixedBy: d.fixedBy, where: d.where, line: d.evidence[0]!.line, ok: d.evidence[0]!.ok },
      { id: 'D-1', category: 'environment', fix: 'person', confidence: 'probable', fixedBy: '', where: [], line: 1, ok: false });
    assert.equal(d.evidenced, false, 'a finding is evidenced by its citations, whatever it says of itself');
    assert.deepEqual(Object.keys(g.fixes!), ['D-1']);
    assert.equal(g.fixes!['D-1']!.review!.raised, 0);
  } finally { s.cleanup(); }
});

test('a record written by this code reads back as it was written', () => {
  const s = scratch();
  try {
    const full: StopDiagnosis = {
      ...stop('abc123def456'), free: 1, diagnosedAt: 5, model: 'm', turns: 34, weighted: 500, headline: 'h', account: 'a', decisive: 'D-1', nextStep: 'n', resumeFrom: 'implement',
      citations: { checked: 2, verified: 1 }, read: { transcripts: 25, transcriptBytes: 9 }, note: { id: 501, postedAt: 6 }, noteTries: 2,
      findings: [{ id: 'D-1', title: 't', category: 'harness', phases: 'p', recorded: 'r', cause: 'c', solution: 's', where: ['src/x.ts'], fix: 'pr', confidence: 'confirmed', fixedBy: 'f915c43', evidenced: true,
        evidence: [{ file: 'repo:src/x.ts', line: 3, quote: 'q', ok: true, note: '' }] }],
      fixes: { 'D-1': { state: 'opened', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, branch: 'fix/x', at: 7, checks: { typecheck: 'clean', tests: '1 pass', hooks: '', redGreen: '1 failing' }, review: { raised: 1, upheld: 1, refuted: 0, fixed: 1, rounds: 1 }, note: { id: 9, postedAt: 8 } } },
    };
    const file: DiagnosisFile = { version: 1, iid: 7, runId: 'r-1', latest: 'abc123def456', sessions: 3, stops: { abc123def456: full } };
    writeDiagnosisFile(s.dir, file);
    assert.deepEqual(readDiagnosisFile(s.dir), file);
  } finally { s.cleanup(); }
});
