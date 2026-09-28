/**
 * The cross-machine half of the claim: the ticket's own comments as arbiter.
 *
 * The SQLite claim (lib/db.ts) proves a ticket is ours on THIS machine and
 * nobody else can see the row. Two conductors on two laptops both pass it,
 * both start, and the second one finds out three phases later when the
 * merge collides. The only state every conductor shares is GitLab, so the
 * claim has to be visible there — and it already was: every run posts
 * "Oneshot claimed this ticket — run `r-…`" at its top. Nothing read it back.
 * This module reads it back.
 *
 * The rule is the one a human would apply: the OLDEST claim owns the ticket.
 * Note ids are monotonic per project, so "oldest" is an integer compare, not a
 * clock compare across machines whose clocks disagree.
 *
 * "Oldest" needs an "of the live ones". Tickets on this board carry two to five
 * abandoned claims each — a conductor killed mid-run, a label pulled, an
 * `unblock` that started a new run — none of which posted a stop note. A rule
 * that honoured those would lock every conductor out of #3, #4 and #7 today.
 * So a claim is LIVE only while both hold:
 *   - no later note on the ticket reports that run stopped or complete, and
 *   - it is younger than ONESHOT_CLAIM_STALE_HOURS (default 24).
 * The first is what a healthy run leaves behind; the second is the escape
 * hatch for a run that died without one. Parked runs sit for days waiting on a
 * human, which is why the bound is a day and not an hour — and why it is a
 * bound rather than a heartbeat: a peer still on the previous version of this
 * code posts no heartbeat, and its live run must not read as dead.
 *
 * Deleting the loser's note is not decoration. It is what keeps "oldest live
 * claim" cheap to compute on a long ticket, and it is what a person reading
 * the ticket needs to see one owner rather than two.
 */
import { readJournal } from './artifacts.js';
import { envOr } from './config.js';
import { issueNotes, type IssueNote } from './gitlab.js';

/**
 * The phrase every claim note has carried since the first version, kept
 * verbatim so a conductor on older code and one on this code recognise each
 * other's claims. The hidden marker after it is for this code's own parsing;
 * the phrase is the compatibility contract.
 */
const CLAIM_RE = /claimed this ticket — run `(r-[a-z0-9-]+)`/;

/**
 * The `— complete` arm matches nothing this code posts today: the success note
 * has read `— merged ✅` since 59c5835 ("merge is the last phase") retired the
 * old "Oneshot run r-… — complete" close note. It stays because the tickets
 * that note landed on are still on the board, and dropping the arm would make
 * every one of their finished runs read live again.
 */
const STOP_RE = /Oneshot stopped|— complete/;
const RUN_ID_RE = /r-[a-z0-9-]+/g;

export function claimMarker(runId: string): string {
  return `<!-- oneshot:claim:${runId} -->`;
}

/**
 * Any note this pipeline wrote, by its hidden marker.
 *
 * The review gates read a ticket's comments looking for a human verdict, and
 * their only machine filter was GitLab's `system` flag — which a claim note does
 * not carry, because it is an ordinary comment posted through the API. On a desk
 * whose token belongs to somebody on config/reviewers.json, that made the
 * pipeline's own claim indistinguishable from a reviewer speaking: run 29's plan
 * gate read another conductor's claim note as feedback and re-planned three times
 * into a quota wall.
 *
 * Matching the marker rather than the prose keeps this true for any future note
 * type, and keeps it independent of who the token happens to be.
 */
export function isMachineNote(body: string | null | undefined): boolean {
  return /<!--\s*oneshot:/i.test(body ?? '');
}

export function claimNoteBody(runId: string, operator: string): string {
  return `Oneshot claimed this ticket — run \`${runId}\` (${operator}).\n\n${claimMarker(runId)}`;
}

export interface Claim {
  noteId: number;
  runId: string;
  /** GitLab username of the token that posted it — a person, or a project bot. */
  author: string | null;
  createdAt: number;
}

/** How long a fresh claim waits for a simultaneous claimant's note to land before it counts. */
export function settleMs(): number {
  const n = Number(envOr('ONESHOT_CLAIM_SETTLE_MS', '15000'));
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
}

/** Past this age a claim with no stop note is presumed abandoned. */
export function staleMs(): number {
  const h = Number(envOr('ONESHOT_CLAIM_STALE_HOURS', '24'));
  return (Number.isFinite(h) && h > 0 ? h : 24) * 3_600_000;
}

export function parseClaims(notes: IssueNote[]): Claim[] {
  const out: Claim[] = [];
  for (const n of notes) {
    if (n.system) continue;
    const m = CLAIM_RE.exec(n.body ?? '');
    if (!m) continue;
    out.push({
      noteId: n.id,
      runId: m[1]!,
      author: n.author?.username ?? null,
      createdAt: n.created_at ? Date.parse(n.created_at) : 0,
    });
  }
  return out.sort((a, b) => a.noteId - b.noteId);
}

/**
 * Every run id a stop/complete note on this ticket has reported finished, with
 * the id of the LATEST such note.
 *
 * The note id matters because a run id outlives a stop: a blocked run that is
 * resumed keeps its id and posts a fresh claim. A bare "this run stopped" set
 * read that fresh claim as dead too, so a resumed-then-parked run never saw its
 * own claim live and posted another one on every re-entry — one after another
 * down a single ticket's thread in half an hour.
 */
export function stoppedRuns(notes: IssueNote[]): Map<string, number> {
  const done = new Map<string, number>();
  for (const n of notes) {
    // Mirrors parseClaims. A system note cannot create a claim, so letting one
    // end a claim is the asymmetry that fails open: GitLab writes the run id
    // into a system note on its own (a mention, a cross-reference from the MR),
    // and it only has to sit next to the word "stopped" to kill a live run's
    // claim on every desk that reads the ticket.
    if (n.system) continue;
    if (!STOP_RE.test(n.body ?? '')) continue;
    for (const id of (n.body ?? '').match(RUN_ID_RE) ?? []) {
      done.set(id, Math.max(done.get(id) ?? 0, n.id));
    }
  }
  return done;
}

/** Live claims, oldest first. Empty means the ticket is nobody's. */
export function activeClaims(notes: IssueNote[], now = Date.now()): Claim[] {
  const stopped = stoppedRuns(notes);
  const stale = staleMs();
  return parseClaims(notes).filter((c) => {
    const s = stopped.get(c.runId);
    return (s === undefined || s < c.noteId) && now - c.createdAt < stale;
  });
}

export interface Ownership {
  active: Claim[];
  /** The owner, by the rule: oldest live claim. */
  earliest: Claim | null;
}

/**
 * Read the ticket's live claims. Null when GitLab could not be read — which is
 * NOT "nobody owns it": callers treat null as "cannot tell" and do not claim on
 * the strength of it.
 */
export async function readOwnership(iid: number): Promise<Ownership | null> {
  const res = await issueNotes(iid);
  if (!res.ok || !res.data) return null;
  const active = activeClaims(res.data);
  return { active, earliest: active[0] ?? null };
}

/**
 * The oldest live claim when it is NOT a run this machine's journal owns.
 *
 * The scan calls this on every candidate, so the answer to "somebody else's"
 * has to come from disk, not the fleet table: a resumed run's own claim is the
 * one thing that must not read as foreign, and its run id is in the journal.
 */
export async function foreignOwner(iid: number): Promise<Claim | null> {
  const own = await readOwnership(iid);
  if (!own?.earliest) return null;
  const mine = readJournal(iid)?.runId ?? null;
  return own.earliest.runId === mine ? null : own.earliest;
}
