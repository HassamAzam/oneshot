/**
 * Turn a flat list of per-item failures into a ranked failure-mode summary.
 *
 * Each eval already knows, per graded item, WHY it scored low — which case was
 * mis-blamed, which edge the list missed. On its own that is a scatter of
 * lines; grouped by mode and ranked worst-first it becomes a diagnosis: the few
 * recurring reasons a score is where it is, and so what to change. The
 * aggregator is generic on purpose, so eval:causes and eval:edges feed it the
 * same shape and get the same summary.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'info';

const RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, info: 0 };

export interface FailureItem {
  /** Stable key a mode is grouped by, e.g. 'missed-real-failure'. */
  mode: string;
  /** Human sentence for the mode, shown once per group. */
  label: string;
  severity: Severity;
  /** Where it happened, e.g. 'erp#8792 TC-7'. */
  where: string;
  /** Optional one-line reason for this single item. */
  detail?: string;
}

export interface FailureMode {
  mode: string;
  label: string;
  severity: Severity;
  count: number;
  items: FailureItem[];
}

/**
 * Group items by mode and order worst-first: higher severity before lower, then
 * more-frequent before less, then by mode name so the order is stable.
 */
export function rankFailureModes(items: FailureItem[]): FailureMode[] {
  const byMode = new Map<string, FailureMode>();
  for (const it of items) {
    let m = byMode.get(it.mode);
    if (!m) { m = { mode: it.mode, label: it.label, severity: it.severity, count: 0, items: [] }; byMode.set(it.mode, m); }
    m.count += 1;
    m.items.push(it);
  }
  return [...byMode.values()].sort((a, b) => (
    RANK[b.severity] - RANK[a.severity] || b.count - a.count || a.mode.localeCompare(b.mode)
  ));
}

/**
 * Render the ranked summary as console lines. `max` caps how many locations are
 * listed per mode before a "+N more" tail, so one noisy mode cannot bury the
 * rest.
 */
export function formatFailureModes(modes: FailureMode[], opts: { max?: number } = {}): string[] {
  if (!modes.length) return [];
  const max = opts.max ?? 6;
  const lines = ['', 'Failure modes (ranked, worst first):'];
  for (const m of modes) {
    const where = m.items.map((i) => i.where);
    const shown = where.slice(0, max);
    const more = where.length > shown.length ? `, +${where.length - shown.length} more` : '';
    lines.push(`  [${m.severity}] ${m.label} (${m.count}): ${shown.join(', ')}${more}`);
  }
  return lines;
}
