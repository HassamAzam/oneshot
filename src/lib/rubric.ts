/**
 * The coverage rubric, read from the one file that states it.
 *
 * `evals/testcases-eval/rubric.md` is the single source of truth for what
 * "covered" means: the judge's prompt embeds it, a person labelling gold.json
 * reads it, and the judgement schema points at it. Keeping it in a file rather
 * than in a string here is what lets a labeller and the judge be held to the
 * same words — the drift the three-way split caused is the reason this exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

export const RUBRIC_FILE: string = join(ROOT, 'evals', 'testcases-eval', 'rubric.md');

let cached: string | null = null;

/**
 * The rubric as the judge is shown it: everything from the first `##` heading,
 * so the file's own note about where it is read stays out of the prompt.
 *
 * Throws when the file is missing. A judge without the rubric would answer
 * from taste and its coverage calls decide whether a heavy `testcases` session
 * is spent, so the phase failing loudly is the lesser outcome — `testcases-eval`
 * is `onFail: warn`, and the list goes on unevaluated.
 */
export function coverageRubric(): string {
  if (cached !== null) return cached;
  if (!existsSync(RUBRIC_FILE)) {
    throw new Error(`the coverage rubric is missing at ${RUBRIC_FILE} — testcases-eval cannot judge without it`);
  }
  const text = readFileSync(RUBRIC_FILE, 'utf8');
  const start = text.indexOf('\n## ');
  cached = (start === -1 ? text : text.slice(start + 1)).trim();
  return cached;
}
