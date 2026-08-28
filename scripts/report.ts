/**
 * `npm run report -- <iid>` — write one ticket's run report and print its path.
 *
 * With no argument it writes one for every run under state/runs/, which is the
 * form that matters after the fact: reports are generated at the end of a run,
 * so every ticket that finished before this existed has none, and re-running
 * the whole directory is how they catch up. Regeneration is safe — the page is
 * derived entirely from the journal and the transcripts, and overwriting it
 * loses nothing.
 *
 * A run that yields no report is reported and walked past rather than fatal. A
 * directory holding only `artifacts/` is a real state on disk (a run reaped
 * before its first phase recorded anything), and it must not stop the ticket
 * after it from getting a page.
 */
import { existsSync, readdirSync } from 'node:fs';
import { RUNS } from '../src/lib/config.js';
import { writeRunReport } from '../src/lib/report.js';

const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

function runIids(): number[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .map((name) => Number(name))
    .filter((iid) => Number.isInteger(iid) && iid >= 0)
    .sort((a, b) => a - b);
}

function main(): void {
  const arg = process.argv[2];
  if (arg !== undefined && !/^\d+$/.test(arg)) {
    console.error('usage: npm run report -- [<iid>]');
    process.exit(1);
  }

  const targets = arg === undefined ? runIids() : [Number(arg)];
  if (targets.length === 0) {
    console.log(`${Y}no runs under ${RUNS}${X}`);
    return;
  }

  let written = 0;
  for (const iid of targets) {
    const path = writeRunReport(iid);
    if (path) {
      written += 1;
      console.log(`${G}#${iid}${X} ${path}`);
    } else {
      console.log(`${Y}#${iid}${X} ${D}nothing to report${X}`);
    }
  }

  if (targets.length > 1) console.log(`\n${written} of ${targets.length} runs reported`);
  process.exit(written ? 0 : 1);
}

main();
