/**
 * Failure cause: when verify failed a case, was it this change's fault, or a
 * pre-existing defect verify mislabelled? Graded against the hand labels in
 * evals/failure-cause/gold.json for every non-passing case of each gold run.
 *
 *   npm run eval:causes                              # grade the verify.json each gold run holds
 *   npm run eval:causes -- <iid> <iid>               # just these
 *   npm run eval:causes -- --save --label prompt-a   # also commit the scores to evals/history/
 *   npm run eval:causes -- --vs prompt-a             # compare against that saved scoring
 *
 * The failure this targets: verify reports failing cases that implement
 * cannot fix within two laps, so the run blocks at verify with an MR already
 * open. A 'fail' on a case this change did not break sends it back to
 * implement, which cannot fix it; a 'pre-existing' on the ticket's own
 * acceptance case hides a real defect. wrongBlame counts the first, missed the
 * second — missed is the worse number, wrongBlame the more frequent one.
 *
 * It grades whatever verify.json each run holds now, so the before/after for
 * a prompt change is: re-run verify on the gold tickets, then run this again
 * with --vs the saved scoring. There is no verify replay yet.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, STATE } from '../src/lib/config.js';
import type { RunJournal } from '../src/lib/artifacts.js';
import { blameOf, verifyLabel, type TestcasesArtifact, type VerifyArtifact } from '../src/lib/verifyblame.js';
import { argValue, loadHistory, saveHistory, type Saved } from './evalhistory.js';

type Cause = 'change' | 'pre-existing' | 'bad-case' | 'untested';
type Labels = Record<string, { cause: Cause; why: string }>;
interface GoldFile { projects: Record<string, Record<string, Labels>> }
interface CauseScore {
  repo: string; iid: number; right: number; total: number; missed: number; wrongBlame: number; wrong: string[];
  /** Verify's own labels that read as mislabels, with no gold needed. */
  failBlamedElsewhere?: string[]; ownCaseDismissed?: string[];
}
interface CauseScores { tickets: CauseScore[] }

const GOLD = join(ROOT, 'evals', 'failure-cause', 'gold.json');
const KIND = 'failure-cause';
const RUNS = join(STATE, 'runs');
const ARCHIVE = join(STATE, 'runs-archive');
const VALUE_FLAGS = new Set(['--label', '--vs']);

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

/** What verify's label claims the cause is. */
function causeOf(result: string | undefined): Cause | 'none' {
  if (result === 'fail') return 'change';
  if (result === 'pre-existing') return 'pre-existing';
  if (result === 'blocked' || result === 'skipped') return 'untested';
  return 'none';
}

const pct = (n: number, of: number): string => (of ? `${Math.round((100 * n) / of)}%` : '-');

function score(repo: string, iid: number, labels: Labels, dir: string): CauseScore {
  const verify = readJson<VerifyArtifact>(join(dir, 'verify.json'));
  const verdicts = new Map((verify?.results ?? []).map((r) => [r.id ?? '', verifyLabel(r)]));
  const blame = blameOf(verify, readJson<TestcasesArtifact>(join(dir, 'testcases.json')));
  const s: CauseScore = {
    repo, iid, right: 0, total: 0, missed: 0, wrongBlame: 0, wrong: [],
    failBlamedElsewhere: blame.failBlamedElsewhere, ownCaseDismissed: blame.ownCaseDismissed,
  };
  for (const [id, { cause }] of Object.entries(labels)) {
    s.total++;
    const said = causeOf(verdicts.get(id));
    if (cause === 'bad-case' ? said !== 'change' : said === cause) { s.right++; continue; }
    if (cause === 'change') s.missed++;
    if (said === 'change') s.wrongBlame++;
    s.wrong.push(`${id}: gold ${cause}, verify said ${verdicts.get(id) ?? 'nothing'}`);
  }
  return s;
}

function report(now: CauseScore[], base: Saved<CauseScores> | null): void {
  const was = (s: CauseScore): CauseScore | undefined => base?.data.tickets.find((b) => b.repo === s.repo && b.iid === s.iid);
  console.table(now.map((s) => ({
    repo: s.repo, iid: s.iid, right: `${s.right}/${s.total}`, score: pct(s.right, s.total),
    missed: s.missed, wrongBlame: s.wrongBlame,
    blamedElsewhere: s.failBlamedElsewhere?.length ?? 0, ownDismissed: s.ownCaseDismissed?.length ?? 0,
    ...(base ? { [`was (${base.label})`]: was(s) ? `${was(s)!.right}/${was(s)!.total}, wrongBlame ${was(s)!.wrongBlame}` : '—' } : {}),
  })));
  console.log('missed: a real failure of this change that verify did not call a fail (worst).');
  console.log('wrongBlame: verify called it a fail of this change when it was not (costs an implement lap).');
  console.log('blamedElsewhere / ownDismissed: read from verify\'s own evidence and labels, no gold needed.');
  for (const s of now) for (const w of s.wrong) console.log(`  ${s.repo}#${s.iid} ${w}`);
  const sum = (xs: CauseScore[], k: 'right' | 'total' | 'missed' | 'wrongBlame'): number => xs.reduce((a, x) => a + x[k], 0);
  console.log(`now:  ${sum(now, 'right')}/${sum(now, 'total')} right, ${sum(now, 'missed')} missed, ${sum(now, 'wrongBlame')} wrongBlame`);
  if (!base) return;
  const prev = base.data.tickets;
  console.log(`was:  ${sum(prev, 'right')}/${sum(prev, 'total')} right, ${sum(prev, 'missed')} missed, ${sum(prev, 'wrongBlame')} wrongBlame   `
    + `(${base.label}, oneshot ${base.oneshot}, ${base.at.slice(0, 10)})`);
}

function main(): void {
  const gold = readJson<GoldFile>(GOLD);
  if (!gold) { console.error(`cannot read ${GOLD}`); process.exit(2); }
  const argv = process.argv.slice(2);
  const label = argValue(argv, '--label');
  if (argv.includes('--save') && !label) { console.error('--save needs --label <name>, e.g. --label prompt-a'); process.exit(2); }
  const only = argv.filter((a, i) => /^\d+$/.test(a) && !VALUE_FLAGS.has(argv[i - 1] ?? ''));

  const scores: CauseScore[] = [];
  for (const dir of runDirs()) {
    const journal = readJson<RunJournal>(join(dir, 'run.json'));
    const project = journal && Object.keys(gold.projects).find((p) => journal.url.startsWith(`${p}/`));
    const labels = project && gold.projects[project]?.[String(journal.iid)];
    if (!journal || !labels || (only.length && !only.includes(String(journal.iid)))) continue;
    scores.push(score(project.split('/').pop() ?? project, journal.iid, labels, dir));
  }
  if (!scores.length) { console.log('No run on disk matches a gold ticket.'); return; }
  scores.sort((a, b) => a.repo.localeCompare(b.repo) || a.iid - b.iid);

  report(scores, loadHistory<CauseScores>(ROOT, KIND, argValue(argv, '--vs')));
  if (argv.includes('--save')) console.log(`saved ${saveHistory(ROOT, KIND, label!, 'live', { tickets: scores })}`);
}

main();
