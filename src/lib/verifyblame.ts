/**
 * What verify said about each failing case, read back from verify.json.
 *
 * The failure this serves: verify reports failing cases that implement cannot
 * fix within two laps, so the run blocks at verify with an MR already open.
 * Twice last week the case verify called a 'fail' was one this change had not
 * caused — a pre-existing defect it should have labelled 'pre-existing' with
 * base-branch proof. Answering 'fail' sends the case back to implement, which
 * cannot fix it, and the run burns its laps and blocks.
 *
 *   npm run eval:causes   grade verify's labels against hand-labelled causes
 */
import { OVERRULED_PRE_EXISTING, countsAsFailure, ticketScopeIds } from '../phases/types.js';
import type { FailureItem } from './failuremodes.js';

/**
 * A 'fail' whose own evidence says the cause is not this change. "not
 * pre-existing" is the opposite claim and must not match. "pre-existing"
 * counts only as a claim about the failure — ending a clause or naming a
 * defect — never as an adjective on data ("a pre-existing MailTemplate row"),
 * which describes the state this change ran against, not who caused the fail.
 */
const NOT_THIS_CHANGE = /(?<!not )pre-?existing(?=\s*(?:[.,;:)]|$|and\b|on\b|in\b|(?:bug|defect|issue|failure|problem|error|crash|behaviou?r|noise)\b))|untouched by (this|the) (diff|change)|not (introduced|caused) by (this|the) (diff|change)|does not address it/i;

export interface CaseVerdict { id?: string; result?: string; evidence?: string }
export interface VerifyArtifact { results?: CaseVerdict[]; regressions?: string[] }
export interface TestcasesArtifact { cases?: Array<{ id?: unknown; pass?: unknown }> }

export interface Blame {
  /** Cases counted as this change's failure, by the merge gate's own rule. */
  failing: string[];
  /**
   * Verify's own 'fail' verdicts whose evidence blames something other than
   * this change. A 'pre-existing' label the base check overruled is not one.
   */
  failBlamedElsewhere: string[];
  /**
   * Verify's own 'pre-existing' labels on the ticket's own acceptance cases.
   * The base check always refuses these, so they are read from the label
   * verify gave, not the 'fail' the case was rescored to.
   */
  ownCaseDismissed: string[];
  /**
   * Failing verdicts for cases that no longer exist in testcases.json. A case
   * dropped from the list (descoped, or rewritten under a new id) can survive
   * in a salvaged verify.json and keep blocking the run, so the fail is stale
   * by construction. Empty when testcases.json is unavailable, since absence
   * cannot be told from a missing file.
   */
  orphanedFailures: string[];
}

function caseIds(testcases: TestcasesArtifact | null): Set<string> | null {
  const cases = testcases?.cases;
  if (!cases) return null;
  return new Set(cases.map((c) => (typeof c.id === 'string' ? c.id : '?')));
}

/**
 * The label verify itself gave a case. verify.json is written after the base
 * check, which rescores a refused 'pre-existing' as 'fail'; that fail is the
 * conductor's verdict, not verify's.
 */
export function verifyLabel(c: CaseVerdict): string | undefined {
  if (c.result === 'fail' && (c.evidence ?? '').startsWith(OVERRULED_PRE_EXISTING)) return 'pre-existing';
  return c.result;
}

export function blameOf(verify: VerifyArtifact | null, testcases: TestcasesArtifact | null): Blame {
  const results = verify?.results ?? [];
  const idOf = (c: CaseVerdict): string => c.id ?? '?';
  const ownCases = ticketScopeIds(testcases?.cases ?? []);
  const present = caseIds(testcases);
  return {
    failing: results.filter(countsAsFailure).map(idOf),
    failBlamedElsewhere: results
      .filter((c) => verifyLabel(c) === 'fail' && NOT_THIS_CHANGE.test(c.evidence ?? ''))
      .map(idOf),
    ownCaseDismissed: results
      .filter((c) => verifyLabel(c) === 'pre-existing' && ownCases.has(idOf(c)))
      .map(idOf),
    orphanedFailures: present === null ? []
      : results.filter(countsAsFailure).map(idOf).filter((id) => !present.has(id)),
  };
}

/**
 * The failure modes that can be read from verify's own output with no gold
 * labels — the gold-free subset of the eval:causes diagnosis. Each mode here
 * flags a failing case that may not be implement's to fix: a pre-existing fail
 * blamed on the diff, the ticket's own case wrongly dismissed, or a stale case
 * surviving in a salvaged verify.json. `where` is the location prefix each item
 * is tagged with, e.g. '#8792'. Shared so eval:causes and the live implement
 * lap diagnose the same way.
 */
export function blameFailureModes(blame: Blame, where: string): FailureItem[] {
  const items: FailureItem[] = [];
  for (const id of blame.ownCaseDismissed) items.push({ mode: 'own-case-dismissed', label: "verify dismissed the ticket's own acceptance case (defect hidden)", severity: 'critical', where: `${where} ${id}` });
  for (const id of blame.failBlamedElsewhere) items.push({ mode: 'blamed-elsewhere', label: 'a fail was blamed on code outside the diff', severity: 'high', where: `${where} ${id}` });
  for (const id of blame.orphanedFailures) items.push({ mode: 'orphaned-fail', label: 'failing case is not in testcases.json (stale, salvaged)', severity: 'medium', where: `${where} ${id}` });
  return items;
}
