/**
 * Where a phase writes: every path is the Loop's own, under the ticket's run
 * directory, which is what a Loop run, its resume check and the board
 * collector read.
 *
 * Fixture iid 990201, in the reserved band; the Loop's transcriptPath creates
 * state/runs/990201, which is removed afterwards.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY, artifactDir, runDir, type PhaseConfig } from '../lib/config.js';
import { artifactPath, transcriptPath } from '../lib/artifacts.js';
import { phasePaths } from './phase.js';

const LOOP_IID = 990201;
const scratch = mkdtempSync(join(tmpdir(), 'phase-paths-'));

after(() => {
  rmSync(runDir(LOOP_IID), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const cfg: PhaseConfig = {
  name: 'fixture-phase', n: 99, kind: 'session', timeoutMin: 1, onFail: 'warn',
  writes: ['run', 'artifacts', 'memory', 'worktree'],
};
const worktree = join(scratch, 'wt');

test('every path is the Loop\'s, under the ticket\'s run directory', () => {
  const p = phasePaths(cfg, LOOP_IID, 2, { worktree });
  assert.deepEqual(p.scopes, [runDir(LOOP_IID), artifactDir(LOOP_IID), MEMORY, worktree]);
  assert.equal(p.transcript, transcriptPath(LOOP_IID, 'fixture-phase', 2));
  assert.equal(p.transcript, join(runDir(LOOP_IID), 'transcripts', 'fixture-phase-lap2.jsonl'));
  assert.equal(p.artifact, artifactPath(LOOP_IID, 'fixture-phase.json'));
  assert.equal(phasePaths({ ...cfg, artifact: 'named.json' }, LOOP_IID, 0, {}).artifact, join(runDir(LOOP_IID), 'named.json'));
  // No worktree: the scope is dropped, as it always was.
  assert.deepEqual(phasePaths(cfg, LOOP_IID, 0, {}).scopes, [runDir(LOOP_IID), artifactDir(LOOP_IID), MEMORY]);
});
