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
 * How settled a copy is. Higher wins — the whole ordering is "which copy knows
 * the most".
 *
 * A row the desk could not read knows nothing. `open` and `indeterminate` are
 * both provisional: `open` means the window had not closed WHEN THAT DESK SWEPT,
 * and another desk sweeping an hour later may have watched it close. `clean` and
 * `escaped` are final.
 */
function knowledge(r: SweepRow): number {
  if (!r.record) return 0;
  switch (r.record.verdict) {
    case 'clean': case 'escaped': return 3;
    case 'indeterminate': return 2;
    case 'open': case 'not-shipped': return 1;
    default: return 1;
  }
}

/**
 * Which of two copies of the same ticket to keep.
 *
 * Settledness FIRST, and this is the fix for a real defect: the earlier version
 * compared `openedAt`, which is the merge time — identical on two copies of the
 * same ticket, so neither could ever beat the other and whichever desk happened
 * to be read first won. A desk that swept before sign-off therefore contributed
 * `open`, and a ticket that had in fact settled was dropped from the rate
 * entirely. Silently shrinking the denominator is the exact failure mode this
 * eval exists to avoid, so the more settled copy now wins outright.
 *
 * Only then the later merge: a ticket re-claimed on another desk was shipped by
 * that later run, so its `oneshotSha` is the version that produced what QA
 * tested, and crediting the earlier abandoned attempt would blame the wrong
 * pipeline version. `sweptAt` breaks a remaining tie — fresher is better.
 */
function prefer(a: PooledRow, aSweptAt: number, b: SweepRow, bDesk: string, bSweptAt: number): PooledRow {
  const ka = knowledge(a);
  const kb = knowledge(b);
  const keepB = kb !== ka
    ? kb > ka
    : (b.record?.openedAt ?? 0) !== (a.record?.openedAt ?? 0)
      ? (b.record?.openedAt ?? 0) > (a.record?.openedAt ?? 0)
      : bSweptAt > aSweptAt;
  return keepB
    ? { ...b, desk: bDesk, alsoOn: [...a.alsoOn, a.desk] }
    : { ...a, alsoOn: [...a.alsoOn, bDesk] };
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
  const sweptAtOf = new Map<number, number>();
  const seenVerdicts = new Map<number, Array<{ desk: string; verdict: EscapeVerdict | 'unreadable' }>>();

  for (const rep of reports) {
    for (const row of rep.rows) {
      const log = seenVerdicts.get(row.iid) ?? [];
      log.push({ desk: rep.desk, verdict: verdictOf(row) });
      seenVerdicts.set(row.iid, log);

      const held = byIid.get(row.iid);
      const winner = held
        ? prefer(held, sweptAtOf.get(row.iid) ?? 0, row, rep.desk, rep.sweptAt)
        : { ...row, desk: rep.desk, alsoOn: [] };
      byIid.set(row.iid, winner);
      if (!held || winner.desk === rep.desk) sweptAtOf.set(row.iid, rep.sweptAt);
    }
  }

  const rows = [...byIid.values()].sort((a, b) => a.iid - b.iid);
  const readable = rows.filter((r) => r.record).map((r) => r.record!);

  // Only a disagreement between two FINAL verdicts is a conflict. Two desks
  // reading the same label history cannot honestly reach both `clean` and
  // `escaped`, so one sweep is wrong and a person needs to look.
  //
  // `open` or `indeterminate` against a final verdict is NOT a conflict — it is
  // one desk having swept before the window closed, which `prefer` resolves on
  // its own. Flagging that would fill the report with noise on every ticket any
  // desk happened to sweep early, and noise is how a real conflict gets missed.
  const FINAL = new Set<EscapeVerdict | 'unreadable'>(['clean', 'escaped']);
  const conflicts = [...seenVerdicts.entries()]
    .filter(([, vs]) => new Set(vs.filter((v) => FINAL.has(v.verdict)).map((v) => v.verdict)).size > 1)
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
