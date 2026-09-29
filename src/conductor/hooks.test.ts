/**
 * Which guards a phase gets, and how the one fail-closed guard fails.
 *
 * The Ready For Automation mode added the first UserPromptSubmit guard, and
 * the first guard since deploy-guard that must block when it cannot run. Both
 * facts are pinned here: every Loop phase keeps exactly the hook set it had,
 * and every way the readiness guard can go wrong ends in a reply the CLI reads
 * as a block — because a reply it cannot read is swallowed as `{}`, an allow.
 *
 * No test reads a real credential or calls a real host. The project is the
 * example one (test-project-env), the read token is set to a test value
 * BEFORE anything asks for it, and the one test that spawns the real script
 * points it at a closed local port.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRY_RUN, ROOT } from '../lib/config.js';
import { editIssueLabels, issuesWithLabel, readToken } from '../lib/gitlab.js';
import { AUTOMATION_PHASE, readinessFromHookOutput } from '../automation/readiness.js';
import {
  acceptsFailClosedOutput, failClosedPayload, guardTimeoutMs, hookPlan, hooksFor,
  runAutomationReadyGuard, userPromptSubmitSafe,
} from './hooks.js';

// Set rather than inherited, so this machine's .env and desk token cannot change the answer.
process.env.GITLAB_READ_TOKEN = 'test-read-token';
process.env.ONESHOT_GITLAB_TOKEN = 'test-write-token';

const hook = createRequire(import.meta.url)('../../hooks/automation-ready.cjs') as { DEADLINE_MS: number };

/** What every Loop phase ran before the automation mode existed — hooks.ts's hooksFor, verbatim. */
const LOOP_PLAN = {
  PreToolUse: [
    { script: 'pause-check.cjs', timeout: 15 },
    { matcher: '^(Write|Edit|NotebookEdit)$', script: 'write-scope.cjs', timeout: 15 },
    { matcher: '^(Write|Edit|NotebookEdit)$', script: 'frontend-test-guard.cjs', timeout: 15 },
    { matcher: '^Bash$', script: 'git-guard.cjs', timeout: 20 },
    { matcher: '^mcp__gitlab__(create|update)_merge_request$', script: 'mr-gate.cjs', timeout: 15 },
    { matcher: '^(Read|NotebookRead|Grep|Bash)$', script: 'secret-guard.cjs', timeout: 15 },
    { script: 'log-event.cjs', timeout: 10 },
  ],
  PostToolUse: [
    { matcher: '^(Write|Edit|NotebookEdit)$', script: 'migration-standards.cjs', timeout: 20 },
    { matcher: '^(Write|Edit|NotebookEdit)$', script: 'script-standards.cjs', timeout: 20 },
    { matcher: '^(Write|Edit|NotebookEdit)$', script: 'py-lint.cjs', timeout: 60 },
    { matcher: '^(Write|Edit|NotebookEdit)$', script: 'js-standards.cjs', timeout: 15 },
    { script: 'log-event.cjs', timeout: 10 },
  ],
  SessionStart: [
    { script: 'budget-gate.cjs', timeout: 20 },
    { script: 'traps-brief.cjs', timeout: 15 },
  ],
};

const LOOP_PHASES = [
  '', 'recall', 'research', 'design', 'plan', 'testcases', 'implement', 'review', 'mr',
  'ui-evidence', 'local-verify', 'remediate', 'mr-feedback',
];

test('a Loop phase gets exactly the guards it had', () => {
  for (const phase of LOOP_PHASES) {
    assert.deepEqual(hookPlan({ ONESHOT_PHASE: phase }), LOOP_PLAN, phase);

    // And the callbacks the SDK receives have the same shape they always had:
    // a matcher only where one is planned, one callback, the planned timeout.
    const built = hooksFor({ ONESHOT_PHASE: phase });
    assert.deepEqual(Object.keys(built), ['PreToolUse', 'PostToolUse', 'SessionStart'], phase);
    for (const [event, entries] of Object.entries(built)) {
      const planned = LOOP_PLAN[event as keyof typeof LOOP_PLAN];
      assert.equal(entries.length, planned.length);
      entries.forEach((raw, i) => {
        const entry = raw as { matcher?: string; hooks: unknown[]; timeout: number };
        const want = planned[i] as { matcher?: string; timeout: number };
        assert.deepEqual(Object.keys(entry), want.matcher ? ['matcher', 'hooks', 'timeout'] : ['hooks', 'timeout']);
        assert.equal(entry.matcher, want.matcher);
        assert.equal(entry.timeout, want.timeout);
        assert.equal(entry.hooks.length, 1);
        assert.equal(typeof entry.hooks[0], 'function');
      });
    }
  }
});

test('the readiness guard is planned only for the automation phase', () => {
  const plan = hookPlan({ ONESHOT_PHASE: AUTOMATION_PHASE });
  assert.deepEqual(plan.UserPromptSubmit, [{ script: 'automation-ready.cjs', timeout: 45, automationEnv: true }]);
  // Everything else the automation session runs is the Loop's set, unchanged.
  const { UserPromptSubmit: _ups, ...rest } = plan;
  assert.deepEqual(rest, LOOP_PLAN);

  const built = hooksFor({ ONESHOT_PHASE: AUTOMATION_PHASE }).UserPromptSubmit as
    Array<{ matcher?: string; hooks: unknown[]; timeout: number }>;
  assert.equal(built.length, 1);
  assert.equal(built[0]?.matcher, undefined);
  assert.equal(built[0]?.timeout, 45);
  assert.equal(typeof built[0]?.hooks[0], 'function');

  for (const phase of LOOP_PHASES) {
    assert.equal('UserPromptSubmit' in hookPlan({ ONESHOT_PHASE: phase }), false, phase);
  }
});

test('failClosedPayload speaks each event\'s language', () => {
  assert.deepEqual(failClosedPayload('UserPromptSubmit', 'no'), { decision: 'block', reason: 'no' });
  assert.deepEqual(failClosedPayload('PreToolUse', 'no'), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
  });
  const ups = failClosedPayload('UserPromptSubmit', 'no');
  assert.equal('continue' in ups, false);
  assert.equal('stopReason' in ups, false);
});

test('the guard gives up before the SDK does', () => {
  const kill = guardTimeoutMs('automation-ready.cjs');
  assert.ok(kill > 20_000 && kill < 45_000, String(kill));
  // The three deadlines nest: the script answers, then runGuard kills, then the SDK abandons.
  const sdk = (hookPlan({ ONESHOT_PHASE: AUTOMATION_PHASE }).UserPromptSubmit?.[0]?.timeout ?? 0) * 1000;
  assert.ok(hook.DEADLINE_MS < kill, `script ${hook.DEADLINE_MS} < kill ${kill}`);
  assert.ok(kill < sdk, `kill ${kill} < sdk ${sdk}`);
  // Guards without an entry keep the default.
  assert.equal(guardTimeoutMs('pause-check.cjs'), 15_000);
  assert.equal(guardTimeoutMs('py-lint.cjs'), 60_000);
});

/**
 * A throwaway ONESHOT_HOME whose config/ is this repo's, so the spawned hook
 * reads the real labels and branch policy but writes its event log to a temp
 * dir instead of this checkout's state/.
 */
function scratchHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'oneshot-ready-'));
  symlinkSync(join(ROOT, 'config'), join(home, 'config'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('runAutomationReadyGuard with GitLab unreachable blocks and reads as unknown', async () => {
  const { home, cleanup } = scratchHome();
  try {
    const out = await runAutomationReadyGuard(101, {
      ONESHOT_AUTOMATION_API: 'http://127.0.0.1:9/api/v4',
      ONESHOT_HOME: home,
    });
    assert.equal(out.decision, 'block');
    assert.equal(typeof out.reason, 'string');
    assert.equal('continue' in out, false);
    const r = readinessFromHookOutput(out, 101);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.errorKind, 'network');
    assert.match(r.error ?? '', /GitLab could not be reached/);
    assert.equal(JSON.stringify(out).includes('test-read-token'), false);
  } finally {
    cleanup();
  }
});

test('runAutomationReadyGuard with no token blocks as a config problem, before any call', async () => {
  const { home, cleanup } = scratchHome();
  try {
    const out = await runAutomationReadyGuard(101, {
      ONESHOT_AUTOMATION_API: 'http://127.0.0.1:9/api/v4',
      ONESHOT_AUTOMATION_TOKEN: '',
      ONESHOT_HOME: home,
    });
    assert.equal(out.decision, 'block');
    const r = readinessFromHookOutput(out, 101);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.errorKind, 'config');
    assert.match(r.error ?? '', /ONESHOT_AUTOMATION_TOKEN\) is missing/);
  } finally {
    cleanup();
  }
});

/** The CLI's UserPromptSubmit reply schema, as far as a callback can meet or miss it. */
function assertSchemaSafe(out: Record<string, unknown>, label: string): void {
  for (const k of Object.keys(out)) {
    assert.ok(['decision', 'reason', 'hookSpecificOutput'].includes(k), `${label}: unexpected key ${k}`);
  }
  if ('decision' in out) assert.ok(out.decision === 'approve' || out.decision === 'block', label);
  if ('reason' in out) assert.equal(typeof out.reason, 'string', label);
  if ('hookSpecificOutput' in out) {
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    assert.deepEqual(Object.keys(hso).sort(), ['additionalContext', 'hookEventName'], label);
    assert.equal(hso.hookEventName, 'UserPromptSubmit', label);
    assert.equal(typeof hso.additionalContext, 'string', label);
  }
}

test('every UserPromptSubmit reply passes the CLI\'s hook schema', () => {
  const readiness = { v: 1, verdict: 'ready', iid: 101 };
  const cases: Array<[string, unknown, 'block' | 'ready']> = [
    ['a block', { decision: 'block', reason: 'Not ready', automationReadiness: { verdict: 'not-ready' } }, 'block'],
    ['a block with a numeric reason', { decision: 'block', reason: 42 }, 'block'],
    ['a block with no reason', { decision: 'block' }, 'block'],
    ['a ready verdict', {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'merged !501' },
      automationReadiness: readiness,
    }, 'ready'],
    ['a ready verdict with no context', { automationReadiness: readiness }, 'ready'],
    ['a ready verdict with a numeric context', {
      hookSpecificOutput: { additionalContext: 7 }, automationReadiness: readiness,
    }, 'ready'],
    ['{}', {}, 'block'],
    ['a context without a verdict', { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' } }, 'block'],
    ['an approve', { decision: 'approve' }, 'block'],
    ['continue:false', { continue: false, stopReason: 'x' }, 'block'],
    ['null', null, 'block'],
    ['an array', [], 'block'],
    ['a string', 'garbage', 'block'],
  ];
  for (const [label, input, want] of cases) {
    const out = userPromptSubmitSafe(input as Record<string, unknown>);
    assertSchemaSafe(out, label);
    if (want === 'block') assert.equal(out.decision, 'block', label);
    else assert.equal('decision' in out, false, label);
  }
  assert.deepEqual(userPromptSubmitSafe({ decision: 'block', reason: 42 }), { decision: 'block', reason: '42' });
  assert.deepEqual(
    userPromptSubmitSafe({ hookSpecificOutput: { additionalContext: 'merged !501' }, automationReadiness: readiness }),
    { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'merged !501' } },
  );
});

test('a fail-closed guard that answers without a verdict is treated as broken', () => {
  const E = 'UserPromptSubmit';
  assert.equal(acceptsFailClosedOutput(E, {}), false);
  assert.equal(acceptsFailClosedOutput(E, { hookSpecificOutput: { hookEventName: E, additionalContext: 'x' } }), false);
  assert.equal(acceptsFailClosedOutput(E, { automationReadiness: { verdict: 'not-ready' } }), false);
  assert.equal(acceptsFailClosedOutput(E, { automationReadiness: { verdict: 'unknown' } }), false);
  assert.equal(acceptsFailClosedOutput(E, { decision: 'approve' }), false);
  assert.equal(acceptsFailClosedOutput(E, null as unknown as Record<string, unknown>), false);
  assert.equal(acceptsFailClosedOutput(E, { decision: 'block' }), true);
  assert.equal(acceptsFailClosedOutput(E, { decision: 'block', reason: 'x', automationReadiness: { verdict: 'not-ready' } }), true);
  assert.equal(acceptsFailClosedOutput(E, { automationReadiness: { verdict: 'ready' } }), true);
  // Other events keep the old contract: any JSON object is the guard's answer.
  assert.equal(acceptsFailClosedOutput('PreToolUse', {}), true);
});

// ------------------------------------------------ GitLab helpers the mode uses

const API = 'https://gitlab.example.com/api/v4';
const calls: Array<{ url: string; method: string; token: string; body: unknown }> = [];

function stubFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      token: headers.get('PRIVATE-TOKEN') ?? '',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(init?.method === 'PUT' ? { iid: 101, labels: [] } : []), { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test('readToken is the read credential the conductor itself reads with', () => {
  assert.equal(readToken(), 'test-read-token');
});

test('issuesWithLabel asks for one label in every state, minus the done label, newest first', async () => {
  const restore = stubFetch();
  try {
    calls.length = 0;
    await issuesWithLabel('Ready For Automation', { notLabel: 'Automation Done' });
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.token]), [[
      'GET',
      `${API}/projects/acme%2Ferp/issues?labels=Ready%20For%20Automation&state=all` +
        '&not%5Blabels%5D=Automation%20Done&per_page=100&order_by=updated_at&sort=desc',
      'test-read-token',
    ]]);
    calls.length = 0;
    await issuesWithLabel('Ready For Automation', { state: 'opened' });
    assert.equal(calls[0]?.url,
      `${API}/projects/acme%2Ferp/issues?labels=Ready%20For%20Automation&state=opened&per_page=100&order_by=updated_at&sort=desc`);
  } finally {
    restore();
  }
});

test('editIssueLabels adds and removes in one PUT as this desk, and an empty change makes no call', async () => {
  const restore = stubFetch();
  try {
    calls.length = 0;
    const res = await editIssueLabels(101, { add: ['Automation Done'], remove: ['Automation Test Case Review'] });
    assert.equal(res.ok, true);
    if (DRY_RUN) {
      assert.deepEqual(calls, []);                  // a dry run never writes
      return;
    }
    assert.deepEqual(calls, [{
      url: `${API}/projects/acme%2Ferp/issues/101`,
      method: 'PUT',
      token: 'test-write-token',
      body: { add_labels: 'Automation Done', remove_labels: 'Automation Test Case Review' },
    }]);
    calls.length = 0;
    assert.equal((await editIssueLabels(101, { add: [], remove: [] })).ok, true);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});
