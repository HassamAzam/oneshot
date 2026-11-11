/**
 * The pull request's title and description, rendered by code.
 *
 * Two things decide its shape.
 *
 * The repository has no CI, so the description IS the CI: the author pastes the
 * numbers and the reviewer re-runs them. Here the numbers are not the author
 * session's claim. The pipeline ran the typecheck, the suite and the
 * reproduction itself (src/diagnosis/fix/pipeline.ts), and those results are
 * what is printed, with the commands, so a reviewer can run the same ones.
 *
 * The repository is PUBLIC, and the diagnosis it came from is not. A diagnosis
 * quotes a private ticket, internal hosts, and whatever a transcript held. The
 * author is told to describe the mechanism in the repository's own terms, and
 * `publicSafe()` is the backstop behind that instruction: credentials, private
 * addresses, e-mail addresses, home directories, anything shaped like a mention
 * and whatever the pipeline KNOWS is private (the work project's host, the
 * ticket's title, this machine's name) are taken out of the whole description
 * before it leaves the machine. What cannot be rewritten, the commits
 * themselves, is refused instead: see `leaks()`.
 */
import { redact } from '../../lib/report.js';
import type { Checks, ReviewPoint, ReviewTally, Ruling } from './decide.js';

const PRIVATE_IP_RE = /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b(?::\d+)?/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const MENTION_RE = /(^|[^\w`/])@(?=[A-Za-z0-9_])/g;
const URL_CREDENTIAL_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const HOME_RE = /\/(?:Users|home)\/[^/\s`'")]+/g;
/** GitHub closes an issue of THIS repository when a merged description says "fixes #12". */
const CLOSING_RE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)#(?=\d)/gi;

/** Something the pipeline knows is private, and the words to say so without repeating it. */
export interface PrivateText { what: string; text: string }

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flatten = (v: string): string => v.replace(/\s+/g, ' ').trim();
/** The text as a pattern that finds it however it was wrapped: a line break in a commit body is a space. */
const anywhere = (text: string): RegExp => new RegExp(flatten(text).split(' ').map(escapeRe).join('\\s+'), 'gi');
/** An address that is nobody's: a placeholder domain, a no-reply address, or the `git@host:` of a remote. */
const NOBODY_RE = /@(?:[\w-]+\.)*example\.(?:com|org|net)$|(?:^|[.@])noreply\b|^git@/i;

/** Which kinds of private text appear in `text`. Names the kind, never the text. */
export function leaks(text: string, known: PrivateText[]): string[] {
  return [...new Set(known.filter((k) => k.text.trim().length >= 4 && anywhere(k.text).test(text)).map((k) => k.what))];
}

/**
 * Everything in text that cannot be rewritten (a commit message, the lines a
 * change adds) that must not be published: what the pipeline knows is private,
 * a real e-mail address, a private network address, and, in a commit message,
 * a mention or a closing keyword, both of which GitHub acts on. Names the kind.
 */
export function unpublishable(text: string, known: PrivateText[], where: 'message' | 'added'): string[] {
  const out = leaks(text, known);
  if ((text.match(EMAIL_RE) ?? []).some((m) => !NOBODY_RE.test(m))) out.push('an e-mail address');
  if (new RegExp(PRIVATE_IP_RE.source).test(text)) out.push('a private network address');
  if (where === 'message') {
    if (new RegExp(CLOSING_RE.source, 'i').test(text)) out.push('a closing keyword, which would close an issue of this repository');
    if (/(^|[^\w`/.])@[A-Za-z0-9][\w-]*(?![\w-]*[./@])/m.test(text.replace(EMAIL_RE, ''))) out.push('a mention');
  }
  return [...new Set(out)];
}

/**
 * Text made fit for a public pull request.
 *
 * Not a guarantee that nothing private is said: a model can describe a private
 * thing in words no pattern knows. It is the mechanical part, done every time.
 */
export function publicSafe(text: string, known: PrivateText[] = []): string {
  let out = redact(text);
  for (const k of known) {
    if (k.text.trim().length >= 4) out = out.replace(anywhere(k.text), `<${k.what}>`);
  }
  return out
    .replace(URL_CREDENTIAL_RE, '$1')
    .replace(PRIVATE_IP_RE, '<internal address>')
    .replace(EMAIL_RE, (m) => (/^git@/i.test(m) ? m : '<email>'))
    .replace(HOME_RE, '~')
    .replace(CLOSING_RE, '$1$2#​')
    .replace(MENTION_RE, '$1@​');
}

/** In the description of the pull request this pipeline opened for one finding of one stop: how it knows its own. */
export function fixPrMarker(iid: number, stopKey: string, findingId: string): string {
  const clean = (v: string): string => v.replace(/[^\w-]/g, '');
  return `<!-- oneshot:fix ${iid} ${clean(stopKey)} ${clean(findingId)} -->`;
}

export interface PrBodyInput {
  iid: number;
  /** `erp`, from the work project's path: how the repository's own PRs name a ticket. */
  project: string;
  stopKey: string;
  findingId: string;
  /** What the pipeline knows is private: replaced wherever it appears, in any field. */
  known?: PrivateText[];
  /** From the author, written for a public reader. */
  summary: string;
  why: string;
  tests: string;
  checks: Checks;
  commands: { typecheck: string; tests: string; red: string };
  points: ReviewPoint[];
  rulings: Ruling[];
  additional: ReviewPoint[];
  /** Blockers a verifier could not refute at some point, and those of them a later verifier found fixed. */
  stood: Set<string>;
  fixed: Set<string>;
  tally: ReviewTally;
  rounds: number;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
/**
 * One line of a table or a code block. Made safe BEFORE it is cut, with what is
 * known to be private: a credential or a host cut in half is not one anything
 * recognises afterwards.
 */
const lineWith = (known: PrivateText[]) => (s: string, n = 300): string => cut(publicSafe(s.replace(/\s+/g, ' ').trim(), known), n);

/**
 * The description. Review points are listed with what became of each one,
 * because "two reviewers looked at it" says nothing a reader can check, and
 * "A-2 was raised, the verifier ran the test and it does not hold" does.
 */
export function renderPrBody(i: PrBodyInput): string {
  const line = lineWith(i.known ?? []);
  const ruled = new Map(i.rulings.map((r) => [r.id, r]));
  const out: string[] = [];

  out.push('## Summary', '', i.summary.trim(), '');
  out.push('## Why', '', i.why.trim(), '');
  out.push(`Found by Oneshot's failure diagnosis of ${i.project}#${i.iid} (finding ${i.findingId}).`
    + ' The change was written, reviewed and verified by agents; a person has not read it yet.', '');

  out.push('## Tests', '', i.tests.trim(), '');
  out.push('## Numbers (no CI here, so these are the pipeline\'s own runs, not the author\'s claim)', '', '```');
  out.push(`${i.commands.red}`);
  out.push(`  → ${line(i.checks.red.text, 400)}`);
  out.push(`${i.commands.typecheck}`);
  out.push(`  → ${line(i.checks.typecheck.text, 200)}`);
  out.push(`${i.commands.tests}`);
  out.push(`  → ${line(i.checks.tests.text, 200)}`);
  if (i.checks.hooks.ran) out.push('bash scripts/verify-hooks.sh', `  → ${line(i.checks.hooks.text, 200)}`);
  out.push('```', '');

  out.push('## Review', '');
  out.push('Two reviewers read the diff independently, then a third session tried to refute each of their blockers: '
    + `${i.tally.raised} point(s) raised, ${i.tally.upheld} blocker(s) upheld and ${i.tally.fixed} of those fixed, `
    + `${i.tally.refuted} refuted, ${i.rounds} fix round(s).`, '');
  const all = [...i.points, ...i.additional];
  if (!all.length) {
    out.push('No points were raised.', '');
  } else {
    out.push('| | Severity | Point | Outcome |', '|---|---|---|---|');
    for (const p of all) {
      const r = ruled.get(p.id);
      const outcome = p.severity !== 'blocker' ? 'not blocking, left as raised'
        : i.fixed.has(p.id) ? 'upheld, then fixed in this branch and checked again'
          : i.stood.has(p.id) ? 'upheld'
            : `refuted: ${line(r?.reason ?? '', 160)}`;
      const at = p.file ? ` (\`${line(p.file, 80)}${p.line ? `:${p.line}` : ''}\`)` : '';
      out.push(`| ${p.id} | ${p.severity} | ${line(p.what, 200).replace(/\|/g, '\\|')}${at} | ${outcome.replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }

  out.push('Not merged, and auto-merge is off: a person reviews and merges this.');
  // The whole description, once more: every field above is model text or quotes it.
  return `${publicSafe(out.join('\n'), i.known ?? [])}\n\n${fixPrMarker(i.iid, i.stopKey, i.findingId)}`;
}
