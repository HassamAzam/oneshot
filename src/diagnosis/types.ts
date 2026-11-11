/**
 * What a diagnosis is, at each stage: as the session returns it, as it stands
 * once its citations have been checked, and as it is kept beside the run.
 */

/**
 * Whose problem a finding is. The four are the four different people who act:
 *
 *   harness      a defect in Oneshot itself. Fixed by a change to this repo.
 *   environment  the machine, an account, a credential, a service. Fixed by an
 *                operator, on the machine. self-remediation's `environment`,
 *                `provisioning`, `credentials` and `infrastructure` all land here.
 *   ticket       the ticket's own change is wrong or unfinished. Fixed by the
 *                pipeline, by going back through `implement`. self-remediation
 *                calls this `code`.
 *   human        nothing is broken: a decision is owed that only a person can make.
 */
export const CATEGORIES = ['harness', 'environment', 'ticket', 'human'] as const;
export type Category = typeof CATEGORIES[number];

/** Who makes the fix: a pull request on Oneshot, an operator, the pipeline itself, or a person deciding. */
export const FIX_BY = ['pr', 'operator', 'pipeline', 'person'] as const;
export type FixBy = typeof FIX_BY[number];

export const CONFIDENCE = ['confirmed', 'probable'] as const;
export type Confidence = typeof CONFIDENCE[number];

export interface Citation {
  /** Relative to the run directory, or `repo:<path>` for a file of this repository. */
  file: string;
  line: number;
  /** Text that appears there, verbatim. */
  quote: string;
}

export interface CheckedCitation extends Citation {
  ok: boolean;
  /** Why it failed, or how it was matched when the line had to be corrected. */
  note: string;
}

export interface Finding {
  id: string;
  title: string;
  category: Category;
  /** The attempts it explains, in words: "verify laps 0-5, ui-evidence lap 0". */
  phases: string;
  /** What the journal recorded for them, when that differs from the cause. */
  recorded: string;
  cause: string;
  evidence: Citation[];
  solution: string;
  /** Files or places the fix goes. */
  where: string[];
  fix: FixBy;
  confidence: Confidence;
  /**
   * The commit in the checkout the diagnosis read that already fixes this
   * cause, when there is one. A run is diagnosed against the code as it is
   * NOW, which may be ahead of the code the run used. Absent on a record written
   * before the field existed.
   */
  fixedBy?: string;
}

export interface CheckedFinding extends Omit<Finding, 'evidence'> {
  evidence: CheckedCitation[];
  /** At least one citation was found where the finding says it is. */
  evidenced: boolean;
}

/** The session's structured output: src/diagnosis/schema.ts. */
export interface SessionDiagnosis {
  summary: string;
  blocked?: string | null;
  headline: string;
  account: string;
  findings: Finding[];
  decisive: string;
  nextStep: string;
  resumeFrom: string;
}

export interface FixRecord {
  /**
   * `held` is an attempt that was interrupted before it could finish (a pause,
   * the usage limit, a shutdown): nothing was learned about the fix, so it is
   * not counted as an attempt and may be made again.
   */
  state: 'opened' | 'refused' | 'failed' | 'unavailable' | 'held';
  /** Why there is no pull request, when there is none. */
  why?: string;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  at: number;
  /** What the pipeline measured itself, never what a session claimed. */
  checks?: { typecheck: string; tests: string; hooks: string; redGreen: string };
  review?: { raised: number; upheld: number; refuted: number; fixed: number; rounds: number };
  note?: { id: number | null; postedAt: number } | null;
}

/** One stop of one run, and what became of diagnosing it. */
export interface StopDiagnosis {
  key: string;
  runId: string;
  iid: number;
  status: 'blocked' | 'parked';
  stoppedPhase: string;
  reason: string;
  trouble: string[];
  /**
   * `superseded`: the run moved on while the session was working, so the
   * diagnosis is kept and nothing was posted. `failed`: no session has produced
   * one yet, and `attempts` says how many tried.
   */
  state: 'diagnosed' | 'failed' | 'superseded';
  attempts: number;
  lastError?: string;
  lastAttemptAt: number;
  /** Sessions that ended through no fault of the stop (cancelled, usage limit, account notice) and were not counted. */
  free?: number;
  diagnosedAt?: number;
  model?: string;
  turns?: number;
  weighted?: number;
  headline?: string;
  account?: string;
  findings?: CheckedFinding[];
  decisive?: string;
  nextStep?: string;
  resumeFrom?: string;
  citations?: { checked: number; verified: number };
  /** How much was read to produce it, for the note's last line. */
  read?: { transcripts: number; transcriptBytes: number };
  /** The ticket note, once posted. `noteSkipped` says why there is none. */
  note?: { id: number | null; postedAt: number } | null;
  noteSkipped?: string;
  /** Times GitLab would not take the note. Past a handful, `noteSkipped` says so and it is left. */
  noteTries?: number;
  /** Fix pull requests, by finding id. */
  fixes?: Record<string, FixRecord>;
}

/** `state/runs/<iid>/diagnosis.json`: every stop of the run that was looked at, newest in `latest`. */
export interface DiagnosisFile {
  version: 1;
  iid: number;
  runId: string;
  latest: string | null;
  /** Sessions started for this run, whatever became of them: the next transcript's lap number. */
  sessions: number;
  stops: Record<string, StopDiagnosis>;
}
