/**
 * The test-case list posted for QA holds UI cases, and only UI cases.
 *
 * A case here is something a person does in the running app and sees on the
 * screen: the list goes on the ticket for a QA reviewer to approve, and `verify`
 * executes it in a browser. Running the project's own tests, a linter or a
 * build is a different kind of check with a different owner — `implement` runs
 * them and reports `testsRun`, `review` reads the tests a change ships, CI runs
 * them on the merge request — and a QA reviewer can neither run one nor judge
 * it from a ticket comment.
 *
 * It is enforced here as well as asked for in the prompt, because the pressure
 * to write one is real and came from a reviewer: on #9174 the gate feedback
 * asked for "a case that runs this MR's own Django test class", the list gained
 * TC-21 ("Ran 4 tests / OK"), and that one case failed six verify laps in a row
 * — for a database login the server lacked and a test the review had asked to
 * delete — until it was skipped by hand. Nineteen UI cases passed every time.
 *
 * Narrow on purpose. It names test runners, linters, type checks and builds,
 * and looks only at what a case DOES and EXPECTS. A precondition that seeds
 * data with `manage.py shell` is how a UI case gets its state and is not
 * touched; a UI case is never dropped for mentioning a command in passing.
 */
import type { TestCase } from '../phases/types.js';

/** A tool whose invocation is the check itself, with the name it is reported under. */
const CODE_LEVEL: Array<[RegExp, string]> = [
  [/\bmanage\.py\s+test\b/i, 'manage.py test'],
  [/\bpython3?\s+-m\s+(pytest|unittest)\b/i, 'pytest'],
  [/\bpytest\b/i, 'pytest'],
  [/\b(npx\s+|yarn\s+)?jest\b/i, 'jest'],
  [/\b(npm|yarn|pnpm)\s+(run\s+)?test\b/i, 'npm test'],
  [/\bcoverage\s+run\b/i, 'coverage'],
  [/\bflake8\b/i, 'flake8'],
  [/\bpylint\b/i, 'pylint'],
  [/\b(npx\s+)?eslint\b/i, 'eslint'],
  [/\b(npx\s+)?tsc\b/, 'tsc'],
  [/\b(npm|yarn|pnpm)\s+run\s+(build|lint|check)\b/i, 'a build or lint script'],
];

/**
 * The test runner, linter or build this case is made of, or null when it is a
 * UI case. Read from the scenario, the steps and the expected result — never
 * the precondition.
 */
export function codeLevelTool(c: Pick<TestCase, 'scenario' | 'steps' | 'expected'>): string | null {
  const text = [c.scenario, ...(Array.isArray(c.steps) ? c.steps : []), c.expected]
    .map((x) => String(x ?? '')).join('\n');
  for (const [re, name] of CODE_LEVEL) if (re.test(text)) return name;
  return null;
}

/** Split a list into the cases QA is shown and the code-level ones left out of it. */
export function splitUiCases<T extends Pick<TestCase, 'id' | 'scenario' | 'steps' | 'expected'>>(
  cases: T[],
): { ui: T[]; leftOut: Array<{ id: string; scenario: string; tool: string }> } {
  const ui: T[] = [];
  const leftOut: Array<{ id: string; scenario: string; tool: string }> = [];
  for (const c of cases) {
    const tool = codeLevelTool(c);
    if (tool) leftOut.push({ id: String(c.id), scenario: String(c.scenario ?? ''), tool });
    else ui.push(c);
  }
  return { ui, leftOut };
}

/** One line per code-level check, for the QA note and for `review`, which inherits them. */
export function leftOutLine(x: { id: string; scenario: string; tool: string }): string {
  return `${x.id}: ${x.scenario.replace(/\s+/g, ' ').trim()} (${x.tool})`;
}
