/**
 * The readiness verdict the Ready For Automation mode acts on, as TypeScript.
 *
 * The verdict itself is made by hooks/automation-ready.cjs — dependency-free
 * CJS that the conductor runs through runGuard (runAutomationReadyGuard)
 * before every session, before a version is posted and before the sheet
 * write. One implementation is the point: a second copy of "is this ticket
 * ready" would drift. This module only declares the shape that file prints
 * under `automationReadiness` and reads it back out of whatever runGuard
 * resolved.
 *
 * Pure: no I/O, no config.
 */

/** The on-demand phase this mode runs. The hook duplicates this string (it is dependency-free); a test pins them equal. */
export const AUTOMATION_PHASE = 'automation-testcases';

/** One merge request GitLab links to the ticket, as the hook reports it. */
export interface MrRef {
  iid: number;
  title: string;
  source: string;
  target: string;
  state: 'opened' | 'merged' | 'closed' | 'locked';
  mergedAt: string | null;
  url: string;
}

export type ReasonCode = 'loop-missing' | 'rfa-missing' | 'rfd-order' | 'mr-not-merged';

export interface ReadinessReason {
  code: ReasonCode;
  /** One sentence for the ticket: what is missing. */
  text: string;
  /** One sentence for the ticket: how to fix it. */
  fix: string;
  /** Stable facts only — the fingerprint input. E.g. 'absent', '!400:opened'. (Invented numbers: no real MR numbers in src.) */
  detail: string;
}

export type ReadinessErrorKind = 'auth' | 'notfound' | 'server' | 'network' | 'config' | 'too-many' | 'other';

export interface Readiness {
  v: 1;
  verdict: 'ready' | 'not-ready' | 'unknown';
  iid: number;
  /** ISO. */
  checkedAt: string;
  issueUpdatedAt: string | null;
  state: 'opened' | 'closed' | null;
  /** The latest trigger-label ADD event, or null when there is none on record. */
  triggerAddedAt: string | null;
  /** [] when ready or unknown. The entry label's reason (if any) comes first, then rule A's, then rule B's. */
  reasons: ReadinessReason[];
  /** E.g. '!400 is still open — it is not what shipped, and is ignored'. */
  warnings: string[];
  /** Qualifying merged MRs: same project, not a branch promotion. */
  merged: MrRef[];
  /** Same-project, non-promotion MRs that are still open. */
  open: MrRef[];
  /** not-ready only; 12 hex. Same facts, same fingerprint, so a note is never posted twice. */
  fingerprint: string | null;
  /** unknown only. */
  error?: string;
  /** unknown only; 'auth' makes the runner alert once per process, because a bad token never heals by waiting. */
  errorKind?: ReadinessErrorKind;
}

const VERDICTS = new Set(['ready', 'not-ready', 'unknown']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Well formed enough to act on: the fields every caller reads have their types.
 * Anything short of that is not a verdict, and a check that did not produce a
 * verdict must hold rather than guess.
 */
function isReadiness(v: unknown): v is Readiness {
  if (!isRecord(v)) return false;
  return v.v === 1
    && typeof v.verdict === 'string' && VERDICTS.has(v.verdict)
    && typeof v.iid === 'number'
    && typeof v.checkedAt === 'string'
    && Array.isArray(v.reasons)
    && Array.isArray(v.warnings)
    && Array.isArray(v.merged)
    && Array.isArray(v.open);
}

/** The words a guard payload blocked with, whichever event's shape it is in. */
function payloadReason(out: Record<string, unknown>): string | null {
  if (typeof out.reason === 'string' && out.reason) return out.reason;
  const hso = out.hookSpecificOutput;
  if (isRecord(hso) && typeof hso.permissionDecisionReason === 'string' && hso.permissionDecisionReason) {
    return hso.permissionDecisionReason;
  }
  return null;
}

/**
 * Read the hook's stdout object (what runGuard resolved) into a Readiness.
 * - `automationReadiness` present and well formed → returned as is.
 * - otherwise (`{}` from a script that did not run, `{ reason }`, garbage) → verdict 'unknown',
 *   errorKind 'other', error = reason ?? 'the readiness hook gave no verdict'.
 * A verdict about a different ticket than `iid` is not a verdict about this one,
 * so it reads as unknown too.
 * Never throws.
 */
export function readinessFromHookOutput(out: Record<string, unknown>, iid: number): Readiness {
  const unknown = (error: string): Readiness => ({
    v: 1,
    verdict: 'unknown',
    iid,
    checkedAt: new Date().toISOString(),
    issueUpdatedAt: null,
    state: null,
    triggerAddedAt: null,
    reasons: [],
    warnings: [],
    merged: [],
    open: [],
    fingerprint: null,
    error,
    errorKind: 'other',
  });
  try {
    if (!isRecord(out)) return unknown('the readiness hook gave no verdict');
    const r = out.automationReadiness;
    if (isReadiness(r)) {
      if (r.iid !== iid) return unknown(`the readiness hook answered for #${r.iid}, not #${iid}`);
      return r;
    }
    return unknown(payloadReason(out) ?? 'the readiness hook gave no verdict');
  } catch {
    return unknown('the readiness hook gave no verdict');
  }
}

/**
 * The switch labels this verdict says are missing, by name, in reason order:
 * the Loop's entry label (`loop-missing`) and the trigger (`rfa-missing`).
 * Non-empty means the request was WITHDRAWN, not left unmet — a person took a
 * label off, or never put `Loop` on — so there is nothing to "fix" on the
 * ticket: the runner stops silently instead of posting a note, and keeps the
 * journal for when the label comes back.
 */
export function withdrawnLabels(r: Readiness, names: { loop: string; trigger: string }): string[] {
  const out: string[] = [];
  for (const x of r.reasons) {
    if (x.code === 'loop-missing') out.push(names.loop);
    else if (x.code === 'rfa-missing') out.push(names.trigger);
  }
  return out;
}
