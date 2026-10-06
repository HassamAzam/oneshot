/**
 * Read the live outcome log (src/lib/outcomes.ts) and answer: is work reaching
 * a person with a real failure in it less often than before?
 *
 *   npm run eval:outcomes                # weekly table from evals/live/outcomes.jsonl
 *   npm run eval:outcomes -- --backfill  # add rows for finished runs already on disk (the baseline)
 *
 * The weekly table is the number that has to fall.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE } from '../src/lib/config.js';
import type { RunJournal } from '../src/lib/artifacts.js';
import {
  OUTCOMES_LOG, appendOutcome, outcomeOf, readOutcomes, type OutcomeInputs, type OutcomeRow,
} from '../src/lib/outcomes.js';

const RUNS = join(STATE, 'runs');
const ARCHIVE = join(STATE, 'runs-archive');
const DAY_MS = 86_400_000;

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

/** Every run directory on disk, live and archived, that holds a journal. */
function runDirs(): string[] {
  const under = (root: string): string[] => (existsSync(root) ? readdirSync(root) : [])
    .map((d) => join(root, d))
    .filter((d) => existsSync(join(d, 'run.json')));
  return [...under(RUNS), ...under(ARCHIVE)];
}

function inputsAt(dir: string): OutcomeInputs {
  return {
    verify: readJson(join(dir, 'verify.json')),
    testcases: readJson(join(dir, 'testcases.json')),
    findings: readJson(join(dir, 'findings.json')),
  };
}

/** Monday of the run's week, as YYYY-MM-DD. */
function weekOf(at: number): string {
  const monday = new Date(at - ((new Date(at).getDay() + 6) % 7) * DAY_MS);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${two(monday.getMonth() + 1)}-${two(monday.getDate())}`;
}

const pct = (n: number, of: number): string => (of ? `${Math.round((100 * n) / of)}%` : '-');

function backfill(): void {
  const logged = new Set(readOutcomes().map((r) => r.runId));
  let added = 0;
  for (const dir of runDirs()) {
    const journal = readJson<RunJournal>(join(dir, 'run.json'));
    if (!journal || journal.status === 'running' || logged.has(journal.runId)) continue;
    appendOutcome({ ...outcomeOf(journal, inputsAt(dir), journal.stoppedAt ?? journal.createdAt), backfill: true });
    logged.add(journal.runId);
    added++;
  }
  console.log(`backfilled ${added} run(s) into ${OUTCOMES_LOG}`);
}

function weekly(rows: OutcomeRow[]): void {
  if (!rows.length) {
    console.log(`No runs in ${OUTCOMES_LOG} yet. Run with --backfill for a baseline from runs on disk.`);
    return;
  }
  const weeks = new Map<string, OutcomeRow[]>();
  for (const r of rows) weeks.set(weekOf(r.at), [...(weeks.get(weekOf(r.at)) ?? []), r]);
  console.table([...weeks].map(([week, rs]) => {
    const handed = rs.filter((r) => r.handedOff);
    const bad = handed.filter((r) => r.realFailureAtHandoff).length;
    const passScored = rs.filter((r) => r.passesMissing);
    return {
      week,
      runs: rs.length,
      handedOff: handed.length,
      realFailureAtHandoff: `${bad} (${pct(bad, handed.length)})`,
      failingCases: rs.reduce((n, r) => n + r.failing.length, 0),
      preExisting: rs.reduce((n, r) => n + r.cases.preExisting, 0),
      failBlamedElsewhere: rs.reduce((n, r) => n + r.failBlamedElsewhere.length, 0),
      ownCaseDismissed: rs.reduce((n, r) => n + r.ownCaseDismissed.length, 0),
      implementLaps: rs.reduce((n, r) => n + r.implementLaps, 0),
      passesMissing: passScored.length
        ? `${passScored.reduce((n, r) => n + (r.passesMissing?.length ?? 0), 0)} (${passScored.length} runs)`
        : '-',
    };
  }));
  console.log('realFailureAtHandoff: an MR was opened with a failing case or regression still in it. This is the number that has to fall.');
  console.log('passesMissing: counted only over runs whose row records it; rows written before the field read "-".');
}

const args = process.argv.slice(2);
if (args.includes('--backfill')) backfill();
weekly(readOutcomes());
