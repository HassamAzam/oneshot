/**
 * Guardrail hooks, passed to the SDK in-process instead of installed into
 * ~/.claude/settings.json.
 *
 * WHY THIS EXISTS. The original design loaded the guards via
 * `settingSources: ['user']`. That works, but it drags in the operator's ENTIRE
 * personal config — and on this machine that config contains
 * `statusLine: npx ccusage@latest statusline`. npx re-resolves against the npm
 * registry on every session start, npm traffic is blocked whenever the VPN is
 * up, and the VPN is required to reach GitLab at all. So every phase hung
 * before its first turn with no error: the session was waiting on a status line
 * it did not need. Measured: still running after 15s.
 *
 * Passing hooks here removes the dependency completely, and is better on its
 * own merits:
 *   - guards travel with the repo; a fresh clone is protected with no install
 *   - an operator's personal settings can never wedge or weaken a phase
 *   - interactive sessions are untouched BY CONSTRUCTION, not by env-gating
 *
 * The callbacks deliberately shell out to the SAME hooks/*.cjs files rather
 * than reimplementing the policy in TypeScript. One implementation, one test
 * suite (scripts/verify-hooks.sh), no chance of the two drifting apart — which
 * for a security guard is the failure that matters.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, envOr } from '../lib/config.js';
import { log } from '../lib/log.js';

type HookOutput = Record<string, unknown>;

const NODE = envOr('ONESHOT_NODE', process.execPath);
const HOOK_TIMEOUT_MS = 15_000;

/**
 * Run one .cjs guard with the hook payload on stdin.
 *
 * FAIL-OPEN on internal error, matching the .cjs contract: a broken guard must
 * never wedge a phase. It is logged loudly instead — a guard that is silently
 * not running is worse than one that is loudly broken.
 */
function runGuard(script: string, input: unknown, env: Record<string, string>): Promise<HookOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (out: HookOutput) => { if (!settled) { settled = true; resolve(out); } };

    const child = spawn(NODE, [join(ROOT, 'hooks', script)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const killer = setTimeout(() => { child.kill('SIGKILL'); done({}); }, HOOK_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('error', (err) => {
      clearTimeout(killer);
      log.warn(`guard ${script} failed to spawn`, { error: err.message });
      done({});
    });
    child.on('close', () => {
      clearTimeout(killer);
      if (!stdout.trim()) return done({});          // empty stdout = allow
      try {
        done(JSON.parse(stdout) as HookOutput);
      } catch {
        log.warn(`guard ${script} emitted non-JSON — ignoring`);
        done({});
      }
    });

    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch { /* the close handler still resolves */ }
  });
}

/** Tool-name matchers, mirroring hooks/hooks.settings.json. */
const WRITE_TOOLS = '^(Write|Edit|NotebookEdit)$';
const BASH = '^Bash$';

/**
 * Build the hook set for one phase.
 *
 * `env` carries the phase identity the guards read (ONESHOT_PHASE,
 * ONESHOT_WRITE_SCOPES, ONESHOT_WORKTREE, …) — the same variables the
 * settings.json commands used to receive from the session environment.
 */
export function hooksFor(env: Record<string, string>): Record<string, unknown[]> {
  const guard = (script: string) =>
    async (input: unknown): Promise<HookOutput> => runGuard(script, input, env);

  return {
    PreToolUse: [
      { hooks: [guard('pause-check.cjs')], timeout: 15 },
      { matcher: WRITE_TOOLS, hooks: [guard('write-scope.cjs')], timeout: 15 },
      { matcher: BASH, hooks: [guard('git-guard.cjs')], timeout: 20 },
      { hooks: [guard('log-event.cjs')], timeout: 10 },
    ],
    PostToolUse: [
      { hooks: [guard('log-event.cjs')], timeout: 10 },
    ],
    SessionStart: [
      { hooks: [guard('budget-gate.cjs')], timeout: 20 },
    ],
  };
}
