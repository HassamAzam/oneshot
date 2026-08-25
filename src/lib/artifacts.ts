/**
 * The run journal: `state/runs/<iid>/`.
 *
 * This is the handoff medium between phases and the reason runs are replayable.
 * A phase receives the ARTIFACTS of earlier phases — never their transcripts —
 * so context grows in kilobytes rather than conversation turns, and re-entering
 * a run at phase 11 costs nothing for phases 0-10.
 *
 * Layout:
 *   state/runs/<iid>/run.json         the journal (phases, laps, outcomes)
 *   state/runs/<iid>/<phase>.json     one phase's structured output
 *   state/runs/<iid>/artifacts/       screenshots, mp4, reports
 *   state/runs/<iid>/transcripts/     per-phase JSONL — the content record
 *   state/runs/<iid>/scratch/         reaped on teardown
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactDir, runDir } from './config.js';

export interface PhaseRecord {
  phase: string;
  lap: number;
  status: 'ok' | 'failed' | 'skipped' | 'refused' | 'warned';
  startedAt: number;
  endedAt: number;
  model?: string;
  turns?: number;
  weighted?: number;
  sessionId?: string;
  error?: string;
}

export interface RunJournal {
  runId: string;
  iid: number;
  title: string;
  url: string;
  createdAt: number;
  status: 'running' | 'blocked' | 'done' | 'aborted';
  branch?: string;
  worktree?: string;
  port?: number;
  mrIid?: number;
  mrUrl?: string;
  mergedSha?: string;
  deployedSha?: string;
  blockedWhy?: string;
  slackTs?: string;
  phases: PhaseRecord[];
}

function journalPath(iid: number): string {
  return join(runDir(iid), 'run.json');
}

export function ensureRunDirs(iid: number): void {
  for (const d of ['', 'artifacts', 'transcripts', 'scratch']) {
    mkdirSync(d ? join(runDir(iid), d) : runDir(iid), { recursive: true });
  }
}

export function readJournal(iid: number): RunJournal | null {
  const p = journalPath(iid);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RunJournal;
  } catch {
    return null;
  }
}

export function writeJournal(j: RunJournal): void {
  ensureRunDirs(j.iid);
  writeFileSync(journalPath(j.iid), `${JSON.stringify(j, null, 2)}\n`);
}

export function updateJournal(iid: number, patch: Partial<RunJournal>): RunJournal | null {
  const j = readJournal(iid);
  if (!j) return null;
  Object.assign(j, patch);
  writeJournal(j);
  return j;
}

export function recordPhase(iid: number, rec: PhaseRecord): void {
  const j = readJournal(iid);
  if (!j) return;
  j.phases.push(rec);
  writeJournal(j);
}

/** How many times a phase has already run in this run — the lap counter. */
export function lapsOf(iid: number, phase: string): number {
  const j = readJournal(iid);
  if (!j) return 0;
  return j.phases.filter((p) => p.phase === phase).length;
}

/** True if the phase completed successfully at any lap — the resume check. */
export function phaseSucceeded(iid: number, phase: string): boolean {
  const j = readJournal(iid);
  if (!j) return false;
  return j.phases.some((p) => p.phase === phase && (p.status === 'ok' || p.status === 'warned'));
}

// ------------------------------------------------------------------ artifacts

export function artifactPath(iid: number, name: string): string {
  return join(runDir(iid), name);
}

export function writeArtifact(iid: number, name: string, data: unknown): string {
  ensureRunDirs(iid);
  const p = artifactPath(iid, name);
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  return p;
}

export function readArtifact<T = unknown>(iid: number, name: string): T | null {
  const p = artifactPath(iid, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function transcriptPath(iid: number, phase: string, lap: number): string {
  ensureRunDirs(iid);
  return join(runDir(iid), 'transcripts', `${phase}-lap${lap}.jsonl`);
}

export function artifactsDirFor(iid: number): string {
  ensureRunDirs(iid);
  return artifactDir(iid);
}

/**
 * Teardown. Removes only what is regenerable.
 *
 * Deliberately KEPT: the journal (what happened), phase artifacts (the
 * decisions), transcripts (the content record), and artifacts/ (screenshots,
 * video). Those are the run's value; scratch is not.
 */
export function reapScratch(iid: number): void {
  try {
    rmSync(join(runDir(iid), 'scratch'), { recursive: true, force: true });
  } catch { /* already gone */ }
}
