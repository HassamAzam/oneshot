/**
 * Does a run journal on disk belong to the project GITLAB_REPO_URL names?
 *
 * state/runs/<iid>/ is keyed by ticket iid, and an iid is only unique within a
 * project. When the URL moves to another project, every journal the old one
 * left — running, aborted, parked, blocked — is still there under the same
 * numbers, and nothing in it said which project it was for. The runner would
 * resume issue #237's journal for the NEW project's #237: its worktree, cut
 * from the old project's clone and pushing to that origin, and its MR iid,
 * read as an MR of the new project. Every boot check passes, because none of
 * them looks at a journal.
 *
 * So each journal is stamped with the project it was written for, and a journal
 * is only resumed, or unblocked, when it belongs here:
 *   - stamped with this project;
 *   - or unstamped (written before the stamp existed) with a ticket `url` in
 *     this project — every journal has recorded its issue URL from the start,
 *     so an old journal names its own project. It is adopted and stamped.
 * Either way a recorded worktree that still exists must have been cut from
 * WORK_REPO's clone. Anything else is foreign. The runner archives it and
 * starts the ticket fresh (a fresh run is the same outcome a delivered run
 * gets); `npm run unblock` refuses it; doctor and preflight warn that
 * state/runs holds some.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS, STATE, WORK_REPO, repoIdentity } from './config.js';
import { readJournal, type RunJournal } from './artifacts.js';
import { commonGitDir } from './repocheck.js';
import { repoKey } from './repourl.cjs';
import type { Finding } from './repourl.cjs';

export type JournalOwner =
  | { kind: 'ours'; adopt: boolean }
  | { kind: 'foreign'; why: string };

/**
 * Pure. `project` is this project's key; `worktreeOurs` is whether the
 * journal's recorded worktree was cut from WORK_REPO's clone — true, false, or
 * null when there is no worktree to ask (none recorded, gone, unreadable).
 */
export function judgeJournalProject(
  j: Pick<RunJournal, 'project' | 'worktree' | 'url'>, project: string, worktreeOurs: boolean | null,
): JournalOwner {
  if (worktreeOurs === false) {
    return { kind: 'foreign', why: `its worktree ${j.worktree} was not cut from WORK_REPO's clone` };
  }
  if (j.project) {
    return j.project === project
      ? { kind: 'ours', adopt: false }
      : { kind: 'foreign', why: `it was written for ${j.project}, not ${project}` };
  }
  if (repoKey(j.url ?? '') === project) return { kind: 'ours', adopt: true };
  return { kind: 'foreign', why: `its ticket ${j.url || '(no url)'} is not in ${project}` };
}

/** This project's journal stamp, or null when GITLAB_REPO_URL is unusable. */
export function currentProjectKey(): string | null {
  const { repo } = repoIdentity();
  return repo ? repoKey(repo.url) : null;
}

/** Was `worktree` cut from WORK_REPO's clone? null when either side cannot be read. */
export function worktreeFromWorkRepo(worktree: string | undefined, workRepo: string = WORK_REPO): boolean | null {
  if (!worktree || !existsSync(worktree) || !workRepo || !existsSync(workRepo)) return null;
  const mine = commonGitDir(workRepo);
  const its = commonGitDir(worktree);
  if (!mine || !its) return null;
  return mine === its;
}

/**
 * judgeJournalProject() against this machine. With no usable GITLAB_REPO_URL
 * nothing can be proven ours, so everything is foreign — boot refuses that
 * configuration anyway, and unblock checks it first.
 */
export function journalOwner(j: RunJournal): JournalOwner {
  const project = currentProjectKey();
  if (!project) return { kind: 'foreign', why: 'GITLAB_REPO_URL is unset or invalid' };
  return judgeJournalProject(j, project, worktreeFromWorkRepo(j.worktree));
}

/** Every iid under state/runs with an unfinished journal that is not this project's, with why. */
export function foreignJournals(): Array<{ iid: number; status: RunJournal['status']; why: string }> {
  let names: string[];
  try { names = readdirSync(RUNS); } catch { return []; }
  const out: Array<{ iid: number; status: RunJournal['status']; why: string }> = [];
  for (const name of names) {
    const iid = Number(name);
    if (!Number.isInteger(iid) || iid <= 0) continue;
    const j = readJournal(iid);
    // A delivered run is archived on its next claim whichever project it was for.
    if (!j || j.status === 'done') continue;
    const owner = journalOwner(j);
    if (owner.kind === 'foreign') out.push({ iid, status: j.status, why: owner.why });
  }
  return out;
}

/**
 * The doctor/preflight line for foreign journals, or null when there are none
 * (or no project to judge them against — reported on its own). It carries the
 * command that moves exactly those journals aside: a glob over state/runs would
 * take this project's live runs with them.
 */
export function foreignJournalFinding(): Finding | null {
  if (!currentProjectKey()) return null;
  const foreign = foreignJournals();
  if (!foreign.length) return null;
  const shown = foreign.slice(0, 8).map((f) => `#${f.iid} (${f.status})`).join(', ');
  const more = foreign.length > 8 ? ` and ${foreign.length - 8} more` : '';
  return {
    level: 'warn',
    label: 'state/runs holds run journals from another project',
    detail: `${shown}${more} — e.g. #${foreign[0]?.iid}: ${foreign[0]?.why}. They are never resumed: `
      + 'a claim of that iid archives the journal and starts fresh, and `npm run unblock` refuses it. '
      + `To tidy up, move exactly these aside: mkdir -p ${join(STATE, 'runs-archive')} && mv `
      + `${foreign.map((f) => join(RUNS, String(f.iid))).join(' ')} ${join(STATE, 'runs-archive')}/`,
  };
}
