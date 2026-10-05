/**
 * The live outcome log: one row per finished run, appended by finish().
 *
 * It answers the one question an eval has to be judged by — does work reach a
 * person with a real failure still in it less often than it used to? — from
 * what every run already writes (run.json, verify.json, testcases.json,
 * findings.json). No model call: the row is a count of what the run recorded,
 * so it costs nothing and runs on every ticket.
 *
 * The log lives at $ONESHOT_HOME/evals/live/outcomes.jsonl, outside the
 * gitignored state/, so it can be committed and compared across desks. A run
 * that finishes more than once (parked at merge, then done) appends a row each
 * time; readers keep the last row per runId.
 *
 *   npm run eval:outcomes   weekly table, plus the gold-label check
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DRY_RUN, ONESHOT_HOME } from './config.js';
import { readArtifact, type RunJournal } from './artifacts.js';
import { log } from './log.js';
import { OVERRULED_PRE_EXISTING, TEST_PASSES, countsAsFailure, ticketScopeIds } from '../phases/types.js';

export const OUTCOMES_LOG = join(ONESHOT_HOME, 'evals', 'live', 'outcomes.jsonl');

/**
 * A 'fail' whose own evidence says the cause is not this change. Verify should
 * have answered 'pre-existing' with base-branch proof; answering 'fail' sends
 * the case back to implement, which cannot fix it.
 */
const NOT_THIS_CHANGE = /pre-?existing|untouched by (this|the) (diff|change)|not (introduced|caused) by (this|the) (diff|change)|does not address it/i;

interface CaseVerdict { id?: string; result?: string; evidence?: string }
interface VerifyArtifact { results?: CaseVerdict[]; regressions?: string[] }
interface TestcasesArtifact { cases?: Array<{ id?: unknown; pass?: unknown }>; passesEmpty?: string[] }
interface FindingsArtifact { verdict?: string; findings?: Array<{ severity?: string }> }

export interface OutcomeRow {
  at: number;
  runId: string;
  iid: number;
  url: string;
  status: RunJournal['status'];
  stoppedPhase?: string;
  /** An MR was opened: the work is in front of a person. */
  handedOff: boolean;
  implementLaps: number;
  verified: boolean;
  cases: { total: number; pass: number; fail: number; preExisting: number; blocked: number; skipped: number };
  /** Cases counted as this change's failure, by the merge gate's own rule. */
  failing: string[];
  regressions: number;
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
  reviewBlockers: number;
  /**
   * Test-design passes with no case and no passesEmpty note: a whole kind of
   * edge case the test list skipped without saying so.
   */
  passesMissing: string[];
  /** The headline: handed to a person with a failing case or a regression. */
  realFailureAtHandoff: boolean;
  backfill?: boolean;
}

export interface OutcomeInputs {
  verify: VerifyArtifact | null;
  testcases: TestcasesArtifact | null;
  findings: FindingsArtifact | null;
}

export function outcomeOf(journal: RunJournal, inputs: OutcomeInputs, at = Date.now()): OutcomeRow {
  const results = inputs.verify?.results ?? [];
  const tally = (r: string): number => results.filter((c) => c.result === r).length;
  const idOf = (c: CaseVerdict): string => c.id ?? '?';
  const failing = results.filter(countsAsFailure).map(idOf);
  const ownCases = ticketScopeIds(inputs.testcases?.cases ?? []);
  const regressions = (inputs.verify?.regressions ?? []).length;
  const handedOff = Boolean(journal.mrIid);
  return {
    at,
    runId: journal.runId,
    iid: journal.iid,
    url: journal.url,
    status: journal.status,
    stoppedPhase: journal.stoppedPhase,
    handedOff,
    implementLaps: journal.phases.filter((p) => p.phase === 'implement').length,
    verified: Boolean(inputs.verify),
    cases: {
      total: results.length,
      pass: tally('pass'),
      fail: tally('fail'),
      preExisting: tally('pre-existing'),
      blocked: tally('blocked'),
      skipped: tally('skipped'),
    },
    failing,
    regressions,
    failBlamedElsewhere: results
      .filter((c) => verifyLabel(c) === 'fail' && NOT_THIS_CHANGE.test(c.evidence ?? ''))
      .map(idOf),
    ownCaseDismissed: results
      .filter((c) => verifyLabel(c) === 'pre-existing' && ownCases.has(idOf(c)))
      .map(idOf),
    reviewBlockers: (inputs.findings?.findings ?? [])
      .filter((f) => f.severity === 'blocker' || f.severity === 'major').length,
    passesMissing: passesMissing(inputs.testcases),
    realFailureAtHandoff: handedOff && (failing.length > 0 || regressions > 0),
  };
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

/**
 * Empty when there is no test list yet: a run that never wrote one skipped
 * nothing. A passesEmpty note declares a pass only when it opens with that
 * pass's name, so a note that merely mentions "state" does not declare it.
 */
export function passesMissing(testcases: TestcasesArtifact | null): string[] {
  if (!testcases?.cases?.length) return [];
  const tagged = new Set(testcases.cases.flatMap((c) => (Array.isArray(c.pass) ? c.pass : [])));
  const notes = testcases.passesEmpty ?? [];
  const declared = (pass: string): boolean => notes.some((n) => new RegExp(`^[\\s\`'"*-]*${pass}\\b`, 'i').test(n));
  return TEST_PASSES.filter((p) => !tagged.has(p) && !declared(p));
}

export function outcomeInputs(iid: number): OutcomeInputs {
  return {
    verify: readArtifact<VerifyArtifact>(iid, 'verify.json'),
    testcases: readArtifact<TestcasesArtifact>(iid, 'testcases.json'),
    findings: readArtifact<FindingsArtifact>(iid, 'findings.json'),
  };
}

export function appendOutcome(row: OutcomeRow, path = OUTCOMES_LOG): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/**
 * Called from finish() on every terminal status. A dry run's journal is a
 * replay, not a ticket, so it is never counted; and a broken log must never
 * fail the run that is finishing.
 */
export function recordOutcome(journal: RunJournal): void {
  if (DRY_RUN) return;
  try {
    appendOutcome(outcomeOf(journal, outcomeInputs(journal.iid)));
  } catch (err) {
    log.warn(`#${journal.iid} outcome not recorded: ${(err as Error).message}`);
  }
}

/** The log, one row per run: the last row a run wrote is its final state. */
export function readOutcomes(path = OUTCOMES_LOG): OutcomeRow[] {
  if (!existsSync(path)) return [];
  const byRun = new Map<string, OutcomeRow>();
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line) as OutcomeRow;
      byRun.set(row.runId, row);
    } catch { /* a torn line is not a run */ }
  }
  return [...byRun.values()].sort((a, b) => a.at - b.at);
}
