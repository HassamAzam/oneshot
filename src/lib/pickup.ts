/**
 * Whose assigned tickets this conductor may pick up.
 *
 * src/lib/identity.ts makes the GitLab token both who a desk ACTS as and whose
 * tickets it SELECTS, which is right for a person's desk: my token, my tickets.
 * It is wrong for a shared server acting through a project bot token. Nobody is
 * ever assigned to the bot, so every ticket assigned to a person would be
 * dropped, silently, and only unassigned ones would run.
 *
 * ONESHOT_PICKUP_ASSIGNEES separates the two for such a conductor. Acting stays
 * with the token; selecting can name people instead:
 *
 *   unset            the token's own user (a desk; the behaviour before this)
 *   *                any assignee: the Loop label alone opts a ticket in
 *   alice,bob        tickets assigned to any of these usernames
 *
 * Unassigned Loop tickets are claimable under every rule. Two conductors that
 * both accept a ticket are kept apart by the claim notes (src/lib/claims.ts), as
 * two desks always have been.
 */

export type PickupRule =
  | { mode: 'self' }
  | { mode: 'any' }
  | { mode: 'list'; users: string[] };

/** The env value, read leniently: `@` prefixes, spaces and case are ignored. */
export function parsePickupRule(raw: string | undefined): PickupRule {
  const v = (raw ?? '').trim();
  if (!v) return { mode: 'self' };
  if (v === '*') return { mode: 'any' };
  const users = [...new Set(v.split(',').map((u) => u.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  return users.length ? { mode: 'list', users } : { mode: 'self' };
}

export type PickupVerdict =
  | { ok: true }
  /** `silent`: someone else's ticket, not worth a line every tick. */
  | { ok: false; silent: boolean; why: string };

/**
 * Whether a ticket with these assignee usernames may be picked up by a conductor
 * whose token belongs to `me` (empty when no token resolved), under `rule`.
 */
export function pickupVerdict(assignees: string[], me: string, rule: PickupRule): PickupVerdict {
  if (assignees.length === 0 || rule.mode === 'any') return { ok: true };
  const owners = assignees.join(', ');
  if (rule.mode === 'list') {
    return assignees.some((a) => rule.users.includes(a.toLowerCase()))
      ? { ok: true }
      : { ok: false, silent: true, why: `assigned to ${owners}` };
  }
  if (!me) return { ok: false, silent: false, why: 'assigned ticket, but this desk has no GitLab identity (npm run token:set)' };
  return assignees.some((a) => a.toLowerCase() === me.toLowerCase())
    ? { ok: true }
    : { ok: false, silent: true, why: `assigned to ${owners}, not to ${me}` };
}
