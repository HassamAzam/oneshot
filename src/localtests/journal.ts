/**
 * The local automation tests mode's own state: `STATE/localtests/<iid>/`.
 *
 * Not the Loop's run journal (state/runs/<iid>/run.json, lib/artifacts.ts):
 * the Loop resumes, archives and reports on what it finds there, and this mode
 * runs AFTER the Loop has finished with the ticket. What is shared with
 * state/runs/<iid> is only what scripts/localtests.cjs derives from it — the
 * throwaway automation worktrees, the patch, the run's artifacts and videos —
 * because that script's contract keys every resource by that directory. The
 * Loop archives that directory whole when it claims the ticket again, so what
 * this mode must still have afterwards — an approved list's patch, the record
 * of a run it has not reported yet — is copied here.
 *
 * Layout:
 *   STATE/localtests/<iid>/journal.json      the state machine's record (this file's type)
 *   STATE/localtests/<iid>/list-r<N>.json    each list exactly as it was put to QA (the scope object)
 *   STATE/localtests/<iid>/patch-r<N>.patch  that list's temporary spec changes, copied out of state/runs/<iid>
 *   STATE/localtests/<iid>/run.json          the last run's record, copied out of state/runs/<iid>
 *   STATE/localtests/<iid>/erp/              the read-only ERP checkout at the merge commit, while a scope session reads it
 *   STATE/localtests/<iid>/dry-run/          DRY_RUN only: every write the mode would have made, in full
 *   STATE/localtests/<iid>/lock              who is advancing this ticket right now
 *
 * The journal is the local source of truth and is written atomically (a temp
 * file, then rename) after every transition. Every GitLab write the runner
 * makes is marker-checked before it is made, which covers the one gap atomic
 * writes cannot: a crash between the write and the journal update.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { STATE } from '../lib/config.js';
import { currentProjectKey } from '../lib/journalproject.js';

/**
 * Where a ticket is. Read with nextStep (runner.ts), which turns it and the
 * ticket's labels into the next thing to do.
 *
 *   new          first sight, nothing checked
 *   waiting      labelled, no merged MR yet — checked again later, quietly
 *   scoping      a scope session is owed (first, or QA asked for a temporary test or for changes)
 *   rechecking   QA asked to check workstream-automation master again (no session)
 *   adding       QA named spec files to add
 *   awaiting-qa  a list is on the ticket (or about to be), waiting for a QA reply
 *   approved     QA approved; the labels (and, for no tests, the record) are owed
 *   running      labels say Running; the Cypress run is owed (or parked)
 *   reporting    the run finished; the results note and the done labels are owed
 *   setup-error  the run could not happen; the labels go back and the error is posted
 *   stuck        two scope sessions failed; a QA comment releases it
 *   done         finished
 */
export type LocalTestsState =
  | 'new' | 'waiting' | 'scoping' | 'rechecking' | 'adding' | 'awaiting-qa'
  | 'approved' | 'running' | 'reporting' | 'setup-error' | 'stuck' | 'done';

/**
 * One of the ticket's own merged MRs: `base..head` is its change. `base` null:
 * the readiness check could not say, and it is `head^1`, learned from git.
 */
export interface MergedRange { mrIid: number; base: string | null; head: string }

/**
 * The change under test, as readiness proved it. `base` is the commit before
 * the change: readiness's answer when it gave one (the MR's own base for a
 * merge that made no merge commit), else the merge commit's first parent,
 * learned from git.
 */
export interface MergedRef {
  mrIid: number;
  title: string;
  mergeSha: string;
  base: string | null;
  /** `base` came from readiness and is confirmed to be in the ERP clone. */
  baseChecked?: boolean;
  sourceBranch: string;
  targetBranch: string;
  author: string | null;
  url: string;
  /**
   * Every MR that is the ticket's own and merged into the base branch, oldest
   * first, the tested one last. Set only when there is more than one: the scope
   * and the re-check then look at each one's change, not only the last.
   */
  ranges?: MergedRange[];
}

/**
 * `found`: tests to run, put to QA for approval. `not-found`: the scope found
 * none, with a suggested test. `recheck-not-found`: a re-check or QA's named
 * files found none either.
 */
export type ListKind = 'found' | 'not-found' | 'recheck-not-found';

/** One list put to QA. The scope object it was rendered from is list-r<round>.json beside the journal. */
export interface ListRecord {
  round: number;
  /** What made it: the scope session, the deterministic re-check, or QA's `added` files. */
  source: 'scope' | 'recheck' | 'added';
  kind: ListKind;
  /** The spec files a run executes, in order. Empty for the two not-found kinds. */
  specs: string[];
  notRunnable: Array<{ spec: string; why: string }>;
  /** The workstream-automation commit the list (and its patch) is true of. */
  automationSha: string;
  patchFile: string | null;
  patchSha: string | null;
  /** Paths QA named that are not on the automation ref. */
  unknown?: string[];
  /** For the start note: test cases and minutes, as the scope priced them. */
  tests?: number;
  estimatedMinutes?: number;
  /** The ticket's merged MRs whose changes this list was chosen for, oldest first. Absent: the tested MR alone. */
  scopedMrs?: number[];
  /** The round whose temporary changes this list keeps, cut against an earlier automation commit. */
  patchFromRound?: number;
  /** Put to QA again because a reply to the previous round came after another Oneshot request. */
  askedAgain?: { by: string; noteId: number };
  /** null until posted, and for good in DRY_RUN (a dry-run post has no id). */
  noteId: number | null;
  /** "Posted" means THIS is set, never noteId. */
  postedAt: number | null;
}

export interface LocalTestsJournal {
  v: 1; iid: number; runId: string; project: string | null; title: string;
  state: LocalTestsState; createdAt: number; updatedAt: number;
  merged?: MergedRef;
  /** The last not-ready check, so a waiting ticket is re-checked on change or cadence, not every tick. */
  readiness?: { at: number; issueUpdatedAt: string | null; reason: string };
  /** What QA asked of the next scope session. */
  request?: { kind: 'write-temporary' | 'feedback'; feedback?: string; noteId: number; by: string };
  /** The files QA's `disapproved: added …` named, not yet checked. */
  addFiles?: { files: string[]; noteId: number; by: string };
  lists: ListRecord[];
  /** The highest note id a decision has CONSUMED. Replies count only above it and above the latest list's note. */
  watermark: number;
  /** QA's approval of one list. DRY_RUN: { by: 'dry-run', noteId: 0 }. */
  decision?: { round: number; by: string; noteId: number; at: string };
  /**
   * A start label edit about to be sent, or sent with no answer yet. Written
   * before the edit, so an edit GitLab applied whose reply was lost (or a crash
   * right after it) is finished from the ticket's labels instead of being lost
   * with the trigger the edit itself took off.
   */
  pendingLabels?: 'running' | 'done';
  /** The approved-with-a-list label edit (trigger out, running in) is made. */
  labelsRunning?: boolean;
  /** The finishing label edit is made. */
  labelsDone?: boolean;
  /** What the last run reported. The whole run is state/runs/<iid>/local-tests-run.json. */
  run?: { status: string; cacheKey: string; reason?: string; at: number };
  resultsPostedAt?: number | null;
  resultsNoteId?: number | null;
  /** The record posted when QA approved going on without local tests. */
  recordPostedAt?: number | null;
  /** A run that could not happen. Kept after the restore, so a dry run does not retry it by itself. */
  setupError?: { reason: string; at: number; round: number; labelsRestored: boolean; postedAt: number | null; noteId: number | null };
  /** Charged scope failures since the last list was saved (or since `stuck` was released). */
  attempts: number;
  /** Scope sessions started, ever. */
  sessions: number;
  /** Uncharged session failures in a row. Three charge one attempt. */
  freeRetries: number;
  /** sinceNoteId: the highest note id when the stuck note went up — never null once learned. */
  stuck?: { at: number; reason: string; fp: string; notePostedAt: number | null; sinceNoteId: number | null };
  /** What this ticket holds on the desk right now, recorded before it is taken so a crash can still be cleaned up. */
  holding?: { erp?: string; wsa?: string; pids?: number[]; since: number };
  /** alert() keys already sent for this journal. */
  alerted?: string[];
  /** Another desk's request found on the ticket before this one posted anything: logged once per run id. */
  otherDesk?: { runId: string; at: number };
}

/** A lock older than this is taken over whatever its pid says: the longest step is a two-hour run. */
const LOCK_STALE_MS = 4 * 60 * 60_000;

export function localTestsHome(): string {
  return join(STATE, 'localtests');
}

export function localTestsDir(iid: number): string {
  return join(localTestsHome(), String(iid));
}

/** The read-only ERP checkout at the merge commit, while a scope session reads it. */
export function erpCheckoutDir(iid: number): string {
  return join(localTestsDir(iid), 'erp');
}

function journalFile(iid: number): string {
  return join(localTestsDir(iid), 'journal.json');
}

function listFile(iid: number, round: number): string {
  return join(localTestsDir(iid), `list-r${round}.json`);
}

function runFile(iid: number): string {
  return join(localTestsDir(iid), 'run.json');
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

function isJournal(v: unknown, iid?: number): v is LocalTestsJournal {
  if (!v || typeof v !== 'object') return false;
  const j = v as Record<string, unknown>;
  return j.v === 1 && typeof j.iid === 'number' && (iid === undefined || j.iid === iid)
    && typeof j.runId === 'string' && typeof j.state === 'string' && Array.isArray(j.lists);
}

/**
 * The journal, or null when there is none or it cannot be read. An unreadable
 * journal is treated as absent: the ticket starts fresh, and the marker checks
 * stop that from re-posting anything GitLab already has from the same run.
 */
export function readLtJournal(iid: number): LocalTestsJournal | null {
  const p = journalFile(iid);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!isJournal(j, iid)) return null;
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
export function writeLtJournal(j: LocalTestsJournal): void {
  mkdirSync(localTestsDir(j.iid), { recursive: true });
  j.updatedAt = Date.now();
  writeAtomic(journalFile(j.iid), `${JSON.stringify(j, null, 2)}\n`);
}

/**
 * A fresh record in state `new`. The run id is `l-…`, so its events, quota
 * rows and Cypress lease can never be mistaken for a Loop run's `r-…` or the
 * automation mode's `a-…`, and every post marker carries it, so a new request
 * never adopts an earlier request's notes.
 */
export function newLtJournal(iid: number, title: string): LocalTestsJournal {
  const now = Date.now();
  return {
    v: 1,
    iid,
    runId: `l-${now.toString(36)}-${randomBytes(3).toString('hex')}`,
    project: currentProjectKey(),
    title,
    state: 'new',
    createdAt: now,
    updatedAt: now,
    lists: [],
    watermark: 0,
    attempts: 0,
    sessions: 0,
    freeRetries: 0,
  };
}

/** Every readable STATE/localtests/<iid>/journal.json, by iid. */
export function listLtJournals(): LocalTestsJournal[] {
  const home = localTestsHome();
  if (!existsSync(home)) return [];
  const out: LocalTestsJournal[] = [];
  for (const name of readdirSync(home)) {
    if (!/^\d+$/.test(name)) continue;
    const j = readLtJournal(Number(name));
    if (j) out.push(j);
  }
  return out.sort((a, b) => a.iid - b.iid);
}

/**
 * → STATE/localtests-archive/<iid>-<runId>. Moves every entry EXCEPT `lock`
 * (held by the advance doing the archiving) and `erp` (a git worktree, which
 * gc removes through git). Nothing is deleted: the lists are the record of what
 * was put to QA. Returns the archive path, or null when there was nothing to move.
 */
export function archiveLtJournal(iid: number, runId: string): string | null {
  const from = localTestsDir(iid);
  if (!existsSync(from)) return null;
  const entries = readdirSync(from).filter((e) => e !== 'lock' && e !== 'erp');
  if (!entries.length) return null;
  const archive = join(STATE, 'localtests-archive');
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

/** list-r<N>.json, atomically: the scope object the note was rendered from. */
export function saveList(iid: number, round: number, scope: Record<string, unknown>): string {
  mkdirSync(localTestsDir(iid), { recursive: true });
  const p = listFile(iid, round);
  writeAtomic(p, `${JSON.stringify(scope, null, 2)}\n`);
  return p;
}

export function readList(iid: number, round: number): Record<string, unknown> | null {
  const p = listFile(iid, round);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * patch-r<N>.patch: a list's temporary changes, copied beside the journal. The
 * scope saves them under state/runs/<iid>, which the Loop archives whole when it
 * claims the ticket again; an approved list must still find its patch after
 * that. A patch already under this ticket's directory (a list put to QA again)
 * is kept where it is. Returns the path to record, or null when `src` is not
 * there to copy — the caller keeps `src`, and the run says it is missing.
 */
export function keepPatch(iid: number, round: number, src: string): string | null {
  const dir = resolve(localTestsDir(iid));
  if (resolve(src).startsWith(`${dir}${sep}`) && existsSync(src)) return src;
  if (!existsSync(src)) return null;
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `patch-r${round}.patch`);
  const tmp = `${to}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  copyFileSync(src, tmp);
  try {
    renameSync(tmp, to);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return to;
}

/** run.json, atomically: the run's record, so a report owed still has it if state/runs/<iid> is archived. */
export function saveRunRecord(iid: number, run: Record<string, unknown>): void {
  mkdirSync(localTestsDir(iid), { recursive: true });
  writeAtomic(runFile(iid), `${JSON.stringify(run, null, 2)}\n`);
}

export function readRunRecord(iid: number): Record<string, unknown> | null {
  const p = runFile(iid);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
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

function lockStale(held: LockBody | null): boolean {
  return !held || !pidAlive(held.pid) || Date.now() - held.at > LOCK_STALE_MS;
}

/**
 * One advancer per ticket on this machine: an O_EXCL file `lock` holding
 * {pid, owner, at}. Returns the release function, or null when a live owner
 * holds it. A lock whose pid is dead, or older than LOCK_STALE_MS, is stale and
 * taken over; an unreadable one is treated as stale too.
 *
 * It serialises the tick against `--local-tests` and against a second
 * conductor on the SAME desk, and it is what gc reads to know which tickets'
 * worktrees are in use. It does not reach other machines — which is why the
 * mode, like the Ready For Automation mode, is run by one desk: the one whose
 * .env sets ONESHOT_LOCAL_TESTS_REPO.
 */
export function acquireLtLock(iid: number, owner: string): (() => void) | null {
  const dir = localTestsDir(iid);
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
      if (!lockStale(readLock(p))) return null;
      try { unlinkSync(p); } catch { /* raced with another taker; the retry decides */ }
    }
  }
  return null;
}

/**
 * The tickets some live process on this machine is advancing right now — this
 * one included. gc keeps everything that belongs to them: a scope session's
 * automation worktree has no process of its own to show it is in use.
 */
export function heldLtIids(): number[] {
  const home = localTestsHome();
  if (!existsSync(home)) return [];
  const out: number[] = [];
  for (const name of readdirSync(home)) {
    if (!/^\d+$/.test(name)) continue;
    const p = join(home, name, 'lock');
    if (existsSync(p) && !lockStale(readLock(p))) out.push(Number(name));
  }
  return out.sort((a, b) => a - b);
}
