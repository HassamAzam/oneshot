/**
 * Run and phase identity.
 *
 * Ids are derived, never random, so the same ticket attempted twice produces
 * groupable ids and a resumed run keeps the identity its artifacts were written
 * under. Randomness here would break both replay and Langfuse session grouping.
 */
import { randomBytes } from 'node:crypto';

/** `r-<base36 time>-<6 hex>` — sortable by creation, unique per run. */
export function newRunId(): string {
  return `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** Branch name for a ticket. Slug is bounded so paths stay sane. */
export function branchFor(prefix: string, iid: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return `${prefix}/ticket-${iid}-${slug || 'untitled'}`;
}

export function worktreeName(iid: number, runId: string): string {
  return `t${iid}-${runId}`;
}

export interface PhaseIdentity {
  runId: string;
  ticket: number;
  phase: string;
  lap: number;
  tier: string;
  model: string;
}

/**
 * Environment a phase session needs to identify itself to the guard hooks.
 *
 * ONESHOT_PHASE is the gate every hook checks first — its absence is what
 * makes the hooks a no-op in ordinary interactive sessions on this machine.
 */
export function phaseEnv(
  id: PhaseIdentity,
  paths: { worktree?: string; writeScopes: string[]; port?: number },
): Record<string, string> {
  const env: Record<string, string> = {
    ONESHOT_PHASE: id.phase,
    ONESHOT_RUN_ID: id.runId,
    ONESHOT_TICKET: String(id.ticket),
    ONESHOT_LAP: String(id.lap),
    ONESHOT_WRITE_SCOPES: paths.writeScopes.join(':'),
  };
  if (paths.worktree) env.ONESHOT_WORKTREE = paths.worktree;
  if (paths.port) env.ONESHOT_PORT = String(paths.port);
  return env;
}
