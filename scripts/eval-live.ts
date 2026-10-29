/**
 * Compare the live, gold-free eval log (state/live-evals/*.jsonl) that every
 * verify and testcases run appends to. Three comparisons:
 *
 *   by commit   flags per verify run and criteria coverage, per Oneshot commit —
 *               did a prompt change help on real tickets, not only the gold set
 *   by week     the same numbers per ISO week — is something drifting
 *   outcomes    for each verify flag, what the NEXT verify on that ticket said
 *               about the flagged case: still failing, now passing, or gone
 *
 *   npm run eval:live
 *   npm run eval:live -- --since 2026-10-01
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_DIR, type LiveRecord } from '../src/lib/liveevals.js';
import { argValue } from './evalhistory.js';

function load(since: string | undefined): LiveRecord[] {
  if (!existsSync(LIVE_DIR)) return [];
  return readdirSync(LIVE_DIR)
    .filter((f) => f.endsWith('.jsonl') && (!since || f.slice(0, 10) >= since))
    .sort()
    .flatMap((f) => readFileSync(join(LIVE_DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LiveRecord));
}

function isoWeek(at: string): string {
  const d = new Date(at);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function summarise(rows: LiveRecord[]): Record<string, string | number> {
  const verify = rows.filter((r) => r.phase === 'verify');
  const tc = rows.filter((r) => r.phase === 'testcases' && r.criteria);
  const flags = verify.flatMap((r) => r.flags ?? []);
  const byMode = (m: string): number => flags.filter((f) => f.mode === m).length;
  const criteria = tc.reduce((a, r) => a + (r.criteria?.length ?? 0), 0);
  const covered = tc.reduce((a, r) => a + (r.covered ?? 0), 0);
  return {
    tickets: new Set(rows.map((r) => r.iid)).size,
    verifyRuns: verify.length,
    flagsPerRun: verify.length ? +(flags.length / verify.length).toFixed(2) : '-',
    blamedElsewhere: byMode('blamed-elsewhere'),
    ownDismissed: byMode('own-case-dismissed'),
    orphaned: byMode('orphaned-fail'),
    testcasesRuns: tc.length,
    coverage: criteria ? `${covered}/${criteria} (${Math.round((100 * covered) / criteria)}%)` : '-',
    judgeErrors: rows.filter((r) => r.judgeError).length,
  };
}

function groupTable(rows: LiveRecord[], key: (r: LiveRecord) => string): void {
  const groups = new Map<string, LiveRecord[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  console.table(Object.fromEntries([...groups].map(([k, v]) => [k, summarise(v)])));
}

/** For each flag, the flagged case's state in the next verify on the same ticket. */
function outcomes(rows: LiveRecord[]): void {
  const verify = rows.filter((r) => r.phase === 'verify').sort((a, b) => a.at.localeCompare(b.at));
  const tally = new Map<string, { stillFailing: number; nowPassing: number; gone: number; noNextVerify: number }>();
  verify.forEach((r, i) => {
    const next = verify.slice(i + 1).find((n) => n.iid === r.iid);
    for (const f of r.flags ?? []) {
      const t = tally.get(f.mode) ?? { stillFailing: 0, nowPassing: 0, gone: 0, noNextVerify: 0 };
      if (!next) t.noNextVerify++;
      else if (next.failing?.includes(f.caseId)) t.stillFailing++;
      else if (next.passing?.includes(f.caseId)) t.nowPassing++;
      else t.gone++;
      tally.set(f.mode, t);
    }
  });
  if (!tally.size) { console.log('no flags yet'); return; }
  console.table(Object.fromEntries(tally));
  console.log('blamed-elsewhere that is now passing was probably this change\'s after all (implement fixed it).');
  console.log('still failing after implement had a lap is the pattern a correct blamed-elsewhere flag predicts.');
}

const rows = load(argValue(process.argv.slice(2), '--since'));
if (!rows.length) {
  console.log(`no live eval records in ${LIVE_DIR} yet — they appear after the next verify or testcases run.`);
} else {
  console.log(`${rows.length} record(s) from ${LIVE_DIR}\n\nby Oneshot commit:`);
  groupTable(rows, (r) => r.oneshot);
  console.log('\nby week:');
  groupTable(rows, (r) => isoWeek(r.at));
  console.log('\nflag outcomes (what the next verify said about each flagged case):');
  outcomes(rows);
}
