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
