/**
 * Failure cause: when verify failed a case, was it this change's fault, or a
 * pre-existing defect verify mislabelled? Graded against the hand labels in
 * evals/failure-cause/gold.json for every non-passing case of each gold run.
 *
 *   npm run eval:causes                              # grade the verify.json each gold run holds
 *   npm run eval:causes -- <iid> <iid>               # just these
 *   npm run eval:causes -- --save --label prompt-a   # also commit the scores to evals/history/
 *   npm run eval:causes -- --vs prompt-a             # compare against that saved scoring
 *   npm run eval:causes -- --replay --label prompt-b # re-run verify with THIS checkout's prompt first
 *   npm run eval:causes -- --replay --repeat 3 --vs prompt-a   # regenerate 3x/ticket, compare
 *
 * The failure this targets: verify reports failing cases that implement
 * cannot fix within two laps, so the run blocks at verify with an MR already
 * open. A 'fail' on a case this change did not break sends it back to
 * implement, which cannot fix it; a 'pre-existing' on the ticket's own
 * acceptance case hides a real defect. wrongBlame counts the first, missed the
 * second — missed is the worse number, wrongBlame the more frequent one.
 *
 * Without --replay this grades whatever verify.json each run holds on disk — a
 * frozen snapshot written by whatever prompt was live then, so a prompt change
 * does not move it. --replay runs replay-verify.ts per ticket (a dry run of the
 * verify phase on the inputs its first verify session had) and grades those
 * fresh verdicts instead.
 *
 * Grading a fixed verify.json is deterministic, so --repeat only means
 * something with --replay: each replay re-executes the live app and produces a
 * different verify.json, and --repeat k takes k such trials to tell a real
 * prompt change from that noise. Because verify fabricates state in ONE shared
 * local Postgres, replays run SERIALLY — never in parallel.
 *
 * Report both. The headline right/missed/wrongBlame is over JUDGMENT cases
 * (gold change / pre-existing / bad-case): those turn on the prompt. The gold
 * set is dominated by 'untested' cases whose outcome is environment-driven (no
 * worker, broken Jest, low disk, no screen reader), so they are reported on
 * their own line — how many verify reproduced as untested — and kept out of the
 * before/after signal.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, STATE } from '../src/lib/config.js';
import type { RunJournal } from '../src/lib/artifacts.js';
import { blameFailureModes, blameOf, verifyLabel, type TestcasesArtifact, type VerifyArtifact } from '../src/lib/verifyblame.js';
import { rankFailureModes, formatFailureModes, type FailureItem } from '../src/lib/failuremodes.js';
import { beyondNoise } from '../src/lib/edgestats.js';
import { argValue, loadHistory, saveHistory, type Saved } from './evalhistory.js';

type Cause = 'change' | 'pre-existing' | 'bad-case' | 'untested';
type Labels = Record<string, { cause: Cause; why: string }>;
interface GoldFile { projects: Record<string, Record<string, Labels>> }
interface CauseScore {
  repo: string; iid: number; right: number; total: number; missed: number; wrongBlame: number; wrong: string[];
  /** Headline denominator: cases whose cause turns on the prompt, not the environment. */
  jRight: number; jTotal: number;
  /** Environment-driven cases, kept out of the signal; reproduced = verify also called it untested. */
  untestedTotal: number; untestedReproduced: number;
  /** Verify's own labels that read as mislabels, with no gold needed. */
  failBlamedElsewhere?: string[]; ownCaseDismissed?: string[];
  /** Failing verdicts for cases absent from testcases.json, with no gold needed. */
  orphanedFailures?: string[];
  /** Per-case failures tagged by mode, for the ranked diagnosis. */
  diag: FailureItem[];
  /** Per-case verify verdict, for detecting flips across repeat trials. */
  perCase: Record<string, string>;
  /** Repeat-run measurement, set only when aggregated from >1 trial. */
  trials?: number; flaky?: string[]; missedBand?: [number, number]; wrongBlameBand?: [number, number];
}
interface CauseScores { tickets: CauseScore[] }

const GOLD = join(ROOT, 'evals', 'failure-cause', 'gold.json');
const KIND = 'failure-cause';
const RUNS = join(STATE, 'runs');
const ARCHIVE = join(STATE, 'runs-archive');
const VALUE_FLAGS = new Set(['--label', '--vs', '--repeat']);
const JUDGMENT: ReadonlySet<Cause> = new Set<Cause>(['change', 'pre-existing', 'bad-case']);

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

interface GoldRun { project: string; journal: RunJournal; labels: Labels; dir: string }

/**
 * The gold runs to grade, one per (project, iid). A re-run parks its previous
 * attempt under runs-archive/<iid>-<runId>, so a ticket that was ever re-run
 * has two or more directories on disk; grading them all double-counts the
 * ticket and scores its stale pre-fix verify.json as missed. Keep only the
 * newest journal per ticket.
 */
function goldRuns(gold: GoldFile, only: string[]): GoldRun[] {
  const newest = new Map<string, GoldRun>();
  for (const dir of runDirs()) {
    const journal = readJson<RunJournal>(join(dir, 'run.json'));
    if (!journal) continue;
    const project = Object.keys(gold.projects).find((p) => journal.url.startsWith(`${p}/`));
    const labels = project ? gold.projects[project]?.[String(journal.iid)] : undefined;
    if (!project || !labels || (only.length && !only.includes(String(journal.iid)))) continue;
    const key = `${project}#${journal.iid}`;
    const prev = newest.get(key);
    if (!prev || journal.createdAt > prev.journal.createdAt) newest.set(key, { project, journal, labels, dir });
  }
  return [...newest.values()];
}

/** What verify's label claims the cause is. */
function causeOf(result: string | undefined): Cause | 'none' {
  if (result === 'fail') return 'change';
  if (result === 'pre-existing') return 'pre-existing';
  if (result === 'blocked' || result === 'skipped') return 'untested';
  return 'none';
}

const pct = (n: number, of: number): string => (of ? `${Math.round((100 * n) / of)}%` : '-');

function score(repo: string, iid: number, labels: Labels, verifyPath: string, testcasesPath: string): CauseScore {
  const verify = readJson<VerifyArtifact>(verifyPath);
  const verdicts = new Map((verify?.results ?? []).map((r) => [r.id ?? '', verifyLabel(r)]));
  const blame = blameOf(verify, readJson<TestcasesArtifact>(testcasesPath));
  const s: CauseScore = {
    repo, iid, right: 0, total: 0, missed: 0, wrongBlame: 0, wrong: [],
    jRight: 0, jTotal: 0, untestedTotal: 0, untestedReproduced: 0,
    failBlamedElsewhere: blame.failBlamedElsewhere, ownCaseDismissed: blame.ownCaseDismissed,
    orphanedFailures: blame.orphanedFailures,
    diag: [], perCase: {},
  };
  const where = `${repo}#${iid}`;
  for (const [id, { cause, why }] of Object.entries(labels)) {
    s.total++;
    const judgment = JUDGMENT.has(cause);
    if (judgment) s.jTotal++;
    if (cause === 'untested') s.untestedTotal++;
    const said = causeOf(verdicts.get(id));
    s.perCase[id] = verdicts.get(id) ?? 'nothing';
    const right = cause === 'bad-case' ? said !== 'change' : said === cause;
    if (right) {
      s.right++;
      if (judgment) s.jRight++;
      if (cause === 'untested') s.untestedReproduced++;
      continue;
    }
    const saidStr = verdicts.get(id) ?? 'nothing';
    s.wrong.push(`${id}: gold ${cause} (${why}), verify said ${saidStr}`);
    if (cause === 'change') {
      s.missed++;
      s.diag.push({ mode: 'missed-real-failure', label: 'verify missed a real failure of this change (defect hidden)', severity: 'critical', where: `${where} ${id}`, detail: why });
    } else if (said === 'change') {
      s.wrongBlame++;
      s.diag.push({ mode: 'wrong-blame', label: 'verify blamed the change for a pre-existing fail (costs an implement lap)', severity: 'high', where: `${where} ${id}`, detail: why });
    } else {
      s.diag.push({ mode: 'mislabel', label: 'verify put the wrong non-change label on a case', severity: 'medium', where: `${where} ${id}`, detail: `gold ${cause}, said ${saidStr}` });
    }
  }
  s.diag.push(...blameFailureModes(blame, where));
  return s;
}

/**
 * Fold k trials of the same ticket into one row. Grading a single verify.json
 * is deterministic; across replays both the verify.json and so the verdicts
 * vary. Report the worst missed/wrongBlame and the lowest judgment score seen,
 * with the band and the cases whose verdict flipped between trials (the noise).
 */
function aggregate(trials: CauseScore[]): CauseScore {
  const base = trials[trials.length - 1]!;
  const missed = trials.map((t) => t.missed);
  const wrongBlame = trials.map((t) => t.wrongBlame);
  const ids = new Set(trials.flatMap((t) => Object.keys(t.perCase)));
  const flaky = [...ids].filter((id) => new Set(trials.map((t) => t.perCase[id] ?? '∅')).size > 1);
  return {
    ...base,
    missed: Math.max(...missed), wrongBlame: Math.max(...wrongBlame),
    jRight: Math.min(...trials.map((t) => t.jRight)),
    untestedReproduced: Math.min(...trials.map((t) => t.untestedReproduced)),
    trials: trials.length, flaky,
    missedBand: [Math.min(...missed), Math.max(...missed)],
    wrongBlameBand: [Math.min(...wrongBlame), Math.max(...wrongBlame)],
  };
}

/** Run replay-verify.ts for one ticket and return the OUTPUT directory, or null. */
function replay(iid: string, label: string): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn('npx', ['tsx', join(ROOT, 'scripts', 'replay-verify.ts'), iid, '--label', label], {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('close', () => {
      const dir = /^OUTPUT (.+)$/m.exec(out)?.[1] ?? null;
      if (!dir) console.log(`#${iid}: replay produced no verify.json\n${out.trim().split('\n').slice(-6).map((l) => `      ${l}`).join('\n')}`);
      else console.log(`#${iid}: replayed → ${dir}`);
      done(dir);
    });
  });
}

/**
 * Replay the verify phase k times (serially — the shared Postgres forbids
 * parallel runs), grading each fresh verify.json. replay-verify.ts derives the
 * project from the on-disk run at state/runs/<iid>, so when two gold projects
 * share an iid both targets would replay the same run — grade only the one
 * whose run.json matches this target's project.
 */
async function scoreReplayed(repo: string, iid: string, labels: Labels, project: string, repeat: number, label: string | undefined): Promise<CauseScore | null> {
  const source = readJson<{ url: string }>(join(RUNS, iid, 'run.json'));
  if (!source?.url.startsWith(`${project}/`)) {
    console.log(`${repo}#${iid}: ${join(RUNS, iid)} is not a ${project} run, skipped (its list belongs to another project's labels)`);
    return null;
  }
  const trials: CauseScore[] = [];
  for (let n = 0; n < repeat; n++) {
    const dir = await replay(iid, `${label ?? 'eval'}${repeat > 1 ? `-t${n + 1}` : ''}`);
    if (!dir) continue;
    trials.push(score(repo, Number(iid), labels, join(dir, 'verify.json'), join(dir, 'testcases.json')));
  }
  if (!trials.length) { console.log(`${repo}#${iid}: no verify.json to grade, skipped`); return null; }
  if (trials.length < repeat) {
    console.log(`${repo}#${iid}: only ${trials.length}/${repeat} replays produced a verify.json; scored on ${trials.length} trial(s)`);
  }
  return trials.length > 1 ? aggregate(trials) : trials[0]!;
}

function report(now: CauseScore[], base: Saved<CauseScores> | null): void {
  const was = (s: CauseScore): CauseScore | undefined => base?.data.tickets.find((b) => b.repo === s.repo && b.iid === s.iid);
  const jr = (s: CauseScore): number => s.jRight ?? s.right;
  const jt = (s: CauseScore): number => s.jTotal ?? s.total;
  const repeated = now.some((s) => (s.trials ?? 1) > 1);
  console.table(now.map((s) => ({
    repo: s.repo, iid: s.iid,
    judgment: `${s.jRight}/${s.jTotal}`, score: pct(s.jRight, s.jTotal),
    missed: s.missed, wrongBlame: s.wrongBlame,
    untested: `${s.untestedReproduced}/${s.untestedTotal}`,
    blamedElsewhere: s.failBlamedElsewhere?.length ?? 0, ownDismissed: s.ownCaseDismissed?.length ?? 0,
    orphaned: s.orphanedFailures?.length ?? 0,
    ...(repeated ? { flaky: s.flaky?.length ?? 0 } : {}),
    ...(base ? { [`was (${base.label})`]: was(s) ? `${jr(was(s)!)}/${jt(was(s)!)}, wrongBlame ${was(s)!.wrongBlame}` : '—' } : {}),
  })));
  console.log('judgment: right/total over change/pre-existing/bad-case cases — the prompt-driven signal.');
  console.log('missed: a real failure of this change that verify did not call a fail (worst).');
  console.log('wrongBlame: verify called it a fail of this change when it was not (costs an implement lap).');
  console.log('untested: environment-driven cases verify reproduced as untested — kept OUT of the signal above.');
  console.log('blamedElsewhere / ownDismissed / orphaned: read from verify\'s own evidence and labels, no gold needed.');
  for (const s of now) for (const id of s.orphanedFailures ?? []) console.log(`  ${s.repo}#${s.iid} ${id}: fails in verify.json but is not in testcases.json (stale, salvaged fail).`);
  for (const s of now) for (const w of s.wrong) console.log(`  ${s.repo}#${s.iid} ${w}`);
  for (const line of formatFailureModes(rankFailureModes(now.flatMap((s) => s.diag)))) console.log(line);

  const sum = (xs: CauseScore[], k: 'jRight' | 'jTotal' | 'missed' | 'wrongBlame' | 'untestedReproduced' | 'untestedTotal'): number => xs.reduce((a, x) => a + x[k], 0);
  const noiseBand = now.reduce((a, s) => a + (s.flaky?.length ?? 0), 0);
  console.log(`\nnow:  ${sum(now, 'jRight')}/${sum(now, 'jTotal')} judgment right, ${sum(now, 'missed')} missed, ${sum(now, 'wrongBlame')} wrongBlame  `
    + `(untested reproduced ${sum(now, 'untestedReproduced')}/${sum(now, 'untestedTotal')})`);
  if (repeated) {
    console.log(`noise: ${noiseBand} case(s) flipped verdict across trials of the same config. A change smaller than that is noise, not signal.`);
  }
  if (!base) return;
  const prev = base.data.tickets;
  const both = now.filter(was);
  const sumJr = (xs: CauseScore[]): number => xs.reduce((a, x) => a + jr(x), 0);
  const sumJt = (xs: CauseScore[]): number => xs.reduce((a, x) => a + jt(x), 0);
  const prevBoth = both.map((s) => was(s)!);
  const delta = sumJr(both) - sumJr(prevBoth);
  const verdict = repeated ? `, ${beyondNoise(delta, noiseBand) ? 'beyond the noise band' : 'within noise — not a real change'}` : '';
  console.log(`was:  ${sumJr(prev)}/${sumJt(prev)} judgment right, ${sum(prev, 'missed')} missed, ${sum(prev, 'wrongBlame')} wrongBlame   `
    + `(${base.label}, ${base.mode}, oneshot ${base.oneshot}, ${base.at.slice(0, 10)})`);
  console.log(`then→now judgment right ${sumJr(prevBoth)}→${sumJr(both)} (Δ${delta >= 0 ? '+' : ''}${delta}${verdict})`);
}

async function main(): Promise<void> {
  const gold = readJson<GoldFile>(GOLD);
  if (!gold) { console.error(`cannot read ${GOLD}`); process.exit(2); }
  const argv = process.argv.slice(2);
  const replaying = argv.includes('--replay');
  const label = argValue(argv, '--label');
  if (argv.includes('--save') && !label) { console.error('--save needs --label <name>, e.g. --label prompt-a'); process.exit(2); }
  let repeat = Math.max(1, Math.floor(Number(argValue(argv, '--repeat') ?? 1)) || 1);
  if (repeat > 1 && !replaying) { console.error('--repeat only means something with --replay (grading a fixed verify.json is deterministic); using 1.'); repeat = 1; }
  const only = argv.filter((a, i) => /^\d+$/.test(a) && !VALUE_FLAGS.has(argv[i - 1] ?? ''));

  let scores: CauseScore[];
  if (replaying) {
    const targets = Object.entries(gold.projects)
      .flatMap(([project, tickets]) => Object.keys(tickets).map((iid) => ({ project, iid })))
      .filter(({ iid }) => !only.length || only.includes(iid));
    const graded: Array<CauseScore | null> = [];
    for (const { project, iid } of targets) {
      graded.push(await scoreReplayed(project.split('/').pop() ?? project, iid, gold.projects[project]![iid]!, project, repeat, label));
    }
    scores = graded.filter((s): s is CauseScore => s !== null);
  } else {
    scores = goldRuns(gold, only).map(({ project, journal, labels, dir }) =>
      score(project.split('/').pop() ?? project, journal.iid, labels, join(dir, 'verify.json'), join(dir, 'testcases.json')));
  }
  if (!scores.length) { console.log('No run on disk matches a gold ticket.'); return; }
  scores.sort((a, b) => a.repo.localeCompare(b.repo) || a.iid - b.iid);

  console.log(`\ngraded ${replaying ? `fresh replays of the current prompt${repeat > 1 ? `, ${repeat} trials/ticket` : ''}` : "each run's verify.json on disk"}.`);
  report(scores, loadHistory<CauseScores>(ROOT, KIND, argValue(argv, '--vs')));
  if (argv.includes('--save')) console.log(`saved ${saveHistory(ROOT, KIND, label!, replaying ? 'replay' : 'live', { tickets: scores })}`);
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });
