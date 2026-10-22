/**
 * The live test-case evaluation, summed over every ticket that ran it: how
 * often a first list passed, how much of each ticket the first and the kept
 * lists covered, how often a retry improved the list, what is still open, and
 * what the judge and the retries cost.
 *
 * Coverage is pooled — requirements covered over requirements, across tickets —
 * so a ticket with nine requirements weighs more than one with two.
 */
import { scoreOf, type EvalRecord, type EvalScore, type FinalOutcome, type StopReason } from './testcaseseval.js';

export interface ReportRow {
  iid: number;
  /** `open` is a loop a stopped conductor left unfinished. */
  status: FinalOutcome['status'] | 'open';
  stopReason: StopReason | null;
  score: EvalScore | null;
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
  };
}

export function summarise(rows: readonly ReportRow[]): ReportTotals {
  const totals: ReportTotals = {
    tickets: rows.length, byStatus: {}, byStop: {}, requirements: 0, firstCovered: 0, keptCovered: 0,
    passedFirstTime: 0, retried: 0, improved: 0, retries: 0, openCritical: 0, openMajor: 0, uncertain: 0,
    judgeWeighted: 0, retryWeighted: 0,
  };
  for (const row of rows) {
    bump(totals.byStatus, row.status);
    if (row.stopReason) bump(totals.byStop, row.stopReason);
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
    `cost (weighted): judge ${t.judgeWeighted.toFixed(1)}, retries ${t.retryWeighted.toFixed(1)}`,
  ];
  return lines;
}
