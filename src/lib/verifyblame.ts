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

/**
 * A 'fail' whose own evidence says the cause is not this change. "not
 * pre-existing" is the opposite claim and must not match.
 */
const NOT_THIS_CHANGE = /(?<!not )pre-?existing|untouched by (this|the) (diff|change)|not (introduced|caused) by (this|the) (diff|change)|does not address it/i;

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
  return {
    failing: results.filter(countsAsFailure).map(idOf),
    failBlamedElsewhere: results
      .filter((c) => verifyLabel(c) === 'fail' && NOT_THIS_CHANGE.test(c.evidence ?? ''))
      .map(idOf),
    ownCaseDismissed: results
      .filter((c) => verifyLabel(c) === 'pre-existing' && ownCases.has(idOf(c)))
      .map(idOf),
  };
}
