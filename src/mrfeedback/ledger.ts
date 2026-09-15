import type {
  AddressedFeedback, Disposition, FeedbackRound, FeedbackThread, MrFeedbackLedger, TriageItem,
} from './types.js';

const DISPOSITIONS: readonly Disposition[] = ['fix', 'question', 'decline', 'already-done'];

export function emptyLedger(): MrFeedbackLedger {
  return { rounds: [], handled: {} };
}

/** The round still being worked or answered, if any. At most one exists. */
export function activeRound(l: MrFeedbackLedger | undefined): FeedbackRound | null {
  if (!l) return null;
  const last = l.rounds[l.rounds.length - 1];
  return last && last.status !== 'done' ? last : null;
}

export function roundsUsed(l: MrFeedbackLedger | undefined): number {
  return l?.rounds.length ?? 0;
}

/**
 * Triage output → items the conductor can trust.
 *
 * Items for threads triage was not shown are dropped (a model cannot widen its
 * own remit), and ids are reassigned in order so implement, review and the
 * replies all name the same MRF-nn no matter what the model called them.
 */
export function normaliseItems(raw: unknown, threads: FeedbackThread[]): TriageItem[] {
  const known = new Set(threads.map((t) => t.discussionId));
  const list = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return [];
  const out: TriageItem[] = [];
  for (const x of list) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.discussionId !== 'string' || !known.has(o.discussionId)) continue;
    if (!DISPOSITIONS.includes(o.disposition as Disposition)) continue;
    out.push({
      id: `MRF-${String(out.length + 1).padStart(2, '0')}`,
      discussionId: o.discussionId,
      disposition: o.disposition as Disposition,
      request: String(o.request ?? ''),
      plan: String(o.plan ?? ''),
      reply: String(o.reply ?? ''),
    });
  }
  return out;
}

export function startRound(
  l: MrFeedbackLedger,
  args: { mrIid: number; threads: FeedbackThread[]; items: TriageItem[]; now: number },
): MrFeedbackLedger {
  if (activeRound(l)) throw new Error('startRound: a feedback round is already in progress');
  const round: FeedbackRound = {
    n: l.rounds.length + 1,
    mrIid: args.mrIid,
    startedAt: args.now,
    status: args.items.some((i) => i.disposition === 'fix') ? 'fixing' : 'replying',
    threads: args.threads,
    items: args.items,
    addressed: [],
    replied: [],
    resolved: [],
    respondAttempts: 0,
  };
  return { ...l, rounds: [...l.rounds, round] };
}

/** implement.json's `addressedFeedback`, shape-checked. */
export function addressedFeedbackOf(data: unknown): AddressedFeedback[] {
  const list = (data as { addressedFeedback?: unknown } | null)?.addressedFeedback;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is { id: string; note?: unknown } => typeof (x as { id?: unknown } | null)?.id === 'string')
    .map((x) => ({ id: x.id, note: String(x.note ?? '') }));
}

function withActive(l: MrFeedbackLedger, patch: (r: FeedbackRound) => FeedbackRound): MrFeedbackLedger {
  const r = activeRound(l);
  if (!r) return l;
  return { ...l, rounds: [...l.rounds.slice(0, -1), patch(r)] };
}

/**
 * Fold one implement lap's claims into the round. Accumulated across laps
 * because a review cycle inside the round overwrites implement.json, and a
 * fix made on the first lap is still a fix.
 */
export function recordAddressed(l: MrFeedbackLedger, addressed: AddressedFeedback[]): MrFeedbackLedger {
  return withActive(l, (r) => {
    if (r.status !== 'fixing') return r;
    const fixIds = new Set(r.items.filter((i) => i.disposition === 'fix').map((i) => i.id));
    const byId = new Map(r.addressed.map((a) => [a.id, a]));
    for (const a of addressed) if (fixIds.has(a.id)) byId.set(a.id, a);
    return { ...r, addressed: [...byId.values()] };
  });
}

export function markReplied(l: MrFeedbackLedger, discussionId: string): MrFeedbackLedger {
  return withActive(l, (r) => (r.replied.includes(discussionId) ? r : { ...r, replied: [...r.replied, discussionId] }));
}

export function markResolved(l: MrFeedbackLedger, discussionId: string): MrFeedbackLedger {
  return withActive(l, (r) => (r.resolved.includes(discussionId) ? r : { ...r, resolved: [...r.resolved, discussionId] }));
}

/** Count one merge pass that could not finish answering — what bounds retrying a thread GitLab refuses. */
export function noteRespondFailure(l: MrFeedbackLedger): MrFeedbackLedger {
  return withActive(l, (r) => ({ ...r, respondAttempts: (r.respondAttempts ?? 0) + 1 }));
}

/** Close the round. Only threads passed in `handled` stop being actionable. */
export function completeRound(
  l: MrFeedbackLedger, handled: Array<{ discussionId: string; lastNoteId: number }>,
): MrFeedbackLedger {
  const next = withActive(l, (r) => ({ ...r, status: 'done' as const }));
  if (next === l) return l;
  const marks = { ...l.handled };
  for (const h of handled) marks[h.discussionId] = Math.max(marks[h.discussionId] ?? 0, h.lastNoteId);
  return { ...next, handled: marks };
}

/**
 * The phases a fixing round still owes, in `window` order. The runner's
 * `forced` set lives in memory, so a process that dies anywhere in the fix
 * lap — before implement, or after implement but before review, verify, or mr
 * re-run — must resume through every phase the round has not yet re-earned an
 * ok/warned record for, or merge answers reviewers about code nobody
 * reviewed, verified, or even pushed.
 */
export function phasesOwedByRound(
  l: MrFeedbackLedger | undefined,
  records: Array<{ phase: string; status: string; startedAt: number }>,
  window: string[],
): string[] {
  const r = activeRound(l);
  if (!r || r.status !== 'fixing') return [];
  return window.filter((name) => !records.some((p) => p.phase === name
    && (p.status === 'ok' || p.status === 'warned') && p.startedAt >= r.startedAt));
}
