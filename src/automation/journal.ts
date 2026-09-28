/**
 * The Ready For Automation mode's own state: `STATE/automation/<iid>/`.
 *
 * Deliberately NOT the Loop's run journal (state/runs/<iid>, lib/artifacts.ts).
 * The Loop keys everything by iid — its journal, its resume check, its board
 * collector, `npm run unblock` — and a ticket can sit in the Loop and in this
 * mode at the same time. Sharing the directory would let either one resume,
 * archive or report on the other's history. Nothing here is written under
 * RUNS, and runPhase is given this directory as `stateDir` so the session's
 * transcript and artifact land here too.
 *
 * Layout:
 *   STATE/automation/<iid>/journal.json      the state machine's record (this file's type)
 *   STATE/automation/<iid>/cases-v<N>.json   each version exactly as it was posted
 *   STATE/automation/<iid>/transcripts/      per-session JSONL (written by runPhase)
 *   STATE/automation/<iid>/lock              who is advancing this ticket right now
 *
 * The journal is the local source of truth and is written atomically (a temp
 * file, then rename) after every transition, so a crash leaves either the old
 * record or the new one, never half of one. Every GitLab write the runner makes
 * is also marker-checked before it is made, which covers the one gap atomic
 * writes cannot: a crash between the write and the journal update.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { STATE } from '../lib/config.js';
import { currentProjectKey } from '../lib/journalproject.js';
import type { MrRef } from './readiness.js';
import type { SheetWriteResult, SheetsFail } from './sheets.js';
import type { AutomationArtifact } from './types.js';

export type AutomationState = 'new' | 'not-ready' | 'authoring' | 'in-review' | 'approved' | 'stuck' | 'done';

export interface VersionRecord {
  v: number;
  module: string;
  count: number;
  hash: string;
  /** The cases note's id. null until posted, and for good in DRY_RUN (addIssueNote returns no note). */
  noteId: number | null;
  /** "Posted" means THIS is set, never noteId: a dry-run post has a time and no id. */
  postedAt: number | null;
  reviewLabelled: boolean;
  changes: string[];
  /**
   * What the note needs that is only known when the version is written: the
   * sheet tab the cases will go to (from the module list the session was
   * shown), and the round this version answers. Saved beside the version so
   * posting it later — after a crash, or once GitLab is back — renders the
   * same note without asking the sheet again.
   */
  moduleTab?: string;
  moduleTabIsNew?: boolean;
  feedbackAuthors?: string[];
  ignoredApproval?: boolean;
  /** Written fresh because the journal was lost while GitLab still had earlier versions. */
  lostHistory?: boolean;
}

export interface AutomationJournal {
  v: 1; iid: number; runId: string; project: string | null; title: string;
  state: AutomationState; createdAt: number; updatedAt: number;
  readiness?: { verdict: 'ready' | 'not-ready'; at: number; issueUpdatedAt: string | null; fingerprint: string | null; merged: MrRef[]; open: MrRef[] };
  /** Fingerprints whose not-ready note is on the ticket (posted or adopted). */
  notReadyPosted: string[];
  /** Charged authoring failures since the last version was saved (or since `stuck` was released). */
  attempts: number;
  /** Sessions started, ever. Also the next session's lap number, so no transcript is appended to. */
  sessions: number;
  /** Uncharged session failures in a row (hook block + ready re-check, zero-frame death). 3 → one attempt charged + alert. §1.3 */
  freeRetries: number;
  /**
   * sinceNoteId = the highest note id on the ticket when it entered `stuck` (from issueNotes),
   * NEVER the stuck note's own id (null in DRY_RUN or when the post failed, and `id > null` is
   * true for every note). null → the stuck-poll step reads it first and releases nothing that pass.
   */
  stuck?: { at: number; reason: string; fp: string; notePostedAt: number | null; sinceNoteId: number | null };
  versions: VersionRecord[];
  /**
   * The highest note id the tally has CONSUMED: the v1 note, then each feedback round (its max id).
   * It is NOT moved to later version notes, nor to oneshot's own no-change replies, so a comment
   * posted while a REVISE session runs (id between the consumed feedback and the new note) is still
   * read. Those notes are machine notes, which the tally skips anyway. Unchanged when the note id
   * is null (DRY_RUN).
   */
  watermark: number;
  pendingFeedback?: { afterVersion: number; notes: Array<{ id: number; author: string; body: string }>; ignoredApproval: boolean };
  feedbackRounds: Array<{ afterVersion: number; noteIds: number[]; authors: string[] }>;
  /** `at` = the approving note's created_at (ISO), so the tracker year is when QA approved, not when the conductor noticed. DRY_RUN: { by: 'dry-run', noteId: 0, at: now }. */
  approval?: { version: number; by: string; noteId: number; at: string };
  sheet?: SheetWriteResult;
  /** Current sheet failure streak. `noted` = kinds already reported on the ticket (§5.7). Cleared on success. */
  sheetFailure?: { kind: SheetsFail; since: number; noted: string[] };
  labelsDone?: boolean;
  doneNoteId?: number | null;
  donePostedAt?: number | null;
  /**
   * alert() keys already sent for this journal ('stuck', 'free-retries',
   * 'sheet:<kind>'). The alerts are "once per journal", and a process restart
   * must not repeat them, so the record lives here rather than in memory.
   */
  alerted?: string[];
}

/** A lock older than this is taken over whatever its pid says: the longest session is 30 minutes. */
const LOCK_STALE_MS = 3 * 60 * 60_000;

export function automationHome(): string {
  return join(STATE, 'automation');
}

export function automationDir(iid: number): string {
  return join(automationHome(), String(iid));
}

function journalFile(iid: number): string {
  return join(automationDir(iid), 'journal.json');
}

function versionFile(iid: number, v: number): string {
  return join(automationDir(iid), `cases-v${v}.json`);
}

/** Write through a temp file and rename, so a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function isJournal(v: unknown, iid?: number): v is AutomationJournal {
  if (!v || typeof v !== 'object') return false;
  const j = v as Record<string, unknown>;
  return j.v === 1 && typeof j.iid === 'number' && (iid === undefined || j.iid === iid)
    && typeof j.runId === 'string' && typeof j.state === 'string' && Array.isArray(j.versions);
}

/**
 * The journal, or null when there is none or it cannot be read. An unreadable
 * journal is treated as absent: the ticket starts fresh, and the marker checks
 * stop that from re-posting anything GitLab already has.
 */
export function readAutoJournal(iid: number): AutomationJournal | null {
  const p = journalFile(iid);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!isJournal(j, iid)) return null;
    // Fields added after a journal was first written read as their defaults.
    j.notReadyPosted ??= [];
    j.feedbackRounds ??= [];
    j.attempts ??= 0;
    j.sessions ??= 0;
    j.freeRetries ??= 0;
    j.watermark ??= 0;
    return j;
  } catch {
    return null;
  }
}

/** mkdir -p, tmp + rename. Stamps `updatedAt`. */
export function writeAutoJournal(j: AutomationJournal): void {
  mkdirSync(automationDir(j.iid), { recursive: true });
  j.updatedAt = Date.now();
  writeAtomic(journalFile(j.iid), `${JSON.stringify(j, null, 2)}\n`);
}

/**
 * A fresh record in state `new`. The run id is `a-…` so its events and quota
 * rows can never be mistaken for a Loop run's `r-…`, and the project is
 * stamped for the same reason the Loop stamps its journals: an iid is unique
 * only within one project.
 */
export function newAutoJournal(iid: number, title: string): AutomationJournal {
  const now = Date.now();
  return {
    v: 1,
    iid,
    runId: `a-${now.toString(36)}-${randomBytes(3).toString('hex')}`,
    project: currentProjectKey(),
    title,
    state: 'new',
    createdAt: now,
    updatedAt: now,
    notReadyPosted: [],
    attempts: 0,
    sessions: 0,
    freeRetries: 0,
    versions: [],
    watermark: 0,
    feedbackRounds: [],
  };
}

/** Every readable STATE/automation/<iid>/journal.json. Used by the tick's done-note sweep (§1.3). */
export function listAutoJournals(): AutomationJournal[] {
  const home = automationHome();
  if (!existsSync(home)) return [];
  const out: AutomationJournal[] = [];
  for (const name of readdirSync(home)) {
    if (!/^\d+$/.test(name)) continue;
    const j = readAutoJournal(Number(name));
    if (j) out.push(j);
  }
  return out.sort((a, b) => a.iid - b.iid);
}

/**
 * → STATE/automation-archive/<iid>-<runId>. Moves every entry EXCEPT `lock`, so a lock held by
 * advanceTicket stays valid. Nothing is deleted: the transcripts and versions are the record of
 * what was said on the ticket. Returns the archive path, or null when there was nothing to move.
 */
export function archiveAutoJournal(iid: number, runId: string): string | null {
  const from = automationDir(iid);
  if (!existsSync(from)) return null;
  const entries = readdirSync(from).filter((e) => e !== 'lock');
  if (!entries.length) return null;
  const archive = join(STATE, 'automation-archive');
  let to = join(archive, `${iid}-${runId}`);
  if (existsSync(to)) to = `${to}-${Date.now().toString(36)}`;
  mkdirSync(to, { recursive: true });
  for (const e of entries) {
    const src = join(from, e);
    const dst = join(to, e);
    try {
      renameSync(src, dst);
    } catch {
      // Rename fails across filesystems, which state/ on an external volume is.
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    }
  }
  return to;
}

/** cases-v<N>.json, atomically. The note, the CSV and the sheet are all rendered from this copy. */
export function saveVersion(iid: number, v: number, a: AutomationArtifact): string {
  mkdirSync(automationDir(iid), { recursive: true });
  const p = versionFile(iid, v);
  writeAtomic(p, `${JSON.stringify(a, null, 2)}\n`);
  return p;
}

export function readVersion(iid: number, v: number): AutomationArtifact | null {
  const p = versionFile(iid, v);
  if (!existsSync(p)) return null;
  try {
    const a = JSON.parse(readFileSync(p, 'utf8')) as AutomationArtifact;
    return a && typeof a === 'object' && Array.isArray(a.cases) ? a : null;
  } catch {
    return null;
  }
}

interface LockBody { pid: number; owner: string; at: number; token: string }

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists and belongs to someone else. Alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(p: string): LockBody | null {
  try {
    const b = JSON.parse(readFileSync(p, 'utf8')) as LockBody;
    return typeof b.pid === 'number' && typeof b.at === 'number' ? b : null;
  } catch {
    return null;
  }
}

/**
 * One advancer per ticket on this machine: an O_EXCL file `lock` holding
 * {pid, owner, at}. Returns the release function, or null when a live owner
 * holds it. A lock whose pid is dead, or older than 3h, is stale and taken
 * over; an unreadable one is treated as stale too, since nothing can prove it
 * belongs to anybody.
 *
 * It serialises the loop's tick against `--automation` and against a second
 * conductor on the SAME desk. It does not reach other machines, which is why
 * the mode is documented as one desk only.
 */
export function acquireTicketLock(iid: number, owner: string): (() => void) | null {
  const dir = automationDir(iid);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'lock');
  const body: LockBody = { pid: process.pid, owner, at: Date.now(), token: randomBytes(6).toString('hex') };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx');
      try { writeSync(fd, JSON.stringify(body)); } finally { closeSync(fd); }
      return () => {
        // Only our own lock: a stale-lock takeover by someone else must not be undone by us.
        const now = readLock(p);
        if (now && now.token === body.token) {
          try { unlinkSync(p); } catch { /* already gone */ }
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const held = readLock(p);
      const stale = !held || !pidAlive(held.pid) || Date.now() - held.at > LOCK_STALE_MS;
      if (!stale) return null;
      try { unlinkSync(p); } catch { /* raced with another taker; the retry decides */ }
    }
  }
  return null;
}
