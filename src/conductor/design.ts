/**
 * What makes a `design` phase's success real.
 *
 * The phase exists because a `Design` ticket must not be built blind, so its own
 * account of itself is not enough: the conductor checks that the mockups and the
 * PDF it names are on disk, non-empty, inside the run's artifacts directory, and
 * grounded in real files. Anything less is overruled to a failure.
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { artifactDir } from '../lib/config.js';

/** Why the design deliverables are not acceptable, or null when they are. */
export function missingDesignDeliverables(
  iid: number, data: Record<string, unknown> | null | undefined, root = artifactDir(iid),
): string | null {
  const files = Array.isArray(data?.files) ? (data.files as unknown[]).map(String) : [];
  const escaped = files.filter((f) => normalize(f).startsWith('..') || f.startsWith('/'));
  if (escaped.length) return `files outside the artifacts directory: ${escaped.join(', ')}`;

  const absent = files.filter((f) => {
    const p = join(root, f);
    return !existsSync(p) || statSync(p).size === 0;
  });
  if (absent.length) return `reported files missing or empty on disk: ${absent.join(', ')}`;

  const present = files.map((f) => f.toLowerCase());
  if (!present.some((f) => f.endsWith('.png'))) return 'no rendered PNG mockup';
  if (!present.some((f) => f.endsWith('.pdf'))) return 'no design PDF';

  const grounded = Array.isArray(data?.groundedIn) ? (data.groundedIn as unknown[]) : [];
  if (!grounded.length) return 'no grounding files recorded — design-agent was not followed';
  return null;
}
