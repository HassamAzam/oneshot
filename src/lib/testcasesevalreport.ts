/**
 * The live test-case evaluation, summed over every ticket that ran it: how
 * often a first list passed, how much of each ticket the first and the kept
 * lists covered, how often a retry improved the list, what is still open, and
 * what the judge and the retries cost.
 *
 * Coverage is pooled — requirements covered over requirements, across tickets —
 * so a ticket with nine requirements weighs more than one with two.
 */
import {
  coveredIds, scoreOf, type EvalRecord, type EvalScore, type FinalOutcome, type ReviewOutcome, type StopReason,
} from './testcaseseval.js';

export interface ReportRow {
  iid: number;
  /** `open` is a loop a stopped conductor left unfinished. */
  status: FinalOutcome['status'] | 'open';
  stopReason: StopReason | null;
  score: EvalScore | null;
  review?: ReviewOutcome;
}

export interface ReportTotals {
  tickets: number;
  byStatus: Record<string, number>;
  byStop: Record<string, number>;
  requirements: number;
  firstCovered: number;
  keptCovered: number;
  passedFirstTime: number;
  retried: number;
  improved: number;
  retries: number;
  openCritical: number;
  openMajor: number;
  uncertain: number;
  judgeWeighted: number;
  retryWeighted: number;
  reviewed: number;
  reviewerAddedOn: number;
  reviewerAdded: number;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function reportRow(record: EvalRecord): ReportRow {
  return {
    iid: record.iid,
    status: record.final?.status ?? 'open',
    stopReason: record.final?.stopReason ?? null,
    score: record.final?.score ?? scoreOf(record),
    ...(record.review ? { review: record.review } : {}),
  };
}

export function summarise(rows: readonly ReportRow[]): ReportTotals {
  const totals: ReportTotals = {
    tickets: rows.length, byStatus: {}, byStop: {}, requirements: 0, firstCovered: 0, keptCovered: 0,
    passedFirstTime: 0, retried: 0, improved: 0, retries: 0, openCritical: 0, openMajor: 0, uncertain: 0,
    judgeWeighted: 0, retryWeighted: 0, reviewed: 0, reviewerAddedOn: 0, reviewerAdded: 0,
  };
  for (const row of rows) {
    bump(totals.byStatus, row.status);
    if (row.stopReason) bump(totals.byStop, row.stopReason);
    if (row.review) {
      totals.reviewed += 1;
      totals.reviewerAdded += row.review.added.length;
      if (row.review.added.length) totals.reviewerAddedOn += 1;
    }
    const s = row.score;
    if (!s) continue;
    totals.requirements += s.requirements;
    totals.firstCovered += s.firstCovered;
    totals.keptCovered += s.keptCovered;
    totals.retries += s.retries;
    if (s.retries === 0 && row.status === 'pass') totals.passedFirstTime += 1;
    if (s.retries > 0) totals.retried += 1;
    if (s.keptCovered > s.firstCovered) totals.improved += 1;
    totals.openCritical += s.openCritical;
    totals.openMajor += s.openMajor;
    totals.uncertain += s.uncertain;
    totals.judgeWeighted += s.judgeWeighted;
    totals.retryWeighted += s.retryWeighted;
  }
  return totals;
}

const percent = (part: number, whole: number): string => (whole ? `${Math.round((part / whole) * 100)}%` : '-');

const counts = (c: Record<string, number>): string =>
  Object.entries(c).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ') || '-';

export function formatReport(rows: readonly ReportRow[]): string[] {
  if (!rows.length) return ['No ticket has a test-case evaluation yet.'];
  const t = summarise(rows);
  const lines = [
    'iid     status        stop             coverage first → kept   retries  open crit/major  uncertain',
    ...[...rows].sort((a, b) => a.iid - b.iid).map((r) => {
      const s = r.score;
      const coverage = s ? `${s.firstCovered}/${s.requirements} → ${s.keptCovered}/${s.requirements}` : '-';
      return [
        `#${r.iid}`.padEnd(8), r.status.padEnd(14), (r.stopReason ?? '-').padEnd(17), coverage.padEnd(24),
        String(s?.retries ?? '-').padEnd(9), (s ? `${s.openCritical}/${s.openMajor}` : '-').padEnd(17),
        String(s?.uncertain ?? '-'),
      ].join('');
    }),
    '',
    `tickets: ${t.tickets}   status: ${counts(t.byStatus)}   stopped by: ${counts(t.byStop)}`,
    `coverage: first list ${percent(t.firstCovered, t.requirements)} → kept list ${percent(t.keptCovered, t.requirements)} `
      + `(${t.keptCovered}/${t.requirements} requirements)`,
    `passed first time: ${t.passedFirstTime}/${t.tickets}   retried: ${t.retried}   improved by a retry: ${t.improved}/${t.retried}`
      + `   retries in total: ${t.retries}`,
    `still open: ${t.openCritical} critical, ${t.openMajor} major gap(s); ${t.uncertain} uncertain point(s) for a person`,
    `review gate: reviewers added cases after the evaluation on ${t.reviewerAddedOn}/${t.reviewed} reviewed ticket(s) `
      + `(${t.reviewerAdded} case(s) — gaps the evaluation missed)`,
    `cost (weighted): judge ${t.judgeWeighted.toFixed(1)}, retries ${t.retryWeighted.toFixed(1)}`,
  ];
  return lines;
}

/**
 * A person's labels for one ticket's evaluation, written against one record
 * (`runId`), from the ticket and the rubric alone.
 *
 * The requirements being judged are research's acceptance criteria, so these
 * labels grade two things at once: whether each criterion really is a
 * requirement of this ticket (`real` / `notReal`) and whether the judge's
 * coverage call on it matches the person's (`real`'s case ids). `missed` is a
 * real requirement no criterion states — research under-reading the ticket,
 * which no coverage call can catch.
 */
export interface GoldLabel {
  project: string;
  runId: string;
  real: Record<string, string | null>;
  notReal: string[];
  missed: string[];
  /**
   * Each labelled id's requirement text as it read when the labels were
   * written. Ids are positional over research's criteria, so `AC6` alone
   * proves nothing: with the text stored, a renumbered or reworded criterion is
   * refused instead of being graded as though it still meant what the labeller
   * judged. Optional — labels without it grade on the ids.
   */
  requirements?: Record<string, string>;
}

export interface GoldGrade {
  iid: number;
  real: number;
  notReal: number;
  missed: number;
  /** Requirement ids the labels do not mention. */
  unlabelled: string[];
  coverageLabelled: number;
  coverageAgree: number;
  /** The judge said covered where the person found no covering case. */
  falseCovered: number;
  /** The judge found no covering case where the person did. */
  falseGap: number;
  /** Both agree a case covers it, but the judge named a different one than the person did. */
  misattributed: number;
}

/** Compared ignoring re-wrapping, so a reflowed text is not read as a reworded one. */
const sameText = (a: string, b: string): boolean => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');

/**
 * Grade one evaluation against a person's labels: how many of the criteria it
 * judged against are real requirements, how many real ones no criterion
 * states, and how often the judge's coverage call on the kept list matches the
 * person's. A string says why the record cannot be graded against these labels.
 */
export function gradeAgainstGold(record: EvalRecord, gold: GoldLabel): GoldGrade | string {
  if (record.runId !== gold.runId) return `labelled against run ${gold.runId}, the record is run ${record.runId}`;
  const kept = record.attempts.find((a) => a.n === record.final?.chosenAttempt) ?? record.attempts.at(-1);
  if (!kept) return 'nothing was evaluated';
  const held = record.requirements;
  for (const [id, text] of Object.entries(gold.requirements ?? {})) {
    const match = held.find((r) => r.id === id);
    if (!match) return `${id} was labelled but the record no longer holds it — re-label`;
    if (!sameText(match.text, text)) return `${id} has been reworded since labelling — re-label`;
  }
  const ids = new Set(held.map((r) => r.id));
  const labelled = new Set([...Object.keys(gold.real), ...gold.notReal]);
  const covered = coveredIds(held, kept.coverage, kept.cases);
  let coverageLabelled = 0;
  let coverageAgree = 0;
  let falseCovered = 0;
  let falseGap = 0;
  let misattributed = 0;
  for (const [id, truth] of Object.entries(gold.real)) {
    if (!ids.has(id)) continue;
    const judged = covered.has(id) ? kept.coverage[id]! : null;
    coverageLabelled += 1;
    if (judged === truth) coverageAgree += 1;
    else if (judged && !truth) falseCovered += 1;
    else if (!judged && truth) falseGap += 1;
    else misattributed += 1;
  }
  return {
    iid: record.iid,
    real: Object.keys(gold.real).filter((id) => ids.has(id)).length,
    notReal: gold.notReal.filter((id) => ids.has(id)).length,
    missed: gold.missed.length,
    unlabelled: [...ids].filter((id) => !labelled.has(id)),
    coverageLabelled, coverageAgree, falseCovered, falseGap, misattributed,
  };
}

export function formatGold(grades: readonly GoldGrade[]): string[] {
  if (!grades.length) return ['No labelled ticket could be graded.'];
  const sum = (pick: (g: GoldGrade) => number): number => grades.reduce((n, g) => n + pick(g), 0);
  const real = sum((g) => g.real);
  const notReal = sum((g) => g.notReal);
  const missed = sum((g) => g.missed);
  const labelled = sum((g) => g.coverageLabelled);
  return [
    'iid     real  not-real  missed  coverage agree  falsely covered  falsely missing  wrong case',
    ...[...grades].sort((a, b) => a.iid - b.iid).map((g) => [
      `#${g.iid}`.padEnd(8), String(g.real).padEnd(6), String(g.notReal).padEnd(10), String(g.missed).padEnd(8),
      `${g.coverageAgree}/${g.coverageLabelled}`.padEnd(16), String(g.falseCovered).padEnd(17),
      String(g.falseGap).padEnd(17), String(g.misattributed),
      g.unlabelled.length ? `   unlabelled: ${g.unlabelled.join(', ')}` : '',
    ].join('')),
    '',
    `acceptance criteria: ${percent(real, real + notReal)} of those judged against are real requirements, `
      + `${percent(real, real + missed)} of the real requirements are stated as one`,
    `coverage: ${percent(sum((g) => g.coverageAgree), labelled)} of ${labelled} labelled call(s) agree — `
      + `${sum((g) => g.falseCovered)} falsely covered, ${sum((g) => g.falseGap)} falsely missing, `
      + `${sum((g) => g.misattributed)} on the wrong case`,
  ];
}
