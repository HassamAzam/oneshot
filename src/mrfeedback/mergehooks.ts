import { activeRound, completeRound, markReplied, markResolved } from './ledger.js';
import { executeResponses, planResponses } from './respond.js';
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
  reply(mrIid: number, discussionId: string, body: string): Promise<boolean>;
  resolve(mrIid: number, discussionId: string): Promise<boolean>;
}

export type RespondOutcome =
  | { kind: 'none' }
  | { kind: 'done'; replied: number; resolved: number }
  | { kind: 'retry-later'; why: string };

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

      const sha = await deps.headSha(mrIid);
      if (!sha) return { kind: 'retry-later', why: `cannot read the head of !${mrIid} to cite in review replies` };

      const actions = planResponses(round, { headSha: sha, policy: deps.config.resolve });
      const result = await executeResponses(round, actions, {
        reply: (id, body) => deps.reply(mrIid, id, body),
        resolve: (id) => deps.resolve(mrIid, id),
      });

      let next: MrFeedbackLedger = ledger;
      for (const id of result.replied) next = markReplied(next, id);
      for (const id of result.resolved) next = markResolved(next, id);
      if (result.failures.length) {
        deps.writeLedger(next);
        return {
          kind: 'retry-later',
          why: `could not finish answering review threads on !${mrIid}: ${result.failures.join('; ')}`,
        };
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
