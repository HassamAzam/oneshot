import { activeRound, completeRound, markReplied, markResolved, noteRespondFailure } from './ledger.js';
import { executeResponses, planResponses, type ThreadWriteResult } from './respond.js';
import { actionableThreads } from './threads.js';
import type { FeedbackThread, MrDiscussion, MrFeedbackConfig, MrFeedbackLedger } from './types.js';

/** Everything the merge-phase operations touch, injected so they test without GitLab or disk. */
export interface MergeHookDeps {
  config: MrFeedbackConfig;
  readLedger(): MrFeedbackLedger | undefined;
  writeLedger(l: MrFeedbackLedger): void;
  /** null when GitLab could not be read. */
  discussions(mrIid: number): Promise<MrDiscussion[] | null>;
  headSha(mrIid: number): Promise<string | null>;
  reply(mrIid: number, discussionId: string, body: string): Promise<ThreadWriteResult>;
  resolve(mrIid: number, discussionId: string): Promise<ThreadWriteResult>;
}

/**
 * Failed answering passes a round gets before merge stops parking and blocks.
 * A refused or locked thread fails the same way every pass; without a cap the
 * run would park on it forever, never merging and never telling anyone.
 */
export const MAX_RESPOND_ATTEMPTS = 3;

export type RespondOutcome =
  | { kind: 'none' }
  | { kind: 'done'; replied: number; resolved: number }
  | { kind: 'retry-later'; why: string }
  | { kind: 'give-up'; why: string };

export interface MergeHooks {
  respondToActiveRound(mrIid: number): Promise<RespondOutcome>;
  newFeedbackThreads(mrIid: number): Promise<FeedbackThread[]>;
}

export function createMergeHooks(deps: MergeHookDeps): MergeHooks {
  return {
    /**
     * Answer the round this run just finished. Called only from merge, which
     * runs after qualityGate — so every "Addressed" reply describes code that
     * review approved and verify passed.
     */
    async respondToActiveRound(mrIid) {
      const ledger = deps.readLedger();
      const round = activeRound(ledger);
      if (!ledger || !round) return { kind: 'none' };
      if (round.mrIid !== mrIid) {
        // Its threads live on an MR this run no longer merges; answering there helps nobody.
        deps.writeLedger(completeRound(ledger, []));
        return { kind: 'none' };
      }

      let next: MrFeedbackLedger = ledger;
      const failedPass = (why: string): RespondOutcome => {
        next = noteRespondFailure(next);
        deps.writeLedger(next);
        const spent = activeRound(next)?.respondAttempts ?? 0;
        return spent >= MAX_RESPOND_ATTEMPTS
          ? { kind: 'give-up', why: `${why} — gave up after ${spent} attempts` }
          : { kind: 'retry-later', why };
      };

      const sha = await deps.headSha(mrIid);
      if (!sha) return failedPass(`cannot read the head of !${mrIid} to cite in review replies`);

      const actions = planResponses(round, { headSha: sha, policy: deps.config.resolve });
      // Each landed write is journaled before the next is attempted: a crash
      // mid-answer must not re-post a reply the reviewer has already seen.
      const result = await executeResponses(round, actions, {
        reply: (id, body) => deps.reply(mrIid, id, body),
        resolve: (id) => deps.resolve(mrIid, id),
        onReplied: (id) => { next = markReplied(next, id); deps.writeLedger(next); },
        onResolved: (id) => { next = markResolved(next, id); deps.writeLedger(next); },
      });

      if (result.failures.length) {
        return failedPass(`could not finish answering review threads on !${mrIid}: ${result.failures.join('; ')}`);
      }

      const lastNote = new Map(round.threads.map((t) => [t.discussionId, t.lastNoteId]));
      next = completeRound(next, actions
        .filter((a) => a.handled)
        .map((a) => ({ discussionId: a.discussionId, lastNoteId: lastNote.get(a.discussionId) ?? 0 })));
      deps.writeLedger(next);
      return { kind: 'done', replied: actions.length, resolved: actions.filter((a) => a.resolve).length };
    },

    /** Threads needing a round. Empty on a read failure: detection must never block a merge. */
    async newFeedbackThreads(mrIid) {
      if (!deps.config.authors.length) return [];
      const discussions = await deps.discussions(mrIid);
      if (!discussions) return [];
      return actionableThreads(discussions, {
        authors: deps.config.authors,
        handled: deps.readLedger()?.handled ?? {},
      });
    },
  };
}
