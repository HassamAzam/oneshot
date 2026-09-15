/**
 * Account-level gates the bundled Claude Code CLI hard-exits on before a
 * session starts.
 *
 * The SDK spawns its OWN copy of Claude Code (node_modules/@anthropic-ai/
 * claude-agent-sdk/cli.js), not the operator's `claude`. When the account owes
 * a one-time action — the Consumer Terms notice is the one seen so far — that
 * copy prints an `[ACTION REQUIRED]` line and exits 1 without emitting a single
 * message. To the runner that is indistinguishable from any other session that
 * died before it began, so it was treated as infra and retried: every retry
 * dies the same way, and on #168 the retry that should have re-planned against
 * reviewer feedback was never re-run at all.
 *
 * No retry helps. A person has to act, so the run stops and says how.
 */

const ACTION_RE = /\[ACTION REQUIRED\]\s*([^\n]+)/;

/** The notice text when stderr carries the CLI's account-action exit, else null. */
export function accountActionRequired(stderr: string): string | null {
  const m = ACTION_RE.exec(stderr);
  return m ? m[1]!.trim() : null;
}

/**
 * The block reason. The interactive `claude` a person reaches for first is a
 * newer build that may never show this notice, which is how an operator ends up
 * "accepting" nothing and the conductor stays blocked — so the reason names the
 * copy that actually enforces it.
 */
export function accountActionReason(notice: string, iid: number): string {
  return `the Claude account needs a one-time action before any session can start: "${notice}" ` +
    'This is enforced by the SDK\'s bundled Claude Code, not your interactive `claude`, which may ' +
    'not show it. From the Oneshot repo, with the same credentials the conductor uses, run ' +
    '`node node_modules/@anthropic-ai/claude-agent-sdk/cli.js` once, accept the notice and exit; ' +
    `then \`npm run unblock -- ${iid}\`.`;
}
