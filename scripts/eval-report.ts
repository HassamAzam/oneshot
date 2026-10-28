/**
 * `npm run eval:report` — the live test-case evaluation, scored per ticket and
 * summed: first-list and kept-list coverage, retries, what is still open, cost.
 *
 *   npm run eval:report                every ticket under state/runs/
 *   npm run eval:report -- <iid> ...   just these
 *
 * Reads state/runs/<iid>/testcases-eval.json only; writes nothing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS } from '../src/lib/config.js';
import { EVAL_RECORD, type EvalRecord } from '../src/lib/testcaseseval.js';
import { formatReport, reportRow } from '../src/lib/testcasesevalreport.js';

const asked = process.argv.slice(2);
if (asked.some((a) => !/^\d+$/.test(a))) {
  console.error('usage: npm run eval:report -- [<iid> ...]');
  process.exit(2);
}

const iids = asked.length ? asked : existsSync(RUNS) ? readdirSync(RUNS).filter((d) => /^\d+$/.test(d)) : [];
const rows = iids.flatMap((iid) => {
  const path = join(RUNS, iid, EVAL_RECORD);
  if (!existsSync(path)) return [];
  try {
    return [reportRow(JSON.parse(readFileSync(path, 'utf8')) as EvalRecord)];
  } catch (err) {
    console.error(`#${iid}: unreadable ${EVAL_RECORD} — ${(err as Error).message}`);
    return [];
  }
});

for (const line of formatReport(rows)) console.log(line);
