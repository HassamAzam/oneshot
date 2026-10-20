/**
 * What a QA reviewer's reply to the local-tests list means.
 *
 * The mode asks one question on the ticket, "may Oneshot run these tests?",
 * and accepts three answers:
 *
 * - `approved`: run the list. A bare word, read by the same rule every gate
 *   uses (isApprovedReply, src/conductor/reviewgate.ts), so a comment that
 *   says anything else can never approve by accident.
 * - `added <files>`: the exact spec files QA added to workstream-automation.
 *   Each is looked up on the automation ref and, when it is there, joins the
 *   list, which is put to QA again. It may also be written after
 *   `disapproved:`, the form the earlier notes taught.
 * - `disapproved: <what to change>`: feedback the scope session applies to the
 *   list (also run this, remove that), which is put to QA again.
 *
 * QA write these in their own words, so they are told apart leniently, but
 * never at the cost of a wrong turn. A reply that asks for a change to the list
 * itself (remove, drop, also run), or that names files without saying they were
 * added, is feedback: the scope session reads the whole text and can do all of
 * it, where the `added` path can only add files. Without `disapproved:`, only
 * a reply that opens with "added" and names a spec file decides anything.
 *
 * Nothing here asks Oneshot to write a test: the list is always the existing
 * tests of the modules the change touched.
 *
 * Pure.
 */
import { isApprovedReply } from '../conductor/reviewgate.js';

export type LocalTestsReply =
  | { kind: 'approved' }
  | { kind: 'added'; files: string[] }
  | { kind: 'feedback'; text: string };

/**
 * `disapproved` as the first word, then a colon, a dash or a line break. Allows
 * the backticks or bold a reply copied from the note's instructions keeps, so
 * "`disapproved:` remove LV_21" is read like the plain form.
 */
const PREFIX_RE = /^[\s*_`]*disapproved[*_`]*[ \t]*(?:[:\-–—][*_`]*|(?=\r?\n))/i;

/** A change to the list itself, which only the scope session can apply. */
const ASKS_RE = /\b(?:remove|drop|exclude|skip|don['’]?t\s+run|do\s+not\s+run|also\s+(?:run|add|include)|instead\s+of|replace)\b/i;

/** "added" and the words QA use for the same thing. */
const ADDED_RE = /\b(?:added|pushed|merged|committed|created)\b/i;

/** A reply with no `disapproved:` that still decides: it OPENS with "added" (or a word for it). */
const OPENS_ADDED_RE = /^[\s*_`]*(?:added|pushed|merged|committed|created)\b/i;

/**
 * A spec path under `cypress/`, bare in the reply: behind `./` or
 * `workstream-automation/`, in angle brackets, or inside a GitLab blob URL.
 * The suite's own names carry `&`, `(`, `%`, `$`, `<` and `>` (LV_19's
 * `Causal&Sick`), so those are part of a path; a space or a comma ends one,
 * because prose puts them between paths. Case-sensitive, like the git lookup
 * it feeds.
 */
const SPEC_PATH_RE = /(?<![\w-])cypress\/[\w.\-/&()%$<>+@=!~#]+\.(?:ts|js)(?!\w)/g;

/** A code span: the way to name a file whose name has a space or a comma (costing_15's `non billable`). */
const CODE_SPAN_RE = /`([^`\n]+)`/g;

/** In a code span, the path runs from `cypress/` to the end of the span. */
const IN_SPAN_RE = /(?:^|[\s/<])(cypress\/[^`\n]*?\.(?:ts|js))\s*>?\s*$/;

/** The spec paths a reply names, de-duplicated in the order given. A path with a `..` segment is not one. */
export function specPathsIn(text: string): string[] {
  const body = String(text ?? '');
  const spans = [...body.matchAll(CODE_SPAN_RE)].map((m) => IN_SPAN_RE.exec(m[1]!)?.[1]).filter((f): f is string => !!f);
  const bare = [...body.replace(CODE_SPAN_RE, ' ').matchAll(SPEC_PATH_RE)].map((m) => m[0]);
  return [...new Set([...spans, ...bare])].filter((f) => !f.split('/').includes('..'));
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
  if (!prefix) {
    // `added cypress/e2e/…`, with nothing asking for more than that.
    if (!OPENS_ADDED_RE.test(text)) return null;
    const files = specPathsIn(text);
    if (files.length && !ASKS_RE.test(text)) return { kind: 'added', files };
    // An `added` reply about a test file this cannot read as one path (a name
    // with a space, not in backticks) is still an answer to the list: the scope
    // session reads it whole and finds the file, rather than it being ignored.
    return /cypress\/|\.(?:ts|js)\b/.test(text) ? { kind: 'feedback', text: text.trim() } : null;
  }
  const rest = text.slice(prefix[0].length).trim();
  if (!rest) return null;

  if (ASKS_RE.test(rest)) return { kind: 'feedback', text: rest };
  const files = specPathsIn(rest);
  if (files.length && ADDED_RE.test(rest)) return { kind: 'added', files };
  // Files named without "added" ("please run cypress/e2e/…") are a change to
  // the list, which the session applies, like any other feedback.
  return { kind: 'feedback', text: rest };
}
