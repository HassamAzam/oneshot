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
 *
 * Every guard here fails OPEN — timeout, spawn error, non-JSON — because a
 * broken guard must never wedge a phase. FAIL_CLOSED is the escape hatch for a
 * guard whose promise is the opposite, and it is EMPTY: its only member was
 * deploy-guard, which went with the deploy phase. It is kept because the
 * asymmetry is the load-bearing part — a guard standing between a session and
 * an irreversible action must deny when it cannot run, and that belongs in one
 * place rather than being rediscovered by whoever adds the next one.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, envOr } from '../lib/config.js';
import { log } from '../lib/log.js';

type HookOutput = Record<string, unknown>;

const NODE = envOr('ONESHOT_NODE', process.execPath);
const HOOK_TIMEOUT_MS = 15_000;

/** Guards that must DENY rather than allow when they cannot run. */
const FAIL_CLOSED = new Set<string>();

/** The .cjs deny shape, mirrored exactly so a model reads one contract. */
function denyPayload(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function guardFailure(script: string, why: string): HookOutput {
  log.warn(`guard ${script} did not run`, { why });
  if (!FAIL_CLOSED.has(script)) return {};
  return denyPayload(
    `Denied: the ${script} guard could not run (${why}), and it fails closed. Nothing reaches ` +
    'the demo server unguarded. Report this in `blocked` — an operator has to fix the guard, ' +
    'and no retry of yours will change the answer.',
  );
}

/**
 * Run one .cjs guard with the hook payload on stdin.
 *
 * Fail-open by default, matching the .cjs contract; fail-closed for the scripts
 * in FAIL_CLOSED. Either way the failure is logged loudly — a guard that is
 * silently not running is worse than one that is loudly broken.
 */
function runGuard(script: string, input: unknown, env: Record<string, string>): Promise<HookOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (out: HookOutput) => { if (!settled) { settled = true; resolve(out); } };

    // A missing guard file surfaces as a spawn error, which used to be
    // indistinguishable from a guard that ran and allowed.
    if (!existsSync(join(ROOT, 'hooks', script))) {
      return done(guardFailure(script, 'the script is missing'));
    }

    const child = spawn(NODE, [join(ROOT, 'hooks', script)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      done(guardFailure(script, 'it timed out'));
    }, HOOK_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('error', (err) => {
      clearTimeout(killer);
      done(guardFailure(script, `it failed to spawn: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (!stdout.trim()) {
        // The .cjs contract is exit-0-always, so a non-zero exit means the
        // process died before it reached its own allow().
        if (code !== 0) return done(guardFailure(script, `it exited ${code}`));
        return done({});                            // empty stdout = allow
      }
      try {
        done(JSON.parse(stdout) as HookOutput);
      } catch {
        done(guardFailure(script, 'it emitted non-JSON'));
      }
    });

    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch { /* the close handler still resolves */ }
    return undefined;
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
      // log-event stays last so a denied call is still recorded.
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
