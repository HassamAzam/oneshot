/**
 * Parse a QA reviewer's test-case gate comment into edge cases.
 *
 * Pure — no GitLab, no journal — so the rule is testable on its own.
 *
 * It used to be "every non-empty line is a case". On #179 a reviewer's reply
 * opened with "Disapproved", mentioned "@usman.nasir", and explained three
 * corrections in prose; all of it became cases ("Verify that Disapproved",
 * "Verify that @usman.nasir", …), the bulleted ones read "Verify that -
 * Verify that …", and none had a pass/fail criterion. A reviewer then has to
 * write a second comment asking for the first one to be cleaned up — which
 * itself turns into more cases.
 *
 * Now a line is a case only when it is shaped like one: a bullet (`- `, `* `,
 * `•`), or a line that starts with a test verb (Verify / Check / Ensure /
 * Confirm / Test). Everything else — a verdict word, a greeting, a mention, a
 * heading, an explanation — is conversation, not a case. The bullet marker
 * is stripped, and an `expects:` / `expected:` part becomes the case's
 * expected result instead of a restatement.
 */

export interface ParsedEdgeCase {
  scenario: string;
  steps: string[];
  /** The reviewer's own pass condition, or null when they did not give one. */
  expected: string | null;
}

const BULLET = /^(?:[-*•]|•)\s+/;
const TEST_VERB = /^(?:verify|check|ensure|confirm|test)\b/i;
const EXPECTS = /\s*(?:[—–-]\s*)?\b(?:expects?|expected(?: result)?)\s*:\s*/i;

export function parseEdgeCases(feedback: string): ParsedEdgeCase[] {
  const out: ParsedEdgeCase[] = [];
  for (const raw of feedback.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const bulleted = BULLET.test(trimmed);
    const line = trimmed.replace(BULLET, '').trim();
    if (!line || !(bulleted || TEST_VERB.test(line))) continue;

    const [what, expects] = splitExpects(line);
    if (!what) continue;
    const scenario = /^verify\b/i.test(what) ? what : `Verify that ${lowerFirst(stripVerb(what))}`;
    out.push({ scenario, steps: [what], expected: expects || null });
  }
  return out;
}

function splitExpects(line: string): [string, string] {
  const m = EXPECTS.exec(line);
  if (!m || m.index === 0) return [line, ''];
  return [line.slice(0, m.index).trim(), line.slice(m.index + m[0].length).trim()];
}

/** "Check that X" / "Ensure X" → "X", so the scenario reads "Verify that X". */
function stripVerb(s: string): string {
  return s.replace(/^(?:check|ensure|confirm|test)(?:\s+that)?\s+/i, '');
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}
