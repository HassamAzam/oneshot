/**
 * Where a phase writes. Without `stateDir` every path must be exactly the
 * Loop's — this is the check that adding the Ready For Automation mode moved
 * nothing a Loop run, its resume check or the board collector reads. With it,
 * everything lands under the given directory and no Loop run directory is
 * created as a side effect.
 *
 * Fixture iids 990201/990202, in the reserved band; the Loop's transcriptPath
 * creates state/runs/990201, which is removed afterwards.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY, artifactDir, runDir, type PhaseConfig } from '../lib/config.js';
import { artifactPath, transcriptPath } from '../lib/artifacts.js';
import { phasePaths } from './phase.js';

const LOOP_IID = 990201;
const AUTO_IID = 990202;
const scratch = mkdtempSync(join(tmpdir(), 'phase-paths-'));

after(() => {
  rmSync(runDir(LOOP_IID), { recursive: true, force: true });
  rmSync(runDir(AUTO_IID), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const cfg: PhaseConfig = {
  name: 'fixture-phase', n: 99, kind: 'session', timeoutMin: 1, onFail: 'warn',
  writes: ['run', 'artifacts', 'memory', 'worktree'],
};
const worktree = join(scratch, 'wt');

test('without stateDir every path is the Loop\'s, unchanged', () => {
  const p = phasePaths(cfg, LOOP_IID, 2, { worktree });
  assert.deepEqual(p.scopes, [runDir(LOOP_IID), artifactDir(LOOP_IID), MEMORY, worktree]);
  assert.equal(p.transcript, transcriptPath(LOOP_IID, 'fixture-phase', 2));
  assert.equal(p.transcript, join(runDir(LOOP_IID), 'transcripts', 'fixture-phase-lap2.jsonl'));
  assert.equal(p.artifact, artifactPath(LOOP_IID, 'fixture-phase.json'));
  assert.equal(phasePaths({ ...cfg, artifact: 'named.json' }, LOOP_IID, 0, {}).artifact, join(runDir(LOOP_IID), 'named.json'));
  // No worktree: the scope is dropped, as it always was.
  assert.deepEqual(phasePaths(cfg, LOOP_IID, 0, {}).scopes, [runDir(LOOP_IID), artifactDir(LOOP_IID), MEMORY]);
});

test('with stateDir the transcript, artifact and scopes live under it, and nothing is created under runs/<iid>', () => {
  rmSync(runDir(AUTO_IID), { recursive: true, force: true });
  const dir = join(scratch, 'automation', String(AUTO_IID));
  const p = phasePaths({ ...cfg, artifact: 'automation-testcases.json' }, AUTO_IID, 3, { worktree, stateDir: dir });
  assert.deepEqual(p.scopes, [dir, join(dir, 'artifacts'), MEMORY, worktree]);
  assert.equal(p.transcript, join(dir, 'transcripts', 'fixture-phase-lap3.jsonl'));
  assert.ok(statSync(join(dir, 'transcripts')).isDirectory(), 'the transcript directory exists before the first frame');
  assert.equal(p.artifact, join(dir, 'automation-testcases.json'));
  assert.equal(existsSync(runDir(AUTO_IID)), false);
});
