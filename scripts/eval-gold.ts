/**
 * `npm run eval:gold` — the live test-case evaluation graded against a
 * person's labels, so the judge is measured against something other than its
 * own reading of the ticket.
 *
 *   npm run eval:gold                every labelled ticket
 *   npm run eval:gold -- <iid> ...   just these
 *
 * Labels live in evals/testcases-eval/gold.json, one entry per ticket, each
 * written against one run's record (state/runs/<iid>/testcases-eval.json) —
 * see that file's `_how`. A record from another run, or another project, is
 * skipped rather than graded against labels written for different ids.
 * Reads only; writes nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, RUNS } from '../src/lib/config.js';
import { repoKey } from '../src/lib/repourl.cjs';
import { EVAL_RECORD, type EvalRecord } from '../src/lib/testcaseseval.js';
import { formatGold, gradeAgainstGold, type GoldGrade, type GoldLabel } from '../src/lib/testcasesevalreport.js';

const GOLD = join(ROOT, 'evals', 'testcases-eval', 'gold.json');

const asked = process.argv.slice(2);
if (asked.some((a) => !/^\d+$/.test(a))) {
  console.error('usage: npm run eval:gold -- [<iid> ...]');
  process.exit(2);
}
if (!existsSync(GOLD)) {
  console.error(`no labels at ${GOLD}`);
  process.exit(2);
}

const labels = (JSON.parse(readFileSync(GOLD, 'utf8')) as { cases?: Record<string, GoldLabel> }).cases ?? {};
const iids = asked.length ? asked : Object.keys(labels);
const grades: GoldGrade[] = [];
for (const iid of iids) {
  const gold = labels[iid];
  if (!gold) { console.error(`#${iid}: not labelled`); continue; }
  const path = join(RUNS, iid, EVAL_RECORD);
  if (!existsSync(path)) { console.error(`#${iid}: no ${EVAL_RECORD} on this machine`); continue; }
  let record: EvalRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as EvalRecord;
  } catch (err) {
    console.error(`#${iid}: unreadable ${EVAL_RECORD} — ${(err as Error).message}`);
    continue;
  }
  if (repoKey(record.project) !== repoKey(gold.project)) {
    console.error(`#${iid}: the record is for ${record.project}, the labels for ${gold.project} — skipped`);
    continue;
  }
  const grade = gradeAgainstGold(record, gold);
  if (typeof grade === 'string') console.error(`#${iid}: ${grade} — skipped`);
  else grades.push(grade);
}

for (const line of formatGold(grades)) console.log(line);
