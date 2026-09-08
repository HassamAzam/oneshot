/**
 * The human review gates on a run, as rows.
 *
 * A `Review` run pauses at three points: after `plan`, after `testcases`, and at
 * `merge` — where a person merges the MR and Oneshot only watches. These are NOT
 * blockers. A block is a failure the run could not get past; a gate is the pipeline
 * working as designed and waiting for a decision it was told to wait for.
 *
 * The board only displays them. Approval happens in the Slack thread or on the
 * GitLab ticket, which is where the audit trail belongs.
 */
const GATES = [
  { gate: 'plan', field: 'planApproval', after: 'plan' },
  { gate: 'testcases', field: 'testcasesApproval', after: 'testcases' },
];

const ts = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

export function gatesFor(journal, operatorId) {
  if (!journal?.reviewMode) return [];
  const out = [];
  const phaseDone = (name) => (journal.phases ?? []).some(
    (p) => p.phase === name && ['ok', 'warned', 'skipped'].includes(p.status),
  );

  for (const { gate, field, after } of GATES) {
    const g = journal[field];
    // Nothing to show until the phase it guards has actually produced something.
    if (!g && !phaseDone(after)) continue;
    const approved = Boolean(g?.approved);
    out.push({
      id: `${journal.runId}:${gate}`,
      run_id: journal.runId,
      ticket_iid: journal.iid,
      gate,
      state: approved ? 'approved' : g?.requestTs ? 'waiting' : 'pending',
      requested_at: null,
      feedback: g?.feedback ?? [],
      rounds: (g?.feedback ?? []).length,
      operator_id: operatorId,
    });
  }

  // The merge gate has no approval object: a Review run simply never merges itself,
  // so an MR that exists and is not yet merged IS the wait.
  if (journal.mrIid && !journal.mergedSha) {
    out.push({
      id: `${journal.runId}:merge`,
      run_id: journal.runId,
      ticket_iid: journal.iid,
      gate: 'merge',
      state: journal.humanMergeCheckAt ? 'waiting' : 'pending',
      requested_at: ts(journal.humanMergeCheckAt),
      feedback: [],
      rounds: 0,
      operator_id: operatorId,
    });
  }
  return out;
}
