import type { MrFeedbackConfig, ResolvePolicy } from './types.js';

const POLICIES: readonly ResolvePolicy[] = ['never', 'fixed', 'all'];
const ROLES = ['dev', 'qa'] as const;
type Role = typeof ROLES[number];

/**
 * Validate config/mr-feedback.json and expand roles into usernames.
 *
 * Throws rather than defaulting on a bad value: a typo in `resolve` that fell
 * back silently would close reviewers' threads under a policy nobody chose.
 * Absent `enabled` means OFF, so a missing file changes nothing.
 */
export function parseMrFeedbackConfig(
  raw: unknown, reviewers: Record<Role, string[]>,
): MrFeedbackConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const resolve = c.resolve ?? 'fixed';
  if (!POLICIES.includes(resolve as ResolvePolicy)) {
    throw new Error(`config/mr-feedback.json: resolve must be one of ${POLICIES.join(', ')} — `
      + `got ${JSON.stringify(resolve)}`);
  }

  const maxRounds = c.maxRounds ?? 3;
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`config/mr-feedback.json: maxRounds must be a positive integer — got ${JSON.stringify(maxRounds)}`);
  }

  const roles = Array.isArray(c.authorRoles) ? c.authorRoles : [...ROLES];
  const authors: string[] = [];
  for (const role of roles) {
    if (!ROLES.includes(role as Role)) {
      throw new Error(`config/mr-feedback.json: unknown author role ${JSON.stringify(role)} — use dev or qa`);
    }
    authors.push(...reviewers[role as Role]);
  }
  if (Array.isArray(c.extraAuthors)) {
    authors.push(...c.extraAuthors.filter((a): a is string => typeof a === 'string'));
  }

  return {
    enabled: c.enabled === true,
    resolve: resolve as ResolvePolicy,
    maxRounds,
    authors: [...new Set(authors)],
  };
}
