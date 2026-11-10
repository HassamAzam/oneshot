/**
 * The human review gates on a run, as rows.
 *
 * A run pauses for a person after `design`, `plan`, `testcases`, `verify` (the verify
 * cases) and `research` (a not-a-bug verdict), and a `Review` run also at `merge` — where
 * a person merges the MR and Oneshot only watches. A gate the journal carries ships
 * whatever the run's Review mode: the design and not-a-bug gates are armed by the Design
 * label and a bug reproduction, not by Review. Review mode only decides the placeholder
 * rows for a gate not yet armed, and the merge row. Each row carries who answered it:
 * `approved_by` (one GitLab username) and `feedback_by` (one array of usernames per
 * feedback round, parallel to `feedback`). These are NOT
 * blockers. A block is a failure the run could not get past; a gate is the pipeline
 * working as designed and waiting for a decision it was told to wait for.
 *
 * The board only displays them. Approval happens in the Slack thread or on the
 * GitLab ticket, which is where the audit trail belongs.
 */
const GATES = [
  { gate: 'design', field: 'designApproval', after: 'design' },
  { gate: 'plan', field: 'planApproval', after: 'plan' },
  { gate: 'testcases', field: 'testcasesApproval', after: 'testcases' },
  // Armed only on a condition (verify out of laps with failing cases; a not-a-bug verdict),
  // so the phase finishing says nothing: the row appears once the journal carries the gate.
  { gate: 'verifycases', field: 'verifyCasesApproval', after: 'verify', conditional: true },
  { gate: 'notabug', field: 'notABugApproval', after: 'research', conditional: true },
];

/**
 * Who answered the verify-case gate. It does not fold replies the way the other gates
 * do, so it carries no approvedBy/feedbackBy of its own: QA's answers are the per-case
 * `verifyCaseDecisions`, each with its `by`. Every answerer is one feedback round, and
 * the last one to decide is the approver once the gate is approved.
 */
function verifyAnswerers(journal, g) {
  const decisions = Array.isArray(journal.verifyCaseDecisions) ? journal.verifyCaseDecisions : [];
  const by = [...new Set(decisions.map((d) => d?.by).filter(Boolean))];
  return {
    feedbackBy: g?.feedbackBy ?? (by.length ? [by] : []),
    approvedBy: g?.approvedBy ?? (g?.approved ? (decisions.at(-1)?.by || null) : null),
  };
}

const ts = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

/** `mergedBy`: who merged the MR (mrmerger.mjs, cached), or null when unknown or not merged. */
export function gatesFor(journal, operatorId, mergedBy = null) {
  if (!journal) return [];
  const out = [];
  const phaseDone = (name) => (journal.phases ?? []).some(
    (p) => p.phase === name && ['ok', 'warned', 'skipped'].includes(p.status),
  );

  for (const { gate, field, after, conditional } of GATES) {
    const g = journal[field];
    // Not armed yet: a Review run shows a placeholder once the phase it guards has
    // produced something; a conditional gate, or a run outside Review, shows nothing.
    if (!g && (conditional || !journal.reviewMode || !phaseDone(after))) continue;
    const approved = Boolean(g?.approved);
    const { approvedBy, feedbackBy } = gate === 'verifycases' ? verifyAnswerers(journal, g) : (g ?? {});
    out.push({
      id: `${journal.runId}:${gate}`,
      run_id: journal.runId,
      ticket_iid: journal.iid,
      gate,
      // requestNoteId is how a gate arms now; requestTs is the Slack-era field old journals carry.
      state: approved ? 'approved'
        : (g?.requestNoteId != null || g?.requestTs || (g?.feedback?.length ?? 0) > 0) ? 'waiting' : 'pending',
      requested_at: null,
      feedback: g?.feedback ?? [],
      rounds: (g?.feedback ?? []).length,
      approved_by: approvedBy ?? null,
      // Never null: the column is jsonb not null, and an old journal has no feedbackBy.
      feedback_by: feedbackBy ?? [],
      operator_id: operatorId,
    });
  }

  // The merge gate has no approval object: a Review run simply never merges itself,
  // so an MR that exists and is not yet merged IS the wait, and a merged sha is the answer.
  if (journal.reviewMode && journal.mrIid) {
    out.push({
      id: `${journal.runId}:merge`,
      run_id: journal.runId,
      ticket_iid: journal.iid,
      gate: 'merge',
      state: journal.mergedSha ? 'approved' : journal.humanMergeCheckAt ? 'waiting' : 'pending',
      requested_at: ts(journal.humanMergeCheckAt),
      feedback: [],
      rounds: 0,
      approved_by: journal.mergedSha ? mergedBy : null,
      feedback_by: [],
      operator_id: operatorId,
    });
  }
  return out;
}
