import { REPLY_MARKER } from './threads.js';
import type { FeedbackRound, ResolvePolicy } from './types.js';

export interface ResponseAction {
  discussionId: string;
  body: string;
  resolve: boolean;
  /** False when something in the thread is still owed — its watermark must not advance. */
  handled: boolean;
}

const ZWSP = '\u200B';

/**
 * Model-written text made inert before it is posted as a note.
 *
 * GitLab runs quick actions (`/merge`, `/approve`, `/label` …) found at the
 * start of a line in any note created through the API, under the operator's
 * token — so a triage reply could merge past qualityGate, the promotion window
 * and a Review ticket's human merge. A zero-width space directly before the
 * slash keeps the text reading the same while no line starts with a command;
 * the same character after `@` stops `@all` / `@user` from pinging anyone.
 */
function inertNoteText(text: string): string {
  return text
    .replace(/^([^\S\r\n]*)\//gm, `$1${ZWSP}/`)
    .replace(/@(?=\S)/g, `@${ZWSP}`);
}

/**
 * One reply per thread in the round, and whether the policy closes it.
 *
 * A fix that was not made is never resolved under any policy: resolving over
 * a known-open defect is the one outcome a reviewer cannot see coming.
 */
export function planResponses(
  round: FeedbackRound, opts: { headSha: string; policy: ResolvePolicy },
): ResponseAction[] {
  const addressed = new Map(round.addressed.map((a) => [a.id, a]));
  const footer = `\n\n_Oneshot · review round ${round.n} · verified at \`${opts.headSha.slice(0, 8)}\`_\n${REPLY_MARKER}`;

  return round.threads.map((t): ResponseAction => {
    const items = round.items.filter((i) => i.discussionId === t.discussionId);
    if (!items.length) {
      return {
        discussionId: t.discussionId,
        body: `Oneshot read this thread but reached no decision on it; it will be picked up again.${footer}`,
        resolve: false,
        handled: false,
      };
    }

    let unaddressed = false;
    const lines = items.map((i) => {
      if (i.disposition !== 'fix') return inertNoteText(i.reply.trim()) || 'Read — no change made.';
      const done = addressed.get(i.id);
      if (done) return `Addressed: ${inertNoteText(done.note.trim())}`;
      unaddressed = true;
      return `Not addressed yet: ${inertNoteText(i.request.trim())}`;
    });

    const onlyFixes = items.every((i) => i.disposition === 'fix');
    const resolve = !unaddressed && (opts.policy === 'all' || (opts.policy === 'fixed' && onlyFixes));
    return { discussionId: t.discussionId, body: `${lines.join('\n\n')}${footer}`, resolve, handled: !unaddressed };
  });
}

export interface ResponseApi {
  reply(discussionId: string, body: string): Promise<boolean>;
  resolve(discussionId: string): Promise<boolean>;
}

/**
 * Post the plan, skipping what the round already records as done, so a merge
 * pass that dies halfway never double-posts on retry.
 */
export async function executeResponses(
  round: FeedbackRound, actions: ResponseAction[], api: ResponseApi,
): Promise<{ replied: string[]; resolved: string[]; failures: string[] }> {
  const replied: string[] = [];
  const resolved: string[] = [];
  const failures: string[] = [];
  for (const a of actions) {
    if (!round.replied.includes(a.discussionId)) {
      if (!await api.reply(a.discussionId, a.body)) {
        failures.push(`reply to ${a.discussionId}`);
        continue;
      }
      replied.push(a.discussionId);
    }
    if (a.resolve && !round.resolved.includes(a.discussionId)) {
      if (await api.resolve(a.discussionId)) resolved.push(a.discussionId);
      else failures.push(`resolve ${a.discussionId}`);
    }
  }
  return { replied, resolved, failures };
}
