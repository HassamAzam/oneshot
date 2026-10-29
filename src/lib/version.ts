/**
 * Which Oneshot commit produced a record.
 *
 * WHY THE PIPELINE HAS TO STAMP ITSELF. The escaped-defect eval asks one
 * question: did a change to the pipeline reduce the defects a human finds after
 * a ticket ships. Answering it means bucketing shipped tickets by the version
 * that shipped them, and nothing in the journal said that — it records
 * `mergedSha` (the PRODUCT commit) but never the conductor's own. Without this
 * every ticket sits in one undated pile and "the skill is better now" stays an
 * opinion. It cannot be backfilled either: once the conductor has moved on,
 * which commit wrote a list three weeks ago is unknowable.
 *
 * STAMPED PER PHASE, not once per run. A run spans hours and often a `git pull`
 * — the commit that wrote the test cases is routinely not the commit that
 * merged. Attribution is per phase (a `testcases` miss belongs to whatever wrote
 * the cases), so the stamp has to be too, and a run that straddled an upgrade
 * then shows it rather than being quietly filed under the wrong version.
 *
 * A DIRTY TREE IS A DIFFERENT VERSION. Uncommitted tracked changes mean the sha
 * does not describe what ran, so it is suffixed rather than reported clean: an
 * eval that pooled `abc1234` with `abc1234` + local edits would be comparing
 * cohorts that are not the same pipeline. Untracked files are ignored — this
 * desk keeps a dozen `run*.sh` scratch scripts beside the checkout and they
 * change nothing about how a phase behaves.
 */
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.js';

/** Short form: readable in a log line, and still unique across this repo's history. */
const SHORT = 9;

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 5_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/**
 * `<sha>`, `<sha>-dirty`, or `''` when this checkout is not a git repo at all
 * (a tarball install, a container without .git). Empty rather than a guess: an
 * eval must be able to tell "shipped by an unknown version" from a real sha and
 * drop the row, which it cannot do if the unknown case invents one.
 *
 * Not cached. `recordPhase` runs a handful of times per run, the call costs a
 * few milliseconds, and a cache is exactly wrong for the one case that matters
 * most — a conductor left running across an upgrade would keep stamping the
 * version it booted on, which is the mislabelling this exists to prevent.
 */
export function oneshotSha(): string {
  const head = git(['rev-parse', `--short=${SHORT}`, 'HEAD']);
  if (!head.ok || !head.out) return '';
  // `diff --quiet HEAD` is 0 when every TRACKED file matches the commit. Chosen
  // over `status --porcelain`, which also reports untracked files and would
  // mark this desk permanently dirty over its scratch scripts.
  const clean = git(['diff', '--quiet', 'HEAD']).ok;
  return clean ? head.out : `${head.out}-dirty`;
}
