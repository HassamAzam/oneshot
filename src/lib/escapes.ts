/**
 * Did a human find a defect in what Oneshot shipped?
 *
 * The one outcome question the pipeline cannot answer about itself. Every other
 * eval grades an artifact against a rubric; this grades the ticket against a
 * person who went and used the product afterwards.
 *
 * READ OFF THE BOARD, NOT OUT OF THE COMMENTS. A first design parsed QA's
 * `Issue no.N:` comments, which would have meant inventing a reporting format
 * and depending on everyone using it. The board already carries the facts in
 * structured form: `Merged` when the MR lands, `QA Issues` when manual testing
 * finds something, `Ready For Deployment` when QA signs off. Those are labels a
 * person moves as part of the job they already do, so the signal needs no new
 * discipline and cannot drift out of sync with the real verdict.
 *
 * THE WINDOW IS [Merged, Ready For Deployment]. It opens at the LAST merge
 * because a defect reported before it is not an escape from shipped code, and it
 * closes at sign-off because that is the moment QA says the change is good — the
 * one boundary that means "we are done looking".
 *
 * FOUR THINGS IT REFUSES TO GUESS, each excluded from the rate and each counted
 * so the gap is visible. A measurement that hides its own blind spots is worse
 * than no measurement, and every one of these, guessed, would flatter the
 * pipeline:
 *
 *  - `open` — testing has not finished. Counting it clean would read "nobody has
 *    finished looking" as "nobody found anything".
 *  - `indeterminate` — a `QA Issues` flag was already set when the merge landed
 *    and was never cleared, so GitLab recorded no new event and a second finding
 *    would be invisible. The board cannot answer, so neither does this.
 *  - `not-shipped` — the journal says it merged but the board never recorded it,
 *    or recorded it and then undid it. Not measurable, and not silently absent.
 *  - unreadable — see lib/escapecollect.ts.
 */

/** One label add/remove, as `resource_label_events` reports it. */
export interface LabelEvent {
  at: number;
  action: 'add' | 'remove';
  label: string;
  by: string | null;
}

/** Board labels this reads. Names, not ids: ids differ per project and say nothing. */
export interface BoardLabels {
  merged: string;
  qaIssues: string;
  readyForDeployment: string;
}

export const DEFAULT_BOARD_LABELS: BoardLabels = {
  merged: 'Merged',
  qaIssues: 'QA Issues',
  readyForDeployment: 'Ready For Deployment',
};

export type EscapeVerdict = 'not-shipped' | 'open' | 'clean' | 'escaped' | 'indeterminate';

export interface EscapeRecord {
  verdict: EscapeVerdict;
  /** Oneshot's merge — the window's opening edge. */
  openedAt: number | null;
  /** QA's sign-off — the closing edge. Null while the window is still open. */
  closedAt: number | null;
  /**
   * Each time QA flagged defects inside the window. More than one means the
   * first fix did not settle it, which is a different and worse story than one
   * round, so they are kept rather than collapsed to a boolean.
   */
  rounds: Array<{ at: number; by: string | null }>;
  /**
   * Sign-off was given and then taken away again. The window is still treated
   * as closed at the first sign-off — moving the edge would let a ticket be
   * re-opened indefinitely and never settle — but a reader needs to know the
   * verdict was later disputed.
   */
  signOffWithdrawn: boolean;
  /** Set on `indeterminate` and on `not-shipped`: why the board cannot answer. */
  why?: string;
}

/**
 * Fold a ticket's label history into one record.
 *
 * Pure, so the awkward cases are testable without a network: events arriving
 * out of order, a label added twice, sign-off withdrawn, a ticket that never
 * shipped at all.
 */
export function escapeRecord(
  events: readonly LabelEvent[],
  labels: BoardLabels = DEFAULT_BOARD_LABELS,
): EscapeRecord {
  // `resource_label_events` is documented as ascending but paginates, and a
  // caller that concatenates pages in the wrong order would otherwise produce a
  // window that silently contains nothing.
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const firstAdd = (label: string, after = -Infinity): LabelEvent | null =>
    sorted.find((e) => e.action === 'add' && e.label === label && e.at >= after) ?? null;
  const lastOf = (label: string, action: 'add' | 'remove'): LabelEvent | null =>
    [...sorted].reverse().find((e) => e.action === action && e.label === label) ?? null;

  // The LAST merge, not the first. A ticket merged, reverted and re-merged
  // would otherwise open its window at the abandoned attempt: findings against
  // that attempt would be charged to the re-merge, and the window's duration
  // would be wrong by however long the revert took.
  const merged = lastOf(labels.merged, 'add');
  const unmerged = lastOf(labels.merged, 'remove');
  if (!merged) {
    return {
      verdict: 'not-shipped', openedAt: null, closedAt: null, rounds: [], signOffWithdrawn: false,
      why: 'the board never recorded a merge',
    };
  }
  if (unmerged && unmerged.at > merged.at) {
    // The board says the merge was undone. Whatever the journal recorded, this
    // is not shipped code for QA to have found anything in.
    return {
      verdict: 'not-shipped', openedAt: null, closedAt: null, rounds: [], signOffWithdrawn: false,
      why: 'the merge was undone after it landed',
    };
  }

  const signOff = firstAdd(labels.readyForDeployment, merged.at);
  const closedAt = signOff?.at ?? null;
  const withdrawn = !!signOff && sorted.some(
    (e) => e.action === 'remove' && e.label === labels.readyForDeployment && e.at > signOff.at,
  );

  // Inside the window, inclusive of both edges: QA flagging defects in the same
  // minute as the merge is still a finding against the merged code, and a flag
  // landing exactly at sign-off is a finding, not a sign-off.
  const inWindow = (e: LabelEvent): boolean =>
    e.at >= merged.at && (closedAt === null || e.at <= closedAt);
  const rounds = sorted
    .filter((e) => e.action === 'add' && e.label === labels.qaIssues && inWindow(e))
    .map((e) => ({ at: e.at, by: e.by }));

  if (rounds.length) {
    return { verdict: 'escaped', openedAt: merged.at, closedAt, rounds, signOffWithdrawn: withdrawn };
  }
  if (closedAt === null) {
    return { verdict: 'open', openedAt: merged.at, closedAt, rounds, signOffWithdrawn: withdrawn };
  }

  // THE BLIND SPOT, reported rather than guessed. GitLab records a label
  // CHANGE, so a `QA Issues` flag already on when the merge landed fires no new
  // `add` event — and if QA then find a second defect there is nothing in the
  // history to see. Reporting `clean` there would be a silent false negative in
  // the one direction that flatters the pipeline, which is the failure this
  // whole eval is built to avoid.
  //
  // It is only blind while the flag stays on: their board cycles it (the bot
  // removes `QA Issues` when a fix comes back for retest), so a remove inside
  // the window means the state was reset and a later finding would have been
  // visible as a fresh add.
  const onAtOpen = sorted
    .filter((e) => e.label === labels.qaIssues && e.at <= merged.at)
    .at(-1)?.action === 'add';
  const resetInWindow = sorted.some(
    (e) => e.action === 'remove' && e.label === labels.qaIssues && inWindow(e),
  );
  if (onAtOpen && !resetInWindow) {
    return {
      verdict: 'indeterminate', openedAt: merged.at, closedAt, rounds, signOffWithdrawn: withdrawn,
      why: 'QA Issues was already set when the merge landed and was never cleared, '
        + 'so a later finding would have raised no new label event',
    };
  }
  return { verdict: 'clean', openedAt: merged.at, closedAt, rounds, signOffWithdrawn: withdrawn };
}

/**
 * The headline metric: the share of SETTLED shipped tickets that escaped.
 *
 * A rate rather than a mean, because one ticket with six findings would drag a
 * mean around and say nothing about how often the pipeline ships a defect.
 * `open` and `indeterminate` tickets are excluded from both halves: the first
 * because testing has not finished, the second because the board cannot say.
 * Both are counted and returned so a caller reports them beside the rate —
 * silently dropping either would shrink the denominator with no trace.
 */
export function escapeRate(records: readonly EscapeRecord[]): {
  settled: number; escaped: number; open: number; indeterminate: number;
  notShipped: number; rate: number | null;
} {
  const settled = records.filter((r) => r.verdict === 'clean' || r.verdict === 'escaped');
  const escaped = settled.filter((r) => r.verdict === 'escaped').length;
  return {
    settled: settled.length,
    escaped,
    open: records.filter((r) => r.verdict === 'open').length,
    indeterminate: records.filter((r) => r.verdict === 'indeterminate').length,
    // Shipped per the journal, but the board never recorded the merge. Counted
    // so the gap is visible: these are tickets the eval cannot measure, and a
    // measurement that hides its own blind spots is worse than no measurement.
    notShipped: records.filter((r) => r.verdict === 'not-shipped').length,
    // Null, not 0, below the point where a percentage is honest. Two tickets
    // cannot produce a 50% escape rate worth reporting, and a number on a chart
    // outlives the caveat that was said beside it.
    rate: settled.length >= MIN_FOR_RATE ? escaped / settled.length : null,
  };
}

/**
 * Below this a percentage is noise dressed as a measurement. Twelve settled
 * tickets moves one ticket by about 8 points, which is the coarsest resolution
 * worth putting in front of anyone.
 */
export const MIN_FOR_RATE = 12;
