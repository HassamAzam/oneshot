/**
 * What a QA reviewer's reply to the local-tests list means.
 *
 * The mode asks one question on the ticket, "may Oneshot run these tests?",
 * and accepts five answers. Only one of them is a bare word: `approved`, read
 * by the same rule every gate uses (isApprovedReply, src/conductor/reviewgate.ts),
 * so a comment that says anything else can never approve by accident. The
 * other four start `disapproved:` and say what to do instead:
 *
 * - check again: a test for the change is on master now. A deterministic
 *   re-check runs, with no session.
 * - added <files>: the exact spec files QA added. Each is looked up on the
 *   automation ref and, when it is there, run.
 * - write a temporary test: the scope session writes one, for this run only.
 * - anything else: feedback the scope session applies to the list.
 *
 * QA write these in their own words, so the four are told apart leniently, but
 * never at the cost of a wrong turn. A reply that asks for a change to the list
 * itself (remove, drop, also run), or that names files without saying they were
 * added, is feedback: the scope session reads the whole text and can do all of
 * it, where the cheaper paths can each do only one thing. For the same reason a
 * reply naming added files AND asking for a temporary test is feedback. A reply
 * asking to check again AND to write a temporary test is `write-temporary`: the
 * session works on a fresh checkout of master, so it finds a test added there
 * before it writes one.
 *
 * Pure.
 */
import { isApprovedReply } from '../conductor/reviewgate.js';

export type LocalTestsReply =
  | { kind: 'approved' }
  | { kind: 'check-again' }
  | { kind: 'added'; files: string[] }
  | { kind: 'write-temporary' }
  | { kind: 'feedback'; text: string };

/**
 * `disapproved` as the first word, then a colon, a dash or a line break. Allows
 * the backticks or bold a reply copied from the note's instructions keeps, so
 * "`disapproved:` please check again" is read like the plain form.
 */
const PREFIX_RE = /^[\s*_`]*disapproved[*_`]*[ \t]*(?:[:\-–—][*_`]*|(?=\r?\n))/i;

/** A change to the list itself, which only the scope session can apply. */
const ASKS_RE = /\b(?:remove|drop|exclude|skip|don['’]?t\s+run|do\s+not\s+run|also\s+(?:run|add|include)|instead\s+of|replace)\b/i;

/** "added" and the words QA use for the same thing. */
const ADDED_RE = /\b(?:added|pushed|merged|committed|created)\b/i;

const AGAIN_RE = /\b(?:check|look|search|scan)(?:\s+(?:it|this|that))?\s+again\b|\bre-?(?:check|scan)(?:ed|ing)?\b/i;

const WRITE_RE = /\b(?:write|add|create|make)\s+(?:a\s+|an\s+|one\s+|the\s+)?(?:new\s+)?temp(?:orary)?\s+(?:cypress\s+|automation\s+|local\s+)?(?:tests?|specs?)\b/i;

const NO_WRITE_RE = /\b(?:don['’]?t|do\s+not|no\s+need\s+to|never)\s+(?:write|add|create|make)\s+(?:a\s+|an\s+|one\s+|the\s+)?(?:new\s+)?temp/i;

/**
 * A spec path under `cypress/`, wherever it sits in the reply: bare, in a code
 * span, behind `./` or `workstream-automation/`, or inside a GitLab blob URL.
 * Case-sensitive, like the git lookup it feeds.
 */
const SPEC_PATH_RE = /(?<![\w-])cypress\/[\w.\-/]+\.(?:ts|js)(?!\w)/g;

/** The spec paths a reply names, de-duplicated in the order given. A path with a `..` segment is not one. */
export function specPathsIn(text: string): string[] {
  const found = [...String(text ?? '').matchAll(SPEC_PATH_RE)].map((m) => m[0]);
  return [...new Set(found)].filter((f) => !f.split('/').includes('..'));
}

/**
 * The decision a reply carries, or null when it carries none: chatter, a
 * near-approval ("Approved.", "approved, thanks"), or a bare `disapproved:`
 * with nothing after it. Null is "keep waiting", never a decision.
 */
export function classifyLocalTestsReply(body: string): LocalTestsReply | null {
  const text = String(body ?? '');
  if (isApprovedReply(text)) return { kind: 'approved' };
  const prefix = PREFIX_RE.exec(text);
  if (!prefix) return null;
  const rest = text.slice(prefix[0].length).trim();
  if (!rest) return null;

  const feedback: LocalTestsReply = { kind: 'feedback', text: rest };
  if (ASKS_RE.test(rest)) return feedback;
  const files = specPathsIn(rest);
  const added = files.length > 0 && ADDED_RE.test(rest);
  const write = WRITE_RE.test(rest) && !NO_WRITE_RE.test(rest);
  if (added && write) return feedback;
  if (added) return { kind: 'added', files };
  if (write) return { kind: 'write-temporary' };
  // Files named without "added" ("please run cypress/e2e/…") are a change to
  // the list, which the session applies; so is a check-again that names one.
  if (files.length) return feedback;
  if (AGAIN_RE.test(rest)) return { kind: 'check-again' };
  return feedback;
}
