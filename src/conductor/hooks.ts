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
import { ROOT, ONESHOT_HOME, envOr, projectConfig } from '../lib/config.js';
import { readToken } from '../lib/gitlab.js';
import { log } from '../lib/log.js';
import { AUTOMATION_PHASE } from '../automation/readiness.js';

type HookOutput = Record<string, unknown>;

/** The Ready For Automation mode's readiness script (hooks/automation-ready.cjs). Not a registered hook. */
const AUTOMATION_READY = 'automation-ready.cjs';

const NODE = envOr('ONESHOT_NODE', process.execPath);
const HOOK_TIMEOUT_MS = 15_000;

/**
 * Guards that need longer than the default, and why.
 *
 * The default is deliberately short: a guard stands between the session and
 * its next turn, so every millisecond is paid on every tool call. py-lint is
 * the exception — it spawns flake8 and pylint, and pylint alone can take
 * several seconds on a large module. At 15s it would fail open on exactly the
 * files most worth checking, and a guard that quietly stops running on big
 * inputs is worse than no guard, because the pass it reports is indistinguish-
 * able from a real one.
 *
 * automation-ready is the other, though it is no session's hook: the conductor
 * runs it through runGuard before it spends an automation session. It gives
 * up on GitLab at 20s and answers `unknown` with the reason (GitLab down, a
 * 500, a slow linked-MR list). The default 15s kill would land first and turn
 * every one of those into a bare "timed out", so it gets 30s: its own answer
 * always arrives before the kill. hooks.test.ts pins the order.
 */
const GUARD_TIMEOUT_MS = new Map<string, number>([
  ['py-lint.cjs', 60_000],
  [AUTOMATION_READY, 30_000],
]);

/** The kill timeout runGuard uses for `script`. Exported for the timeout-ordering test. */
export function guardTimeoutMs(script: string): number {
  return GUARD_TIMEOUT_MS.get(script) ?? HOOK_TIMEOUT_MS;
}

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
    }, guardTimeoutMs(script));

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
const MR_TOOLS = '^mcp__gitlab__(create|update)_merge_request$';
const READ_OR_BASH = '^(Read|NotebookRead|Grep|Bash)$';

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
      { matcher: WRITE_TOOLS, hooks: [guard('frontend-test-guard.cjs')], timeout: 15 },
      { matcher: BASH, hooks: [guard('git-guard.cjs')], timeout: 20 },
      { matcher: MR_TOOLS, hooks: [guard('mr-gate.cjs')], timeout: 15 },
      { matcher: READ_OR_BASH, hooks: [guard('secret-guard.cjs')], timeout: 15 },
      // log-event stays last so a denied call is still recorded.
      { hooks: [guard('log-event.cjs')], timeout: 10 },
    ],
    PostToolUse: [
      { matcher: WRITE_TOOLS, hooks: [guard('migration-standards.cjs')], timeout: 20 },
      { matcher: WRITE_TOOLS, hooks: [guard('script-standards.cjs')], timeout: 20 },
      { matcher: WRITE_TOOLS, hooks: [guard('py-lint.cjs')], timeout: 60 },
      { matcher: WRITE_TOOLS, hooks: [guard('js-standards.cjs')], timeout: 15 },
      // log-event stays last so a blocked write is still recorded.
      { hooks: [guard('log-event.cjs')], timeout: 10 },
    ],
    SessionStart: [
      { hooks: [guard('budget-gate.cjs')], timeout: 20 },
      // Self-gates to `testcases` and injects that skill's traps list. An
      // instruction to read a file is a request; a phase that has died at its
      // cap drops reads first. Injecting costs zero turns and cannot be skipped.
      { hooks: [guard('traps-brief.cjs')], timeout: 15 },
    ],
  };
}

/**
 * Guard-only variables for automation-ready.cjs. Merged into the script's env, NEVER into
 * a session's: a token in a session's environment is a token it can print. May throw (no
 * GITLAB_REPO_URL); runAutomationReadyGuard catches.
 *
 * The token is the one call() reads with, handed over explicitly because the
 * desk's credential may live outside .env (src/lib/token.ts) where the
 * _common.cjs envFile() reader cannot see it. A desk with no token gets ''
 * here, which the script turns into a `config` verdict rather than a crash.
 */
export function automationGuardEnv(): Record<string, string> {
  const repo = projectConfig().gitlab;
  let token = '';
  try { token = readToken(); } catch { token = ''; }
  return {
    ONESHOT_HOME,
    ONESHOT_AUTOMATION_API: repo.apiUrl,
    ONESHOT_AUTOMATION_PROJECT: repo.project,
    ONESHOT_AUTOMATION_TOKEN: token,
  };
}

/**
 * The Ready For Automation mode's readiness check: hooks/automation-ready.cjs,
 * run through the same runGuard every guard uses, so one implementation of "is
 * this ticket ready" serves every caller. The conductor asks before it spends
 * a session, before it posts a version for QA, and before the sheet write.
 *
 * It is NOT a hook, and hooksFor() registers it for no event. The automation
 * session holds no tool a hook could stand in front of — no write scope, no
 * GitLab server, no shell, no file reads — and every post, label edit and sheet
 * write is conductor code, so the gate belongs here, before the session and
 * before each write, not inside it (docs/HOOKS.md §1: structure before hooks).
 *
 * Nor is it in FAIL_CLOSED, and it does not need to be. A script that cannot
 * run, times out or prints garbage resolves to `{}` like any guard, and
 * readinessFromHookOutput reads `{}` — or anything short of a well-formed
 * verdict for this ticket — as `unknown`, which gateOnReadiness holds on.
 *
 * Never throws: a failure to build the env becomes `{ reason }`, which reads as
 * `unknown` with that reason. `override` is merged LAST, because runGuard
 * spreads process.env first and a test has no other way to redirect the child.
 */
export async function runAutomationReadyGuard(
  iid: number, override: Record<string, string> = {},
): Promise<HookOutput> {
  try {
    const env = {
      ONESHOT_PHASE: AUTOMATION_PHASE,
      ONESHOT_TICKET: String(iid),
      ONESHOT_RUN_ID: 'automation-precheck',
      ...automationGuardEnv(),
      ...override,
    };
    // The payload a guard reads on stdin; the script only drains it.
    const input = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'conductor-precheck',
      transcript_path: '',
      cwd: ROOT,
      prompt: '',
    };
    return await runGuard(AUTOMATION_READY, input, env);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log.warn(`guard ${AUTOMATION_READY} could not start`, { why });
    return { reason: `the readiness check could not start (${why})` };
  }
}
