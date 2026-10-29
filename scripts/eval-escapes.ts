/**
 * The escaped-defect eval: sweep one desk, or pool several desks' sweeps.
 *
 * A desk only sees the tickets it shipped itself and no desk ships enough for a
 * rate to mean anything, so the cohort is the fleet's. Each desk emits its own
 * sweep and the files are pooled — see lib/escapepool.ts for why that is not
 * just concatenation.
 *
 *   # on each desk
 *   npm run eval:escapes -- --json > ~/escapes-$(whoami).json
 *
 *   # anywhere, once the files are together
 *   npm run eval:escapes -- --pool escapes-*.json
 *
 *   # and for a look at one desk by eye
 *   npm run eval:escapes                 # every shipped ticket here
 *   npm run eval:escapes -- 8781 --rounds
 */
import { readFileSync } from 'node:fs';
import { operatorName } from '../src/lib/config.js';
import { currentProjectKey } from '../src/lib/journalproject.js';
import { escapeRate } from '../src/lib/escapes.js';
import { collectEscapes, escapeLine, escapeWhy, shippedRuns } from '../src/lib/escapecollect.js';
import { poolReports, type DeskReport } from '../src/lib/escapepool.js';
import { gitlabLabelEvents } from '../src/conductor/escapesweep.js';

const argv = process.argv.slice(2);
const poolAt = argv.indexOf('--pool');
const asJson = argv.includes('--json');
const showRounds = argv.includes('--rounds');
const only = argv.filter((a) => /^\d+$/.test(a)).map(Number);

function pct(rate: number | null, settled: number): string {
  return rate === null
    ? `too few settled tickets to rate (need 12, have ${settled})`
    : `${Math.round(rate * 100)}% of settled tickets escaped a defect`;
}

/**
 * Everything the rate leaves out, on its own line. A rate printed without these
 * invites the reader to assume the denominator is every ticket shipped, and the
 * gap between the two is exactly where a broken measurement hides.
 */
function excluded(r: { open: number; indeterminate: number; notShipped: number }): string[] {
  const out: string[] = [];
  if (r.open) out.push(`${r.open} still being tested (window open)`);
  if (r.indeterminate) out.push(`${r.indeterminate} the board cannot answer (QA Issues never cleared)`);
  if (r.notShipped) out.push(`${r.notShipped} merged per the journal but no merge on the board`);
  return out;
}

// ------------------------------------------------------------------ pool mode

if (poolAt !== -1) {
  const files = argv.slice(poolAt + 1).filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: npm run eval:escapes -- --pool <desk.json> [desk.json ...]');
    process.exit(1);
  }
  const reports: DeskReport[] = files.map((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as DeskReport;
    } catch (e) {
      // A file that cannot be read is NOT skipped: a desk silently missing from
      // the pool shrinks the cohort, and the desks whose tickets went missing
      // are as likely to be the ones that escaped as the clean ones.
      console.error(`cannot read ${f}: ${(e as Error).message}`);
      return process.exit(1) as never;
    }
  });

  const pool = poolReports(reports);
  console.log(`project  ${pool.project}`);
  console.log(`desks    ${pool.desks.map((d) => `${d.desk}(${d.shipped})`).join('  ')}`);
  console.log('');
  for (const r of pool.rows) {
    const row = { ...r, dir: '', archived: r.archived };
    const also = r.alsoOn.length ? `  [also on ${r.alsoOn.join(', ')}]` : '';
    console.log(`${escapeLine(row)}  @${r.desk}${also}`);
    const why = escapeWhy(row);
    if (why) console.log(`       ${why}`);
  }
  console.log('');
  console.log(`shipped  ${pool.rows.length}`);
  console.log(`settled  ${pool.rate.settled}   escaped ${pool.rate.escaped}`);
  console.log(`rate     ${pct(pool.rate.rate, pool.rate.settled)}`);
  for (const line of excluded(pool.rate)) console.log(`excluded ${line}`);

  if (pool.byVersion.length > 1) {
    console.log('\nby pipeline version:');
    for (const b of pool.byVersion) {
      console.log(`  ${b.oneshotSha.padEnd(18)} ${b.escaped}/${b.settled} escaped`);
    }
  }
  if (pool.conflicts.length) {
    console.log('\nDISAGREEMENT — two desks read the same ticket differently, so one sweep is stale:');
    for (const c of pool.conflicts) {
      console.log(`  #${c.iid}  ${c.verdicts.map((v) => `${v.desk}=${v.verdict}`).join('  ')}`);
    }
  }
  if (pool.unreadable.length) {
    console.log(`\n${pool.unreadable.length} ticket(s) UNREADABLE on every desk that holds them `
      + '— excluded from the rate, not counted clean:');
    for (const r of pool.unreadable) console.log(`  #${r.iid}  ${r.error}`);
    process.exit(2);
  }
  process.exit(0);
}

// ------------------------------------------------------------- one-desk sweep

const shipped = shippedRuns();
if (!shipped.length) {
  // Not an error: a desk that has not merged anything for the configured
  // project has an empty cohort, and exiting non-zero would have a cron alert
  // on the ordinary state of a fresh desk. Still emitted as JSON so the pool
  // records that this desk was asked and contributed nothing.
  if (asJson) {
    console.log(JSON.stringify(
      { desk: operatorName(), project: currentProjectKey() ?? '', sweptAt: Date.now(), rows: [] },
      null, 2,
    ));
  } else {
    console.log('no shipped ticket for this project yet — nothing to sweep');
  }
  process.exit(0);
}

const rows = await collectEscapes(gitlabLabelEvents, { only });

if (asJson) {
  const report: DeskReport = {
    desk: operatorName(),
    project: currentProjectKey() ?? '',
    sweptAt: Date.now(),
    rows: rows.map((r) => ({
      iid: r.iid, runId: r.runId, mergedSha: r.mergedSha, oneshotSha: r.oneshotSha,
      archived: r.archived, record: r.record, error: r.error,
    })),
  };
  console.log(JSON.stringify(report, null, 2));
  // Non-zero when something could not be read, so a desk's contribution is
  // never pooled as complete when it is not.
  process.exit(rows.some((r) => r.error) ? 2 : 0);
}

for (const r of rows) {
  console.log(escapeLine(r));
  const why = escapeWhy(r);
  if (why) console.log(`       ${why}`);
  if (showRounds && r.record?.rounds.length) {
    for (const q of r.record.rounds) {
      console.log(`         QA flagged defects ${new Date(q.at).toISOString().slice(0, 16)} by ${q.by ?? 'unknown'}`);
    }
  }
}

const unreadable = rows.filter((r) => r.error);
const rate = escapeRate(rows.filter((r) => r.record).map((r) => r.record!));
console.log('');
console.log(`desk     ${operatorName()}   project ${currentProjectKey() ?? '(none)'}`);
console.log(`shipped  ${rows.length}`);
console.log(`settled  ${rate.settled}   escaped ${rate.escaped}`);
console.log(`rate     ${pct(rate.rate, rate.settled)}`);
for (const line of excluded(rate)) console.log(`excluded ${line}`);
console.log('\nthis is one desk only — pool the fleet with --json and --pool for a cohort');

if (unreadable.length) {
  console.log(`\n${unreadable.length} ticket(s) UNREADABLE — excluded from the rate, not counted clean:`);
  for (const r of unreadable) console.log(`  #${r.iid}  ${r.error}`);
  process.exit(2);
}
