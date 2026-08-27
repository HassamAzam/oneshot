/**
 * `npm run langfuse -- <iid> [<iid> …]` — push a run to Langfuse from its journal.
 *
 * The conductor exports automatically as a run progresses; this is the manual
 * door for the two cases that need one: backfilling runs that finished before
 * the conductor did its own exporting, and re-sending a run after a Langfuse
 * outage. Span ids are derived from the run id, so re-exporting updates the
 * existing spans rather than duplicating them — running this twice is safe.
 *
 * With no arguments it exports every run it can find, newest first.
 */
import { existsSync, readdirSync } from 'node:fs';
import { RUNS } from '../src/lib/config.js';
import { readJournal } from '../src/lib/artifacts.js';
import { exportRun } from '../src/lib/langfuse.js';
import { otelStatus } from '../src/lib/otel.js';

async function main(): Promise<void> {
  const status = otelStatus();
  if (!status.on) {
    console.error(`\ntelemetry is off: ${status.why}\n`);
    process.exit(1);
  }

  const args = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const iids = args.length
    ? args
    : (existsSync(RUNS) ? readdirSync(RUNS).map(Number).filter(Boolean).sort((a, b) => b - a) : []);

  if (!iids.length) {
    console.error('\nno runs found under state/runs/\n');
    process.exit(1);
  }

  let sent = 0;
  for (const iid of iids) {
    const journal = readJournal(iid);
    if (!journal) {
      console.log(`  #${iid}  no journal — skipped`);
      continue;
    }
    const weighted = journal.phases.reduce((a, p) => a + (p.weighted ?? 0), 0);
    console.log(
      `  #${iid}  ${journal.runId}  ${journal.status}  ${journal.phases.length} phases  `
      + `${(weighted / 1e6).toFixed(2)}M weighted`,
    );
    await exportRun(journal);
    sent += 1;
  }
  console.log(`\n${sent} run(s) exported to ${status.why.split(' ')[0]}\n`);
}

main().catch((err) => {
  console.error(`\nexport failed: ${(err as Error).message}\n`);
  process.exit(1);
});
