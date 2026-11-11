/**
 * The hidden marker on every note the review loop posts.
 *
 * The reviewer and the fixer are two sessions, but on GitLab they are one
 * account: the conductor posts for both, as whoever its token is (a project bot
 * on the server, the operator on a desk — who is often a listed human reviewer
 * as well). Authorship therefore cannot say which note is a finding, which is
 * the fixer's answer and which is a person's; the marker can, and it is the
 * only thing that does. It also carries the finding id, so a thread can be
 * found again from GitLab alone when the local ledger is gone, and a write that
 * landed just before a crash is recognised instead of posted twice.
 *
 * An HTML comment, so it renders as nothing. Pure: no imports, so the pieces
 * that must not load src/lib/config.ts (src/mrfeedback) can use it.
 */

export type ReviewRole = 'reviewer' | 'fixer';
export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'suggestion';

/** What a note is doing on its thread. `raised` opens one; the rest answer it. */
export type ReviewAction =
  | 'raised' | 'fixed' | 'declined' | 'reopened' | 'withdrawn' | 'accepted' | 'stands' | 'closed';

export interface ReviewMarker {
  role: ReviewRole;
  finding: string;
  action: ReviewAction;
  /** Present on the note that raises a thread; fixed for the thread's life. */
  severity?: ReviewSeverity;
  run: string;
  /** The reviewer or fixer lap that produced the note. */
  lap: number;
}

const SEVERITIES: readonly ReviewSeverity[] = ['blocker', 'major', 'minor', 'suggestion'];
const ROLES: readonly ReviewRole[] = ['reviewer', 'fixer'];
const ACTIONS: readonly ReviewAction[] = [
  'raised', 'fixed', 'declined', 'reopened', 'withdrawn', 'accepted', 'stands', 'closed',
];

const MARKER_RE = /<!--\s*oneshot:review((?:\s+[a-z]+=[A-Za-z0-9_.:-]+)+)\s*-->/g;
const SAFE_VALUE = /^[A-Za-z0-9_.:-]+$/;

/** Anything this loop posted, whatever it says. The cheap test for "not a person's note". */
export function isReviewNote(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes('<!-- oneshot:review ');
}

export function renderMarker(m: ReviewMarker): string {
  const fields: Array<[string, string]> = [
    ['role', m.role], ['finding', m.finding], ['action', m.action],
    ...(m.severity ? [['severity', m.severity] as [string, string]] : []),
    ['run', m.run], ['lap', String(m.lap)],
  ];
  for (const [k, v] of fields) {
    // A value that could close the comment or add a field would let model-written
    // text (a finding id) forge a marker. Ids are conductor-normalised before this,
    // so a refusal here is a bug to hear about, not something to paper over.
    if (!SAFE_VALUE.test(v)) throw new Error(`review marker field ${k} is not a plain token: ${JSON.stringify(v)}`);
  }
  return `<!-- oneshot:review ${fields.map(([k, v]) => `${k}=${v}`).join(' ')} -->`;
}

/** The marker in a note body, or null when there is none or it is malformed. */
export function parseMarker(body: string | null | undefined): ReviewMarker | null {
  if (typeof body !== 'string') return null;
  // The LAST one: every note this loop writes ends with its marker, and what
  // comes before it is a finding or a reply — text a model wrote about code
  // that may itself quote a marker.
  const all = [...body.matchAll(MARKER_RE)];
  const m = all[all.length - 1];
  if (!m) return null;
  const f: Record<string, string> = {};
  for (const pair of m[1]!.trim().split(/\s+/)) {
    const i = pair.indexOf('=');
    f[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const lap = Number(f.lap);
  if (!ROLES.includes(f.role as ReviewRole) || !ACTIONS.includes(f.action as ReviewAction)) return null;
  if (!f.finding || !f.run || !Number.isInteger(lap) || lap < 0) return null;
  if (f.severity !== undefined && !SEVERITIES.includes(f.severity as ReviewSeverity)) return null;
  return {
    role: f.role as ReviewRole,
    finding: f.finding,
    action: f.action as ReviewAction,
    ...(f.severity ? { severity: f.severity as ReviewSeverity } : {}),
    run: f.run,
    lap,
  };
}

/** `F-7`, `f-07`, `F07`, `7` → `F-07`. Null for anything that is not a finding number. */
export function normaliseFindingId(raw: unknown): string | null {
  const m = /^\s*[Ff]?-?\s*(\d{1,4})\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? `F-${String(n).padStart(2, '0')}` : null;
}

export function findingNumber(id: string): number {
  return Number(String(id).replace(/\D+/g, '')) || 0;
}

export function isBlocking(severity: ReviewSeverity): boolean {
  return severity === 'blocker' || severity === 'major';
}
