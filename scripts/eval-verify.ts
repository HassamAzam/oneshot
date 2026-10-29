/**
 * `npm run eval:verify` — is every verify output internally honest?
 *
 *   npm run eval:verify                every ticket under state/runs/
 *   npm run eval:verify -- <iid> ...   just these
 *
 * Reads state/runs/<iid>/verify-eval.json only; writes nothing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS } from '../src/lib/config.js';
import { VERIFY_EVAL_RECORD, formatVerifyEval, type VerifyEvalRecord } from '../src/lib/verifyeval.js';

const asked = process.argv.slice(2);
if (asked.some((a) => !/^\d+$/.test(a))) {
  console.error('usage: npm run eval:verify -- [<iid> ...]');
  process.exit(2);
}

const iids = asked.length ? asked : existsSync(RUNS) ? readdirSync(RUNS).filter((d) => /^\d+$/.test(d)) : [];
const records = iids.flatMap((iid) => {
  const path = join(RUNS, iid, VERIFY_EVAL_RECORD);
  if (!existsSync(path)) return [];
  try {
    return [JSON.parse(readFileSync(path, 'utf8')) as VerifyEvalRecord];
  } catch (err) {
    console.error(`#${iid}: unreadable ${VERIFY_EVAL_RECORD} — ${(err as Error).message}`);
    return [];
  }
});

for (const line of formatVerifyEval(records)) console.log(line);
