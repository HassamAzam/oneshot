import type { FeedbackThread, MrDiscussion } from './types.js';

/**
 * Stamped on every reply Oneshot posts.
 *
 * Authorship cannot tell a bot reply from a human one: the desk acts through
 * its operator's own GitLab token, and that operator is often a listed
 * reviewer. The marker can.
 */
export const REPLY_MARKER = '<!-- oneshot:mr-feedback -->';

/**
 * The threads that need an answer, carrying only trusted reviewers' notes.
 *
 * Untrusted notes are removed here, in code, rather than labelled for the
 * model: an MR comment is input to a session that can push to the branch.
 */
export function actionableThreads(
  discussions: MrDiscussion[],
  opts: { authors: string[]; handled: Record<string, number> },
): FeedbackThread[] {
  const allowed = new Set(opts.authors);
  const out: FeedbackThread[] = [];
  for (const d of discussions) {
    if (!d.notes.some((n) => n.resolvable && !n.resolved)) continue;
    const trusted = d.notes.filter((n) =>
      !n.system && !n.body.includes(REPLY_MARKER) && allowed.has(n.author.username));
    if (!trusted.length) continue;
    const lastNoteId = Math.max(...trusted.map((n) => n.id));
    if (lastNoteId <= (opts.handled[d.id] ?? 0)) continue;
    const pos = d.notes.find((n) => n.position)?.position ?? null;
    out.push({
      discussionId: d.id,
      file: pos?.new_path ?? pos?.old_path ?? null,
      line: pos?.new_line ?? pos?.old_line ?? null,
      notes: trusted.map((n) => ({ id: n.id, author: n.author.username, body: n.body })),
      lastNoteId,
    });
  }
  return out;
}
