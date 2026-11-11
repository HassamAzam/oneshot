/**
 * `state/runs/<iid>/diagnosis.json`: where a run's diagnoses are kept.
 *
 * Its own file, beside the journal and never inside it. The runner holds the
 * journal in memory for as long as it drives a run and writes it back whole, so
 * a second writer of `run.json` would have one side's change lost. A parked run
 * is re-claimed every tick, which makes that a certainty, not a risk.
 *
 * This file has the same hazard on a smaller scale, and is written so that it
 * does not bite. Several things write it: the conductor's diagnosis pass, a
 * second conductor on the same desk, `npm run diagnose` by hand, and the fix
 * pipeline, which runs for an hour. So nothing writes back a copy it has been
 * holding. `updateDiagnosisFile` re-reads, changes the one entry the caller
 * owns and replaces the file in one rename; and a lock file, created
 * exclusively, is what stops two processes paying for the same session.
 *
 * This module imports nothing but the type and the filesystem, on purpose: the
 * dashboard reads the record too, and it must never import src/lib/db.ts, which
 * opens the database read-write on import.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DiagnosisFile, StopDiagnosis } from './types.js';

export function diagnosisPath(dir: string): string { return join(dir, 'diagnosis.json'); }

export function readDiagnosisFile(dir: string): DiagnosisFile | null {
  try {
    const f = JSON.parse(readFileSync(diagnosisPath(dir), 'utf8')) as DiagnosisFile;
    return f && typeof f === 'object' && f.stops && typeof f.stops === 'object' ? f : null;
  } catch {
    return null;
  }
}

/** Replace the file in one step, so a reader never sees half of it. */
export function writeDiagnosisFile(dir: string, file: DiagnosisFile): void {
  const path = diagnosisPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Change the record as it is on disk NOW.
 *
 * A record belonging to another run of the same ticket is not this run's: it is
 * started afresh, as the run directory itself would have been.
 */
export function updateDiagnosisFile(
  dir: string, run: { iid: number; runId: string }, mutate: (file: DiagnosisFile) => void,
): DiagnosisFile {
  let file = readDiagnosisFile(dir);
  if (!file || file.runId !== run.runId) file = { version: 1, iid: run.iid, runId: run.runId, latest: null, sessions: 0, stops: {} };
  mutate(file);
  writeDiagnosisFile(dir, file);
  return file;
}

/** The newest stop that has a diagnosis to show, or null. */
export function latestDiagnosis(file: DiagnosisFile | null, runId?: string): StopDiagnosis | null {
  if (!file || (runId && file.runId !== runId)) return null;
  const stop = file.latest ? file.stops[file.latest] : undefined;
  return stop && stop.state !== 'failed' ? stop : null;
}

/**
 * Take a lock by creating its file, which fails if the file is there.
 *
 * A desk can run several conductors over one state directory, and each makes
 * its own pass. Without this, two of them looking at one blocked run in the
 * same minute would each start a session for it. A lock older than `staleMs` is
 * a process that died holding it, and is taken over.
 */
export function acquireLock(path: string, staleMs: number): boolean {
  try { mkdirSync(dirname(path), { recursive: true }); } catch { return false; }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(path).mtimeMs < staleMs) return false;
        rmSync(path, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* already gone */ }
}
