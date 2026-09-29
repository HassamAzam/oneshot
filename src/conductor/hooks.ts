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
 * guard whose promise is the opposite: a guard standing between a session and
 * something it must not do unchecked denies when it cannot run, and that
 * belongs in one place rather than being rediscovered by whoever adds the next
 * one. Its one member today is automation-ready, the UserPromptSubmit guard of
 * the Ready For Automation mode: a session that writes test cases for a ticket
 * nobody has proven ready wastes the session and puts a wrong list in front of
 * QA. It is registered for that phase ONLY (hookPlan), so a broken or blocking
 * readiness guard can never touch a Loop phase.
 *
 * Fail-closed is the answer's SHAPE as much as its presence. Each event reads
 * its own reply schema, and a PreToolUse deny on a UserPromptSubmit is not a
 * block — the CLI treats it as a hook error and the prompt proceeds. So a
 * failure is turned into the payload the EVENT understands (failClosedPayload).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, ONESHOT_HOME, envOr, projectConfig } from '../lib/config.js';
import { readToken } from '../lib/gitlab.js';
import { log } from '../lib/log.js';
import { AUTOMATION_PHASE } from '../automation/readiness.js';

type HookOutput = Record<string, unknown>;

/** The Ready For Automation mode's readiness guard (hooks/automation-ready.cjs). */
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
 * automation-ready's timeouts NEST, and the order is the guarantee: the script
 * gives up on GitLab at 20s and answers `unknown` (a block), runGuard kills it
 * at 30s (a fail-closed block), and the SDK abandons the callback at 45s. A
 * callback that outlived its matcher timeout would be swallowed by the CLI as
 * `{}` — an allow — so runGuard must always answer first. hooks.test.ts pins it.
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
const FAIL_CLOSED = new Set<string>([AUTOMATION_READY]);

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

/**
 * Deny payload in the shape the EVENT understands. A PreToolUse deny on a
 * UserPromptSubmit is ignored by the CLI (wrong hookEventName → hook error →
 * prompt proceeds), so a prompt is refused with `decision:'block'` — and with
 * nothing else: adding `continue:false` makes the CLI keep the prompt and
 * report a turn, which hides the block from the conductor afterwards.
 */
export function failClosedPayload(event: string, reason: string): HookOutput {
  if (event === 'UserPromptSubmit') return { decision: 'block', reason: String(reason) };
  return denyPayload(reason);
}

function guardFailure(script: string, why: string, event: string): HookOutput {
  log.warn(`guard ${script} did not run`, { why, event });
  if (!FAIL_CLOSED.has(script)) return {};
  if (event === 'UserPromptSubmit') {
    // Read by the conductor (and logged), never by a model: the prompt it
    // would have answered is exactly what this refuses to deliver.
    return failClosedPayload(event,
      `The ${script} guard could not run (${why}), and it fails closed, so this session does not ` +
      'start. An operator has to fix the guard.');
  }
  return failClosedPayload(event,
    `Denied: the ${script} guard could not run (${why}), and it fails closed. Nothing reaches ` +
    'the demo server unguarded. Report this in `blocked` — an operator has to fix the guard, ' +
    'and no retry of yours will change the answer.');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A caught value's message — without throwing again on a thrown null or string. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pure. For a FAIL_CLOSED guard on UserPromptSubmit, the only acceptable answers are a block
 * (`decision === 'block'`) or an explicit `automationReadiness.verdict === 'ready'`. Anything else
 * — `{}`, a ready-shaped object without a verdict, a bug — is a guard failure.
 *
 * Other events keep the old contract (any JSON object is the guard's answer):
 * no fail-closed guard runs on them today, and a stricter rule there would be
 * a policy nobody has asked for.
 */
export function acceptsFailClosedOutput(event: string, out: HookOutput): boolean {
  if (!isRecord(out)) return false;
  if (event !== 'UserPromptSubmit') return true;
  if (out.decision === 'block') return true;
  const r = out.automationReadiness;
  return isRecord(r) && r.verdict === 'ready';
}

/**
 * Run one .cjs guard with the hook payload on stdin.
 *
 * Fail-open by default, matching the .cjs contract; fail-closed for the scripts
 * in FAIL_CLOSED. Either way the failure is logged loudly — a guard that is
 * silently not running is worse than one that is loudly broken.
 *
 * For a fail-closed guard, silence is a failure too. Empty stdout is the .cjs
 * way to say "allow", and a fail-closed guard that allows by saying nothing is
 * indistinguishable from one that died before it could say anything — so it
 * must answer, and on UserPromptSubmit it must answer with a block or an
 * explicit `ready` (acceptsFailClosedOutput).
 *
 * The raw parsed object is what resolves, extra keys included: the conductor's
 * readiness pre-run reads `automationReadiness` straight from it.
 */
function runGuard(script: string, input: unknown, env: Record<string, string>): Promise<HookOutput> {
  const named = isRecord(input) ? input.hook_event_name : undefined;
  const event = typeof named === 'string' && named ? named : 'PreToolUse';
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (out: HookOutput) => { if (!settled) { settled = true; resolve(out); } };
    const failed = (why: string) => done(guardFailure(script, why, event));

    // A missing guard file surfaces as a spawn error, which used to be
    // indistinguishable from a guard that ran and allowed.
    if (!existsSync(join(ROOT, 'hooks', script))) {
      return failed('the script is missing');
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(NODE, [join(ROOT, 'hooks', script)], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      // spawn throws synchronously on a bad argument (an env value holding a
      // NUL byte, say) rather than emitting 'error'.
      return failed(`it failed to spawn: ${errorText(err)}`);
    }

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      failed('it timed out');
    }, guardTimeoutMs(script));

    child.stdout?.on('data', (d) => { stdout += String(d); });
    // A guard that exits without reading its payload closes the pipe under
    // the write below; that is its answer, not the conductor's crash.
    child.stdin?.on('error', () => { /* the close handler still resolves */ });
    child.on('error', (err) => {
      clearTimeout(killer);
      failed(`it failed to spawn: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (!stdout.trim()) {
        // The .cjs contract is exit-0-always, so a non-zero exit means the
        // process died before it reached its own allow().
        if (code !== 0) return failed(`it exited ${code}`);
        if (FAIL_CLOSED.has(script)) return failed('it gave no verdict');
        return done({});                            // empty stdout = allow
      }
      let out: unknown;
      try {
        out = JSON.parse(stdout);
      } catch {
        return failed('it emitted non-JSON');
      }
      if (!isRecord(out)) return failed('it emitted JSON that is not an object');
      if (FAIL_CLOSED.has(script) && !acceptsFailClosedOutput(event, out)) {
        return failed('it answered without a verdict');
      }
      return done(out);
    });

    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch { /* the close handler still resolves */ }
    return undefined;
  });
}

/**
 * Pure. Reduce a UserPromptSubmit reply to exactly the keys and types the CLI's hook schema
 * accepts (decision ∈ approve|block, reason string, hookSpecificOutput{hookEventName:
 * 'UserPromptSubmit', additionalContext string}).
 *
 * WHY. The CLI VALIDATES a callback's reply, and one that fails validation is
 * not rejected loudly: the callback wrapper logs "Error in hook callback" to
 * stderr and hands back `{}` — which lets the prompt through. For a fail-closed
 * guard that is the one failure no script can prevent, so every reply is
 * rebuilt here from known-good parts:
 *   block → { decision:'block', reason:String(reason) }
 *   ready → { hookSpecificOutput:{ hookEventName:'UserPromptSubmit', additionalContext:String(ctx ?? '') } }
 *   anything else → failClosedPayload('UserPromptSubmit', …)
 * The conductor's `automationReadiness` key is dropped on the way; the CLI
 * would have stripped it anyway, and the pre-run reads it from runGuard directly.
 */
export function userPromptSubmitSafe(out: HookOutput): HookOutput {
  if (isRecord(out) && out.decision === 'block') {
    const reason = out.reason;
    return {
      decision: 'block',
      reason: reason === undefined || reason === null
        ? `The ${AUTOMATION_READY} guard blocked this session without saying why.`
        : String(reason),
    };
  }
  if (isRecord(out) && isRecord(out.automationReadiness) && out.automationReadiness.verdict === 'ready') {
    const hso = isRecord(out.hookSpecificOutput) ? out.hookSpecificOutput : {};
    const ctx = hso.additionalContext;
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: String(ctx ?? ''),
      },
    };
  }
  return failClosedPayload('UserPromptSubmit',
    `The ${AUTOMATION_READY} guard answered without a verdict, and it fails closed, so this session ` +
    'does not start. An operator has to fix the guard.');
}

/**
 * Guard-only variables for automation-ready.cjs. Merged into the guard child's env, NEVER into
 * the session env: the session reads GitLab through the MCP server, and a token in its
 * environment is a token it can print. May throw (no GITLAB_REPO_URL): callers catch.
 *
 * The token is the one call() reads with, handed over explicitly because the
 * desk's credential may live outside .env (src/lib/token.ts) where the
 * _common.cjs envFile() reader cannot see it. A desk with no token gets ''
 * here, which the script turns into a `config` block rather than a crash.
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
 * The conductor's pre-run: the SAME script, the SAME runGuard, a synthetic UserPromptSubmit payload.
 * Never throws: an automationGuardEnv() failure becomes failClosedPayload(...). `override` is merged
 * LAST (runGuard spreads process.env first, so a test cannot redirect the child any other way).
 *
 * This is the hard gate: it never passes through the CLI, so nothing can
 * swallow its answer. The in-session copy of the guard is the second line.
 */
export async function runAutomationReadyGuard(
  iid: number, override: Record<string, string> = {},
): Promise<HookOutput> {
  const event = 'UserPromptSubmit';
  try {
    const env = {
      ONESHOT_PHASE: AUTOMATION_PHASE,
      ONESHOT_TICKET: String(iid),
      ONESHOT_RUN_ID: 'automation-precheck',
      ...automationGuardEnv(),
      ...override,
    };
    const input = {
      hook_event_name: event,
      session_id: 'conductor-precheck',
      transcript_path: '',
      cwd: ROOT,
      prompt: '',
    };
    return await runGuard(AUTOMATION_READY, input, env);
  } catch (err) {
    log.warn(`guard ${AUTOMATION_READY} could not start`, { why: errorText(err) });
    return failClosedPayload(event,
      `The ${AUTOMATION_READY} guard could not start (${errorText(err)}), and it fails ` +
      'closed, so this session does not start. An operator has to fix the guard.');
  }
}

/** Tool-name matchers, mirroring hooks/hooks.settings.json. */
const WRITE_TOOLS = '^(Write|Edit|NotebookEdit)$';
const BASH = '^Bash$';
const MR_TOOLS = '^mcp__gitlab__(create|update)_merge_request$';
const READ_OR_BASH = '^(Read|NotebookRead|Grep|Bash)$';

/** One planned guard: which script, on which tool matcher, with which SDK timeout. */
export interface HookEntry {
  matcher?: string;
  script: string;
  /** Seconds — the SDK matcher timeout, not runGuard's kill. */
  timeout: number;
  /** The callback merges automationGuardEnv() into the guard child's env, lazily. */
  automationEnv?: true;
}

/**
 * Pure: which guard runs on which event for this phase env. Tests snapshot it;
 * hooksFor maps it to callbacks.
 *
 * `env` carries the phase identity the guards read (ONESHOT_PHASE,
 * ONESHOT_WRITE_SCOPES, ONESHOT_WORKTREE, …) — the same variables the
 * settings.json commands used to receive from the session environment.
 *
 * UserPromptSubmit exists ONLY for the automation phase. Every Loop phase gets
 * exactly the set it had before that mode existed, so a fail-closed guard
 * built for one on-demand phase cannot block the pipeline.
 */
export function hookPlan(env: Record<string, string>): Record<string, HookEntry[]> {
  const plan: Record<string, HookEntry[]> = {
    PreToolUse: [
      { script: 'pause-check.cjs', timeout: 15 },
      { matcher: WRITE_TOOLS, script: 'write-scope.cjs', timeout: 15 },
      { matcher: WRITE_TOOLS, script: 'frontend-test-guard.cjs', timeout: 15 },
      { matcher: BASH, script: 'git-guard.cjs', timeout: 20 },
      { matcher: MR_TOOLS, script: 'mr-gate.cjs', timeout: 15 },
      { matcher: READ_OR_BASH, script: 'secret-guard.cjs', timeout: 15 },
      // log-event stays last so a denied call is still recorded.
      { script: 'log-event.cjs', timeout: 10 },
    ],
    PostToolUse: [
      { matcher: WRITE_TOOLS, script: 'migration-standards.cjs', timeout: 20 },
      { matcher: WRITE_TOOLS, script: 'script-standards.cjs', timeout: 20 },
      { matcher: WRITE_TOOLS, script: 'py-lint.cjs', timeout: 60 },
      { matcher: WRITE_TOOLS, script: 'js-standards.cjs', timeout: 15 },
      // log-event stays last so a blocked write is still recorded.
      { script: 'log-event.cjs', timeout: 10 },
    ],
    SessionStart: [
      { script: 'budget-gate.cjs', timeout: 20 },
      // Self-gates to `testcases` and injects that skill's traps list. An
      // instruction to read a file is a request; a phase that has died at its
      // cap drops reads first. Injecting costs zero turns and cannot be skipped.
      { script: 'traps-brief.cjs', timeout: 15 },
    ],
  };
  if (env.ONESHOT_PHASE === AUTOMATION_PHASE) {
    // 45s sits above runGuard's 30s kill, which sits above the script's own
    // 20s deadline: whatever goes wrong, a block arrives before the SDK gives up.
    plan.UserPromptSubmit = [{ script: AUTOMATION_READY, timeout: 45, automationEnv: true }];
  }
  return plan;
}

/**
 * Build the hook set for one phase: hookPlan(env), each entry mapped to
 * `{ matcher?, hooks: [callback], timeout }`.
 *
 * An `automationEnv` callback NEVER throws and builds the guard env when it is
 * called, not here. A throw on the SDK side is swallowed by the CLI as `{}` —
 * an allow — so the callback catches everything and answers with a block; and
 * computing the env lazily means building a Loop phase's hooks never calls
 * projectConfig() or reads a token.
 */
export function hooksFor(env: Record<string, string>): Record<string, unknown[]> {
  const guard = (entry: HookEntry) => {
    if (!entry.automationEnv) {
      return async (input: unknown): Promise<HookOutput> => runGuard(entry.script, input, env);
    }
    return async (input: unknown): Promise<HookOutput> => {
      try {
        return userPromptSubmitSafe(await runGuard(entry.script, input, { ...env, ...automationGuardEnv() }));
      } catch (err) {
        return failClosedPayload('UserPromptSubmit',
          `the automation-ready guard could not start (${errorText(err)})`);
      }
    };
  };

  const hooks: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(hookPlan(env))) {
    hooks[event] = entries.map((e) => ({
      ...(e.matcher ? { matcher: e.matcher } : {}),
      hooks: [guard(e)],
      timeout: e.timeout,
    }));
  }
  return hooks;
}
