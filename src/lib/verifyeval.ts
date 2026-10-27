/**
 * The check that verify.json is internally honest: every case it reports is a
 * real case from testcases.json, and every `pre-existing` label — the one
 * verdict that walks a failing case past both the verify cycle and the merge
 * gate — carries the evidence and screenshot that make the claim checkable.
 *
 * Deterministic: no judge. It runs on verify's own output, the pinned
 * testcases.json, and the screenshot files on disk.
 *
 * Two findings, two resolutions, because they are not the same kind of wrong:
 *
 *   - An ORPHAN id (in verify.json, not in testcases.json) cannot be re-run —
 *     there is no such case to run. It is salvage left over from a descope:
 *     #259 descoped TC-15 into testcases.json's `descoped` list, verify kept
 *     reporting TC-15 as a `fail`, and the merge gate blocked on a case the
 *     plan had retired. So an orphan is DROPPED from verify.json here; the
 *     conductor does it, no model lap, and records which ids went.
 *   - A `pre-existing` label with no evidence or a missing screenshot IS a real
 *     case, so it is handed back to a scoped verify re-run — only those cases,
 *     with the finding as feedback — to capture the proof or downgrade to
 *     `fail`.
 *
 * The record belongs to the ticket, at state/runs/<iid>/verify-eval.json, one
 * round per grade: round 0 is the first read (with any orphans it dropped),
 * round 1 is after the single scoped re-run. The last round carries
 * `unresolved` when issues still stand — the eval never blocks and never forces
 * `implement`, it records what it could not fix and lets the run continue.
 */

export const VERIFY_EVAL_RECORD = 'verify-eval.json';

/** Scoped re-runs one verify output may cost to resolve its findings. One. */
export const MAX_VERIFY_EVAL_RETRIES = 1;

export type VerifyIssueKind = 'orphan-id' | 'no-evidence' | 'no-screenshot';

export interface VerifyEvalIssue {
  id: string;
  kind: VerifyIssueKind;
  detail: string;
}

export interface VerifyEvalRound {
  at: string;
  /** 0 = the first read, 1 = after the scoped re-run. */
  attempt: number;
  /** Orphan ids this round removed from verify.json. */
  droppedOrphans: string[];
  /** Findings still open after this round's repairs. */
  issues: VerifyEvalIssue[];
  pass: boolean;
  /** Set on the final round when issues remain and the run carries on regardless. */
  unresolved: boolean;
}

export interface VerifyEvalRecord {
  iid: number;
  rounds: VerifyEvalRound[];
}

/** The shape of a verify result this check reads — a loose view of CaseResult. */
export interface CaseLike {
  id?: unknown;
  result?: unknown;
  evidence?: unknown;
  screenshot?: unknown;
}

const asId = (v: unknown): string => (typeof v === 'string' ? v : '');
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The ids a verify run reported that testcases.json does not list. Null
 * `testcaseIds` — no testcases.json to reconcile against, as on runs written
 * before it existed — means no id can be called an orphan, so none are.
 */
export function orphanIds(
  results: readonly CaseLike[], testcaseIds: ReadonlySet<string> | null,
): string[] {
  if (!testcaseIds) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    const id = asId(r.id);
    if (id && !testcaseIds.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** verify's results with every orphan id removed. Pure — the caller writes it back. */
export function dropOrphans<T extends CaseLike>(
  results: readonly T[], testcaseIds: ReadonlySet<string> | null,
): T[] {
  if (!testcaseIds) return [...results];
  return results.filter((r) => {
    const id = asId(r.id);
    return !id || testcaseIds.has(id);
  });
}

/**
 * Pure: everything wrong with a verify output. An orphan id, and — for every
 * case labelled `pre-existing` — a missing evidence line or a screenshot that
 * is absent or not on disk. `pre-existing` is the only label checked for proof
 * because it is the only one that lets a failing case through unchallenged.
 */
export function gradeVerify(
  results: readonly CaseLike[],
  testcaseIds: ReadonlySet<string> | null,
  screenshotOnDisk: (file: string) => boolean,
): VerifyEvalIssue[] {
  const issues: VerifyEvalIssue[] = [];
  for (const id of orphanIds(results, testcaseIds)) {
    issues.push({ id, kind: 'orphan-id', detail: `${id} is reported in verify.json but is not a case in testcases.json` });
  }
  for (const r of results) {
    if (r.result !== 'pre-existing') continue;
    const id = asId(r.id) || '(unnamed)';
    if (!text(r.evidence)) {
      issues.push({ id, kind: 'no-evidence', detail: `${id} is labelled pre-existing with no evidence` });
    }
    const shot = text(r.screenshot);
    if (!shot) {
      issues.push({ id, kind: 'no-screenshot', detail: `${id} is labelled pre-existing with no screenshot` });
    } else if (!screenshotOnDisk(shot)) {
      issues.push({ id, kind: 'no-screenshot', detail: `${id} is labelled pre-existing but its screenshot ${shot} is not on disk` });
    }
  }
  return issues;
}

export function evalPasses(issues: readonly VerifyEvalIssue[]): boolean {
  return issues.length === 0;
}

/**
 * The case ids a scoped re-run can act on — the `pre-existing` findings only.
 * Orphan ids are dropped, not re-run, so they are never handed to a session.
 */
export function rerunnable(issues: readonly VerifyEvalIssue[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of issues) {
    if (i.kind === 'orphan-id') continue;
    if (!seen.has(i.id)) {
      seen.add(i.id);
      out.push(i.id);
    }
  }
  return out;
}

/** The feedback a scoped re-run is given: what each case must fix, worded for the prompt. */
export function feedbackNote(issues: readonly VerifyEvalIssue[]): string {
  const rerun = issues.filter((i) => i.kind !== 'orphan-id');
  const lines = rerun.map((i) => `- **${i.id}**: ${i.detail}`);
  return [
    'A deterministic check of your last run found `pre-existing` label(s) without the proof the '
    + 'label requires. A `pre-existing` verdict lets a failing case past the merge gate, so it must '
    + 'carry a one-line evidence of what the base branch does AND a screenshot file saved under '
    + 'artifacts/. Re-run ONLY the case(s) below and either:',
    '',
    '  1. capture that evidence and screenshot and keep the `pre-existing` label, or',
    '  2. if you cannot prove it on the base branch, record the case as `fail`.',
    '',
    ...lines,
  ].join('\n');
}

export function appendRound(
  record: VerifyEvalRecord | null, iid: number, round: VerifyEvalRound,
): VerifyEvalRecord {
  return { iid, rounds: [...(record?.rounds ?? []), round] };
}

export interface VerifyEvalTotals {
  tickets: number;
  rounds: number;
  passed: number;
  unresolved: number;
  orphansDropped: number;
  issuesOpen: number;
  noEvidence: number;
  noScreenshot: number;
}

export function summariseVerifyEval(records: readonly VerifyEvalRecord[]): VerifyEvalTotals {
  const rounds = records.flatMap((r) => r.rounds);
  const last = records.map((r) => r.rounds[r.rounds.length - 1]).filter((r): r is VerifyEvalRound => !!r);
  const open = last.flatMap((r) => r.issues);
  const count = (k: VerifyIssueKind): number => open.filter((i) => i.kind === k).length;
  return {
    tickets: records.length,
    rounds: rounds.length,
    passed: last.filter((r) => r.pass).length,
    unresolved: last.filter((r) => r.unresolved).length,
    orphansDropped: rounds.reduce((a, r) => a + r.droppedOrphans.length, 0),
    issuesOpen: open.length,
    noEvidence: count('no-evidence'),
    noScreenshot: count('no-screenshot'),
  };
}

export function formatVerifyEval(records: readonly VerifyEvalRecord[]): string[] {
  if (!records.length) return ['no verify-eval records'];
  const lines = records.map((rec) => {
    const last = rec.rounds[rec.rounds.length - 1];
    if (!last) return `#${rec.iid}  (no rounds)`;
    const verdict = last.pass ? 'PASS' : last.unresolved ? 'UNRESOLVED' : 'FAIL';
    const dropped = rec.rounds.flatMap((r) => r.droppedOrphans);
    const open = last.issues.map((i) => `${i.id} (${i.kind})`);
    return `#${rec.iid}  ${verdict}  ${rec.rounds.length} round(s)`
      + (dropped.length ? `  — dropped orphan(s): ${dropped.join(', ')}` : '')
      + (open.length ? `  — open: ${open.join(', ')}` : '');
  });
  const t = summariseVerifyEval(records);
  return [
    ...lines,
    '',
    `tickets ${t.tickets}  rounds ${t.rounds}  passed ${t.passed}/${t.tickets}  unresolved ${t.unresolved}`,
    `orphans dropped ${t.orphansDropped}  issues still open ${t.issuesOpen}: `
      + `no evidence ${t.noEvidence}, no screenshot ${t.noScreenshot}`,
  ];
}
