/**
 * Drive the code review from wherever it stands to where it can stop: done, or
 * waiting on a person.
 *
 * Two sessions, two jobs, and neither can do the other's. The REVIEWER reads
 * and rules; it has no write scope on the worktree and returns only findings
 * and rulings. The FIXER edits and commits; it is handed threads and returns
 * only answers to them. Neither holds a GitLab write tool: the conductor posts
 * for both, from what each returned, which is what lets every note carry a
 * marker, every write be replayed safely, and a finding land on its diff line
 * without a model working out a position payload.
 *
 * The loop keeps no state of its own. Each pass re-reads the merge request and
 * the ledger and asks `nextStep` what is owed, so it resumes after a restart,
 * a dropped connection or a park at exactly the step it left — without running
 * a session to find out where it was, which is what cost #9174 four verify laps.
 *
 * Everything outside this module's reasoning is injected (LoopDeps): GitLab,
 * git, the two sessions, the ledger file. src/conductor/runner.ts supplies the
 * real ones; loop.test.ts supplies fakes.
 */
import {
  applyFix, applyReview, closeLeftover, emptyLedger, fixInput, nextStep, openThreads, reviewInput, syncLive,
} from './ledger.js';
import { openSummary, parkNoteBody } from './notes.js';
import { flush } from './post.js';
import type {
  FixPromptInput, FixerOutput, ReviewApi, ReviewLedger, ReviewPromptInput, ReviewThread, ReviewerOutput,
} from './types.js';

/** What one session came back with. `lap` is the phase lap the conductor ran it as. */
export type Session<T> =
  | { ok: true; lap: number; data: T }
  /**
   * `partial`: what a FIRST review had found when it died, or when it said of
   * itself that it did not cover the change. Its findings are worth posting; it
   * is not the review, which is still owed.
   */
  | { ok: false; why: string; infra: boolean; partial?: T; lap?: number };

export interface LoopDeps {
  runId: string;
  mrIid: number;
  mrUrl: string;
  /** review.maxLaps: fixer laps per review, before the open threads go to a person. */
  maxFixLaps: number;
  /** GitLab usernames whose replies on a thread the fixer acts on (config/reviewers.json). */
  trusted: string[];
  api: ReviewApi;
  load(): ReviewLedger | null;
  save(l: ReviewLedger): void;
  /** HEAD of the run's worktree, or null when git cannot say. */
  head(): string | null;
  /** Files changed between two commits, or null when git cannot say. */
  changedFiles(from: string, to: string): string[] | null;
  /** Fix laps already spent in this review (ledger.ts, fixLapsUsed). */
  fixLapsUsed(): number;
  runReviewer(input: ReviewPromptInput): Promise<Session<ReviewerOutput>>;
  runFixer(input: FixPromptInput): Promise<Session<FixerOutput>>;
  /** Push the run's branch, and confirm the commit the fixer made is what origin now holds. */
  push(): { ok: boolean; error?: string };
  /** The run's worktree, so a path a session returned absolute can be made repo-relative. */
  root?: string;
  /**
   * Move whatever tracked files a fixer session left modified but uncommitted
   * out of the worktree, and name them. The conductor counts a fix by its
   * commit; text left in the tree is not on the branch, yet the re-check and
   * verify would both read it as the code.
   */
  setAside?(label: string): string[];
  /** The run was asked to stop, or is paused. Checked between steps, never mid-write. */
  stopping(): boolean;
  /**
   * Tell a person the review needs them. Called once per distinct set of open
   * threads; `false` means the note did not land, and it is tried again next pass.
   */
  announcePark(body: string): Promise<boolean | void>;
  info(line: string): void;
}

export type LoopOutcome =
  | { kind: 'done'; raised: number; open: number }
  | { kind: 'parked'; why: string; threads: ReviewThread[] }
  /** GitLab or git could not be reached: nothing is lost, the same step is owed next time. */
  | { kind: 'retry-later'; why: string }
  | { kind: 'session-failed'; phase: 'review' | 'review-fix'; why: string; infra: boolean }
  /** Retrying will not help: the same step failed too many times in a row. A person has to look. */
  | { kind: 'stuck'; why: string }
  | { kind: 'stopped' };

/**
 * A ceiling on steps in one call, far above anything a real review takes
 * (review, post, fix, push, post, re-check, post — per lap). It exists so a
 * defect in the step logic ends as a parked run with a reason, not as a
 * conductor spending sessions in a loop nobody is watching.
 */
const MAX_STEPS = 40;

/**
 * Refused pushes in a row before the loop stops asking. A push that fails once
 * is a network blip; one that fails three ticks running is a branch somebody
 * else moved or a commit the fixer rewrote, and no further tick changes that —
 * while each one would park, be re-claimed and try again, saying nothing.
 */
const MAX_PUSH_FAILURES = 3;

export async function driveReview(d: LoopDeps): Promise<LoopOutcome> {
  const stored = d.load();
  // A ledger for another merge request describes threads that are not on this one.
  let l = stored && stored.mrIid === d.mrIid ? stored : emptyLedger(d.runId, d.mrIid);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (d.stopping()) return { kind: 'stopped' };

    const head = d.head();
    if (!head) return { kind: 'retry-later', why: 'git could not name the head of the worktree' };

    // The push comes before any write: a reply that cites a commit must find it on the MR.
    if (l.pushOwed) {
      const pushed = d.push();
      if (!pushed.ok) {
        const failures = (l.pushFailures ?? 0) + 1;
        l = { ...l, pushFailures: failures };
        d.save(l);
        const why = `could not push the fixer's commits: ${pushed.error ?? 'no reason given'}`;
        return failures >= MAX_PUSH_FAILURES
          ? { kind: 'stuck', why: `${why} — ${failures} attempts in a row, so retrying is not going to fix it. `
            + 'The fixer\'s replies are queued and not yet posted; reconcile the branch by hand, then unblock' }
          : { kind: 'retry-later', why };
      }
      l = { ...l, pushOwed: false };
      delete l.pushFailures;
      d.save(l);
    }

    const live = await d.api.discussions();
    if (!live) return { kind: 'retry-later', why: `could not read the discussions on !${d.mrIid}` };

    if (l.pending.length) {
      const flushed = await flush(l, d.api, { live, save: d.save, trusted: d.trusted });
      l = flushed.ledger;
      if (flushed.failed) return { kind: 'retry-later', why: flushed.failed };
      continue; // read the merge request again now that it has changed
    }

    const synced = syncLive(l, live, { trusted: d.trusted, self: await d.api.self() });
    // Saved only when GitLab said something new: a parked run reads the merge
    // request every tick, and most ticks it says what it said the last time.
    if (JSON.stringify(synced) !== JSON.stringify(l)) d.save(synced);
    l = synced;

    const used = d.fixLapsUsed();
    const next = nextStep(l, { head, fixLapsUsed: used, maxFixLaps: d.maxFixLaps });

    if (next.kind === 'flush') continue;

    if (next.kind === 'review') {
      const changed = next.recheck && l.reviewedSha ? d.changedFiles(l.reviewedSha, head) : null;
      const s = await d.runReviewer(reviewInput(l, { recheck: next.recheck, headSha: head, changedFiles: changed }));
      if (!s.ok) {
        if (s.partial && !next.recheck) {
          // Posted, so nothing a dead or half-done review found is lost — but
          // `reviewedSha` is left alone, so a first review is still what is owed,
          // and the next attempt is shown these as already open.
          const kept = applyReview(l, s.partial, {
            lap: s.lap ?? 0, headSha: head, recheck: false, changedFiles: null, root: d.root, partial: true,
          });
          l = kept.ledger;
          d.save(l);
          // Posted now rather than on the next entry: if this was the last
          // attempt the run stops here, and "kept as threads" has to be true.
          const now = await d.api.discussions();
          if (now) l = (await flush(l, d.api, { live: now, save: d.save, trusted: d.trusted })).ledger;
          d.info(`review did not finish — ${kept.raised.length} finding(s) it had are kept as threads`
            + `${l.pending.length ? ` (${l.pending.length} still to post)` : ''}; the review is still owed`);
        }
        return { kind: 'session-failed', phase: 'review', why: s.why, infra: s.infra };
      }
      const applied = applyReview(l, s.data, {
        lap: s.lap, headSha: head, recheck: next.recheck, changedFiles: changed, root: d.root,
      });
      l = applied.ledger;
      d.save(l);
      d.info(`review lap${s.lap} (${next.recheck ? 're-check' : 'first review'}): ${applied.raised.length} thread(s) raised`
        + `${applied.dropped.length ? `, ${applied.dropped.length} finding(s) not posted (${next.recheck
          ? 'not entitled to a thread on a re-check' : 'already open on the merge request'})` : ''}`
        + `, ${openThreads(l).length} open`);
      continue;
    }

    if (next.kind === 'fix') {
      const handed = next.threads.map((t) => t.id);
      const s = await d.runFixer(fixInput(l, { threads: next.threads, headSha: head, lap: used + 1, maxLaps: d.maxFixLaps }));
      const after = d.head() ?? head;
      // Before anything reads the tree again: what the fixer edited and did not
      // commit is not a fix, and must not be standing in the files the re-check
      // and verify open.
      const aside = d.setAside?.(`review-fix lap ${used + 1}`) ?? [];
      if (aside.length) {
        d.info(`review-fix left ${aside.length} file(s) edited but uncommitted — set aside, not on the branch: `
          + aside.slice(0, 6).join(', '));
      }
      if (!s.ok) {
        // A fixer that died may still have committed. Those commits are on the
        // branch whatever became of its answer, so they are pushed and re-checked.
        if (after !== head) l = { ...l, pushOwed: true, recheckOwed: true, fixedAt: Date.now() };
        // A person's reply the lap was handed and never answered has now had one
        // try (nextStep stops starting laps for it after MAX_HUMAN_TRIES).
        if (!s.infra) {
          l = {
            ...l,
            threads: l.threads.map((t) => (handed.includes(t.id) && t.human?.length
              ? { ...t, humanTries: (t.humanTries ?? 0) + 1 } : t)),
          };
        }
        d.save(l);
        return { kind: 'session-failed', phase: 'review-fix', why: s.why, infra: s.infra };
      }
      const applied = applyFix(l, s.data, { lap: s.lap, headBefore: head, headAfter: after, handed });
      l = after !== head ? { ...applied.ledger, fixedAt: Date.now() } : applied.ledger;
      d.save(l);
      d.info(`review-fix lap${s.lap}: fixed ${applied.fixed.join(', ') || 'none'}; `
        + `not changed ${applied.declined.join(', ') || 'none'}`
        + `${applied.unanswered.length ? `; unanswered ${applied.unanswered.join(', ')}` : ''}`);
      continue;
    }

    if (next.kind === 'close') {
      l = closeLeftover(l, next.threads.map((t) => t.id), l.reviewLap ?? 0);
      d.save(l);
      d.info(`review: closing ${next.threads.length} non-blocking thread(s) nobody took up: ${openSummary(next.threads)}`);
      continue;
    }

    if (next.kind === 'park') {
      const key = next.threads.map((t) => `${t.id}:${t.status}`).join(',');
      if (l.parkNoted !== key) {
        const said = await d.announcePark(parkNoteBody({
          threads: next.threads, mrIid: d.mrIid, mrUrl: d.mrUrl, runId: d.runId,
          fixLaps: used, maxFixLaps: d.maxFixLaps,
        }));
        if (said !== false) {
          l = { ...l, parkNoted: key };
          d.save(l);
        }
      }
      return { kind: 'parked', why: next.why, threads: next.threads };
    }

    if (l.parkNoted) {
      l = { ...l };
      delete l.parkNoted;
      d.save(l);
    }
    return { kind: 'done', raised: l.threads.length, open: openThreads(l).length };
  }

  return {
    kind: 'retry-later',
    why: `the review loop did not settle in ${MAX_STEPS} steps — the run's review-threads.json holds where it stands`,
  };
}
