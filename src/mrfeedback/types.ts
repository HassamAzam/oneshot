/**
 * Shapes shared by the MR review-feedback loop.
 *
 * Type-only, and the only thing the pure modules beside it import: that is what
 * keeps their unit tests from loading src/lib/config.ts, which resolves a GitLab
 * identity the moment it is imported.
 */

/** When a thread Oneshot answered is also marked resolved. */
export type ResolvePolicy = 'never' | 'fixed' | 'all';

export interface MrFeedbackConfig {
  enabled: boolean;
  resolve: ResolvePolicy;
  maxRounds: number;
  /** GitLab usernames whose MR comments are acted on. Everyone else is ignored. */
  authors: string[];
}

export interface MrNotePosition {
  new_path?: string | null;
  new_line?: number | null;
  old_path?: string | null;
  old_line?: number | null;
}

/** The subset of GitLab's MR discussions API this module reads. */
export interface MrNote {
  id: number;
  body: string;
  system?: boolean;
  resolvable: boolean;
  resolved: boolean;
  author: { username: string };
  created_at?: string;
  position?: MrNotePosition | null;
}

export interface MrDiscussion {
  id: string;
  individual_note?: boolean;
  notes: MrNote[];
}

/** One thread that needs an answer, with untrusted authors already stripped out. */
export interface FeedbackThread {
  discussionId: string;
  file: string | null;
  line: number | null;
  notes: Array<{ id: number; author: string; body: string }>;
  /** Highest trusted note id — becomes the thread's watermark once handled. */
  lastNoteId: number;
}

/** What the merge phase hands the runner when it finds new threads. */
export interface MrFeedbackSignal {
  mrIid: number;
  threads: FeedbackThread[];
}

export type Disposition = 'fix' | 'question' | 'decline' | 'already-done';

export interface TriageItem {
  /** MRF-01, MRF-02 … assigned by the conductor, not the model. */
  id: string;
  discussionId: string;
  disposition: Disposition;
  request: string;
  /** For 'fix': what to change. '' otherwise. */
  plan: string;
  /** For every other disposition: the reply to post. '' for 'fix'. */
  reply: string;
}

export interface AddressedFeedback {
  id: string;
  note: string;
}

export type RoundStatus = 'fixing' | 'replying' | 'done';

export interface FeedbackRound {
  n: number;
  mrIid: number;
  startedAt: number;
  status: RoundStatus;
  threads: FeedbackThread[];
  items: TriageItem[];
  addressed: AddressedFeedback[];
  /** Discussion ids already replied to — what makes answering safe to retry. */
  replied: string[];
  resolved: string[];
}

export interface MrFeedbackLedger {
  rounds: FeedbackRound[];
  /** discussionId → highest trusted note id already handled. */
  handled: Record<string, number>;
}
