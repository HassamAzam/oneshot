/**
 * `npm run eval:design` — did every design approval request link its mockup HTML?
 *
 *   npm run eval:design                every ticket under state/runs/
 *   npm run eval:design -- <iid> ...   just these
 *
 * Reads state/runs/<iid>/design-eval.json only; writes nothing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS } from '../src/lib/config.js';
import { DESIGN_EVAL_RECORD, formatDesignEval, type DesignEvalRecord } from '../src/lib/designeval.js';

const asked = process.argv.slice(2);
if (asked.some((a) => !/^\d+$/.test(a))) {
  console.error('usage: npm run eval:design -- [<iid> ...]');
  process.exit(2);
}

const iids = asked.length ? asked : existsSync(RUNS) ? readdirSync(RUNS).filter((d) => /^\d+$/.test(d)) : [];
const records = iids.flatMap((iid) => {
  const path = join(RUNS, iid, DESIGN_EVAL_RECORD);
  if (!existsSync(path)) return [];
  try {
    return [JSON.parse(readFileSync(path, 'utf8')) as DesignEvalRecord];
  } catch (err) {
    console.error(`#${iid}: unreadable ${DESIGN_EVAL_RECORD} — ${(err as Error).message}`);
    return [];
  }
});

for (const line of formatDesignEval(records)) console.log(line);
