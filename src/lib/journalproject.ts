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
 * So each journal is stamped with the project it was written for, and whose it
 * is is decided by that record ALONE:
 *   - stamped: ours exactly when the stamp is this project;
 *   - unstamped (written before the stamp existed): ours when its ticket `url`
 *     is in this project — every journal has recorded its issue URL from the
 *     start, so an old journal names its own project. It is adopted and
 *     stamped. No url, or one that does not parse, proves nothing: foreign.
 * A foreign journal is never resumed. The runner archives it and starts the
 * ticket fresh (a fresh run is the same outcome a delivered run gets);
 * `npm run unblock` refuses it; doctor and preflight warn that state/runs holds
 * some.
 *
 * The recorded worktree never makes a journal foreign. Which CLONE it was cut
 * from proves nothing about the project — WORK_REPO re-cloned elsewhere leaves
 * the old clone's worktrees perfectly good push and fetch targets, holding the
 * run's uncommitted and unpushed work — and archiving an ours journal costs its
 * plan, its implementation, its gates and review rounds, and opens a second MR.
 * So the worktree is judged by PROJECT, by its origin, and only ever changes
 * how an ours journal resumes: a worktree of this project, or one whose origin
 * cannot be read, is kept; one provably of another project is dropped and the
 * runner leases a fresh one from WORK_REPO (worktreeToResume()).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS, STATE, repoIdentity } from './config.js';
import { readJournal, type RunJournal } from './artifacts.js';
import { checkoutProject, sameDir } from './repocheck.js';
import { repoKey } from './repourl.cjs';
import type { Finding, OriginProject } from './repourl.cjs';

/** Whose journal it is by its own record, before its worktree is looked at. */
export type JournalHome =
  | { kind: 'ours'; adopt: boolean }
  | { kind: 'foreign'; why: string };

/**
 * JournalHome, plus what an ours journal's recorded worktree is to this
 * project: `dropWorktree` when it is provably a checkout of another one, with
 * `why` for the log line. Never a reason to call the journal foreign.
 */
export type JournalOwner =
  | JournalHome
  | { kind: 'ours'; adopt: boolean; dropWorktree: true; why: string };

/** Pure. `project` is this project's key. The worktree is not consulted. */
export function judgeJournalHome(j: Pick<RunJournal, 'project' | 'url'>, project: string): JournalHome {
  if (j.project) {
    return j.project === project
      ? { kind: 'ours', adopt: false }
      : { kind: 'foreign', why: `it was written for ${j.project}, not ${project}` };
  }
  if (repoKey(j.url ?? '') === project) return { kind: 'ours', adopt: true };
  return { kind: 'foreign', why: `its ticket ${j.url || '(no url)'} is not in ${project}` };
}

/**
 * judgeJournalHome(), then — for an ours journal that records a worktree —
 * `worktreeOf` asked which project that worktree is. Pure given `worktreeOf`,
 * which is never called for a foreign journal.
 */
export function judgeJournalProject(
  j: Pick<RunJournal, 'project' | 'worktree' | 'url'>, project: string,
  worktreeOf: (dir: string) => OriginProject,
): JournalOwner {
  const home = judgeJournalHome(j, project);
  if (home.kind === 'foreign' || !j.worktree) return home;
  const wt = worktreeOf(j.worktree);
  if (wt.kind !== 'other') return home;
  return {
    ...home,
    dropWorktree: true,
    why: `its recorded worktree ${j.worktree} is a checkout of ${wt.url}, not of ${project}`,
  };
}

/** This project's journal stamp, or null when GITLAB_REPO_URL is unusable. */
export function currentProjectKey(): string | null {
  const { repo } = repoIdentity();
  return repo ? repoKey(repo.url) : null;
}

/**
 * judgeJournalProject() against this machine. With no usable GITLAB_REPO_URL
 * nothing can be proven ours, so everything is foreign — boot refuses that
 * configuration anyway, and unblock checks it first.
 */
export function journalOwner(j: RunJournal): JournalOwner {
  const project = currentProjectKey();
  if (!project) return { kind: 'foreign', why: 'GITLAB_REPO_URL is unset or invalid' };
  const repoUrl = repoIdentity().repo?.url;
  return judgeJournalProject(j, project, (dir) => checkoutProject(dir, repoUrl));
}

/** worktreeToResume()'s answer. */
export type WorktreeResume =
  | { kind: 'none' }
  | { kind: 'keep'; worktree: string }
  | { kind: 'gone'; was: string }
  | { kind: 'drop'; was: string; why: string }
  | { kind: 'block'; why: string };

/**
 * What a resuming run does with the worktree its journal records, given
 * journalOwner()'s verdict and `leaseAt`, where a lease for this run would put
 * one (WT_ROOT/<worktreeName>):
 *   - none:  nothing recorded — leased when a phase first needs it;
 *   - keep:  resume in it;
 *   - gone:  recorded but no longer on disk — re-leased;
 *   - drop:  provably another project's checkout — forget it and re-lease. It
 *            is left on disk: it belongs to that project's clone, and whatever
 *            is in it is not this run's to delete;
 *   - block: to drop, but it sits at `leaseAt` itself, where the re-lease would
 *            only re-attach to it. A person has to move it aside.
 * The port the journal records is the run's, not the worktree's, and stays, as
 * it does for a worktree that is gone: scripts/app.cjs refuses to start this
 * worktree's app on a port that still serves another worktree.
 */
export function worktreeToResume(
  j: Pick<RunJournal, 'worktree'>, owner: JournalOwner | null, leaseAt: string,
): WorktreeResume {
  const was = j.worktree;
  if (!was) return { kind: 'none' };
  if (owner && 'dropWorktree' in owner) {
    if (sameDir(was, leaseAt)) {
      return {
        kind: 'block',
        why: `worktree: ${owner.why}, and it sits where this run's worktree is leased. Move it aside — it `
          + 'belongs to that project\'s clone and may hold work that is not pushed — then unblock the ticket; '
          + 'the run resumes in a fresh worktree cut from WORK_REPO',
      };
    }
    return { kind: 'drop', was, why: owner.why };
  }
  return existsSync(was) ? { kind: 'keep', worktree: was } : { kind: 'gone', was };
}

/**
 * Every iid under state/runs with an unfinished journal that is not this
 * project's, with why. By the journal's own record alone: the worktree never
 * makes a journal foreign, so it is not read here.
 */
export function foreignJournals(): Array<{ iid: number; status: RunJournal['status']; why: string }> {
  const project = currentProjectKey();
  if (!project) return [];
  let names: string[];
  try { names = readdirSync(RUNS); } catch { return []; }
  const out: Array<{ iid: number; status: RunJournal['status']; why: string }> = [];
  for (const name of names) {
    const iid = Number(name);
    if (!Number.isInteger(iid) || iid <= 0) continue;
    const j = readJournal(iid);
    // A delivered run is archived on its next claim whichever project it was for.
    if (!j || j.status === 'done') continue;
    const home = judgeJournalHome(j, project);
    if (home.kind === 'foreign') out.push({ iid, status: j.status, why: home.why });
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
