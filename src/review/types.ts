/**
 * Shapes shared by the code-review loop: one session that raises findings as
 * threads on the merge request, and a separate one that answers them by fixing.
 *
 * Type-only, like src/mrfeedback/types.ts and for the same reason: the pure
 * modules beside it must be importable by a unit test without loading
 * src/lib/config.ts.
 */
import type { MrDiscussion } from '../mrfeedback/types.js';
import type { ReviewMarker, ReviewSeverity } from './markers.js';

/**
 * Where one thread stands. The first five are still open on GitLab or waiting
 * on the other session; the last three are finished.
 *
 *   open       raised (or reopened by a person) and not yet answered by the fixer
 *   fixed      the fixer fixed it and resolved the thread; not yet re-checked
 *   declined   the fixer declined a blocker/major; open, awaiting the reviewer's ruling
 *   reopened   the reviewer found the fix wrong; open again for the fixer
 *   disputed   declined by the fixer and upheld by the reviewer — a person decides
 *   accepted   the reviewer confirmed the fix
 *   withdrawn  the reviewer withdrew the finding
 *   closed     resolved with no fix: by a person on GitLab, or a non-blocking note the run closed
 */
export type ThreadStatus =
  | 'open' | 'fixed' | 'declined' | 'reopened' | 'disputed' | 'accepted' | 'withdrawn' | 'closed';

export interface HumanReply {
  noteId: number;
  author: string;
  body: string;
}

export interface ReviewThread {
  /** F-01, F-02 … unique within the run, and never reused for another finding. */
  id: string;
  /** Fixed when the thread is raised. A later lap may reopen a thread, never re-grade it. */
  severity: ReviewSeverity;
  file: string;
  line: number;
  what: string;
  why: string;
  fix: string;
  /** The reviewer lap that raised it. */
  raisedLap: number;
  /** Null until the thread exists on GitLab. */
  discussionId: string | null;
  /** The thread's first note: what a link to it points at. */
  noteId: number | null;
  /** True when it sits on a diff line rather than on the MR as a whole. */
  positioned: boolean;
  status: ThreadStatus;
  /** As this run last set it or saw it on GitLab. */
  resolved: boolean;
  /** The fixer's latest answer. */
  fixer?: { lap: number; action: 'fixed' | 'declined'; reply: string; commit: string };
  /** The reviewer's latest reason for reopening or standing by it. */
  reviewerNote?: string;
  /** A trusted person's replies the fixer has not acted on yet. */
  human?: HumanReply[];
  /** Highest note id on the thread already accounted for — ours, or a person's the fixer has seen. */
  lastNoteId?: number;
}

/** One write to GitLab, decided but not yet confirmed. Replayed until it lands. */
export type ThreadWrite =
  | { op: 'create'; finding: string }
  | {
    op: 'reply'; finding: string; marker: ReviewMarker; body: string;
    then: 'resolve' | 'unresolve' | 'none';
  };

export interface DroppedFinding {
  lap: number;
  severity: string;
  file: string;
  line: number;
  what: string;
  /** Why the conductor did not post it. */
  reason: string;
}

/**
 * The review loop's own state, kept in state/runs/<iid>/review-threads.json.
 *
 * GitLab owns whether a thread is open; this owns what the run has decided and
 * not yet managed to say there (`pending`), which head the reviewer last read,
 * and what each session answered. Delete it and the open threads are adopted
 * back off the MR by their markers — the merge gate never reads this file.
 */
export interface ReviewLedger {
  version: 1;
  runId: string;
  mrIid: number;
  /** The head the reviewer last read: in full the first time, as a re-check after. */
  reviewedSha: string | null;
  /** The fixer acted since the reviewer last looked. */
  recheckOwed: boolean;
  threads: ReviewThread[];
  pending: ThreadWrite[];
  /** New findings a re-check raised that it was not entitled to. Kept for the record, never posted. */
  dropped: DroppedFinding[];
  /** The reviewer lap that last ran, for the marker on a note the run posts between laps. */
  reviewLap?: number;
  /**
   * The fixer committed and the branch has not been pushed since. Set before
   * its replies are queued, cleared by the push: a reply that says "Fixed in
   * <sha>" must never land ahead of the commit it names.
   */
  pushOwed?: boolean;
  /** The set of open threads the last "needs a person" note listed, so it is posted once per set. */
  parkNoted?: string;
}

/** A finding as the reviewer session returns it (FINDINGS_SCHEMA). */
export interface RawFinding {
  id?: unknown;
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  what?: unknown;
  why?: unknown;
  fix?: unknown;
}

export type Ruling = 'accepted' | 'reopen' | 'withdrawn' | 'stands';

export interface ReviewerOutput {
  summary?: unknown;
  verdict?: unknown;
  findings?: unknown;
  /** Re-check laps only: one ruling per thread the reviewer was shown. */
  threads?: unknown;
}

export interface FixerOutput {
  summary?: unknown;
  /** One answer per thread the fixer was handed. */
  threads?: unknown;
  commits?: unknown;
  filesChanged?: unknown;
}

/** What the reviewer's prompt is built from. */
export interface ReviewPromptInput {
  /** False: read the whole change. True: rule on the threads and read only what changed since. */
  recheck: boolean;
  mrIid: number;
  /** The head the previous review read; the re-check's diff starts here. Null on a first review. */
  sinceSha: string | null;
  headSha: string;
  /** Files changed since `sinceSha`, or null when git could not say. */
  changedFiles: string[] | null;
  /** Every thread of the run, so a re-check can rule on them and a first review does not repeat one. */
  threads: ReviewThread[];
}

/** What the fixer's prompt is built from. */
export interface FixPromptInput {
  mrIid: number;
  headSha: string;
  /** The threads this lap is to answer. */
  threads: ReviewThread[];
  /** 1-based, and the cap, so the session knows whether another lap can follow. */
  lap: number;
  maxLaps: number;
}

/** What the loop asks of GitLab. Injected, so the loop is tested without it. */
export interface ReviewApi {
  /** Every discussion on the MR, or null when GitLab could not be read. */
  discussions(): Promise<MrDiscussion[] | null>;
  /**
   * Open a thread at `file:line`: on the diff line when GitLab will take it
   * there, on the MR as a whole otherwise. `body` is asked for the note text
   * once the placement is known, because an unpositioned note has to carry the
   * location itself.
   */
  createThread(at: { file: string; line: number }, body: (positioned: boolean) => string): Promise<
    { discussionId: string; noteId: number; positioned: boolean } | null
  >;
  reply(discussionId: string, body: string): Promise<{ noteId: number } | 'gone' | null>;
  setResolved(discussionId: string, resolved: boolean): Promise<'ok' | 'gone' | 'failed'>;
}
