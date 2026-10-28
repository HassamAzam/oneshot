/**
 * Pool several desks' escape sweeps into one cohort.
 *
 * A desk only sees the tickets it shipped itself, and no desk ships enough for
 * a rate to mean anything — this one has shipped no erp ticket at all. The
 * cohort is the fleet's, so each desk runs `npm run eval:escapes -- --json` and
 * the files are merged here.
 *
 * WHY MERGING IS NOT CONCATENATION. Three things go wrong if it is:
 *
 *  - Two desks configured for DIFFERENT projects would pool two unrelated
 *    cohorts into one percentage. Refused outright rather than reported with a
 *    caveat, because the number outlives the caveat.
 *  - The same ticket can appear on two desks — a run that stalled on one and
 *    was re-claimed on another leaves a journal on both. Counted twice it
 *    doubles its own weight in the rate.
 *  - One desk may have been unable to read a ticket another read fine. Pooling
 *    lets the readable copy win, which is the one case where more desks makes
 *    the measurement better rather than just bigger.
 */
import { escapeRate, type EscapeRecord, type EscapeVerdict } from './escapes.js';

/** A sweep row as it crosses between desks — no local paths. */
export interface SweepRow {
  iid: number;
  runId: string;
  mergedSha: string;
  oneshotSha: string;
  archived: boolean;
  record: EscapeRecord | null;
  error: string | null;
}

/** What one desk's `--json` run emits. */
export interface DeskReport {
  desk: string;
  project: string;
  sweptAt: number;
  rows: SweepRow[];
}

export interface PooledRow extends SweepRow {
  /** Which desk's copy won, and which others also held this ticket. */
  desk: string;
  alsoOn: string[];
}

export interface Pool {
  project: string;
  desks: Array<{ desk: string; sweptAt: number; shipped: number }>;
  rows: PooledRow[];
  /** Same ticket, two desks, different verdicts. Surfaced, never resolved silently. */
  conflicts: Array<{ iid: number; verdicts: Array<{ desk: string; verdict: EscapeVerdict | 'unreadable' }> }>;
  rate: ReturnType<typeof escapeRate>;
  /** Buckets by the pipeline version that shipped each ticket — the comparison. */
  byVersion: Array<{ oneshotSha: string; settled: number; escaped: number }>;
  unreadable: PooledRow[];
}

const verdictOf = (r: SweepRow): EscapeVerdict | 'unreadable' => r.record?.verdict ?? 'unreadable';

/**
 * Which of two copies of the same ticket to keep.
 *
 * A readable row always beats an unreadable one. Between two readable copies
 * the later merge wins: a ticket re-claimed on another desk was shipped by that
 * later run, so its `oneshotSha` is the version that actually produced what QA
 * then tested. Attributing the escape to the earlier, abandoned attempt would
 * credit the wrong pipeline version.
 */
function prefer(a: PooledRow, b: SweepRow, bDesk: string): PooledRow {
  const keepB = (!a.record && !!b.record)
    || (!!a.record && !!b.record && (b.record.openedAt ?? 0) > (a.record.openedAt ?? 0));
  const winner = keepB ? { ...b, desk: bDesk, alsoOn: [...a.alsoOn, a.desk] } : a;
  if (!keepB) winner.alsoOn = [...a.alsoOn, bDesk];
  return winner;
}

export function poolReports(reports: readonly DeskReport[]): Pool {
  if (!reports.length) throw new Error('no desk reports to pool');
  const projects = [...new Set(reports.map((r) => r.project).filter(Boolean))];
  if (projects.length > 1) {
    throw new Error(
      `these reports are for different projects and cannot be pooled: ${projects.join(', ')}`,
    );
  }

  const byIid = new Map<number, PooledRow>();
  const seenVerdicts = new Map<number, Array<{ desk: string; verdict: EscapeVerdict | 'unreadable' }>>();

  for (const rep of reports) {
    for (const row of rep.rows) {
      const log = seenVerdicts.get(row.iid) ?? [];
      log.push({ desk: rep.desk, verdict: verdictOf(row) });
      seenVerdicts.set(row.iid, log);

      const held = byIid.get(row.iid);
      byIid.set(row.iid, held ? prefer(held, row, rep.desk) : { ...row, desk: rep.desk, alsoOn: [] });
    }
  }

  const rows = [...byIid.values()].sort((a, b) => a.iid - b.iid);
  const readable = rows.filter((r) => r.record).map((r) => r.record!);

  // A disagreement between two READABLE copies is the interesting case: the
  // label history is the same ticket, so it should not happen, and if it does
  // one desk's sweep is stale. An unreadable copy disagreeing is routine.
  const conflicts = [...seenVerdicts.entries()]
    .filter(([, vs]) => new Set(vs.filter((v) => v.verdict !== 'unreadable').map((v) => v.verdict)).size > 1)
    .map(([iid, verdicts]) => ({ iid, verdicts }));

  const buckets = new Map<string, { settled: number; escaped: number }>();
  for (const r of rows) {
    const v = r.record?.verdict;
    if (v !== 'clean' && v !== 'escaped') continue;
    const key = r.oneshotSha || 'unknown';
    const b = buckets.get(key) ?? { settled: 0, escaped: 0 };
    b.settled += 1;
    if (v === 'escaped') b.escaped += 1;
    buckets.set(key, b);
  }

  return {
    project: projects[0] ?? '',
    desks: reports.map((r) => ({ desk: r.desk, sweptAt: r.sweptAt, shipped: r.rows.length })),
    rows,
    conflicts,
    rate: escapeRate(readable),
    byVersion: [...buckets].map(([oneshotSha, b]) => ({ oneshotSha, ...b }))
      .sort((a, b) => a.oneshotSha.localeCompare(b.oneshotSha)),
    unreadable: rows.filter((r) => r.error),
  };
}
