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
 *
 * Which makes a false positive here the expensive direction. Detecting this
 * ends the run with `noRemediation`, so anything that merely LOOKS like the
 * notice costs a whole ticket; missing a real one costs the three infra
 * re-attempts it used to cost. Both checks below buy the cheap error.
 */

/**
 * Anchored to the start of a line, because the CLI prints this notice as a line
 * of its own and nothing else does. Unanchored, any stderr that merely quoted
 * the phrase matched — a ticket body echoed into a log, a test fixture, a
 * reviewer's comment relayed by a tool — and `'the ticket says [ACTION
 * REQUIRED] review the spec'` hard-stopped the run on 'review the spec'.
 */
const ACTION_RE = /^\s*\[ACTION REQUIRED\]\s*([^\n]+)/m;

/**
 * What an account gate is ever ABOUT: terms, privacy, policy, billing, or being
 * signed out. An `[ACTION REQUIRED]` line on its own line but about something
 * else is not a gate this module knows how to explain, and the reason string it
 * would produce — "run cli.js once and accept the notice" — would be wrong
 * advice. Unrecognised, it degrades to the infra re-attempt that handled it
 * before this module existed: a retry, not a dead run.
 */
const GATE_VOCAB = /terms|privacy|policy|billing|log ?in|sign ?in/i;

/** The notice text when stderr carries the CLI's account-action exit, else null. */
export function accountActionRequired(stderr: string): string | null {
  const m = ACTION_RE.exec(stderr);
  if (!m) return null;
  const notice = m[1]!.trim();
  return GATE_VOCAB.test(notice) ? notice : null;
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
