/**
 * The readiness script the conductor runs, and the guards the automation
 * session does NOT get.
 *
 * hooks/automation-ready.cjs is the Ready For Automation mode's readiness
 * check, run by the conductor through runGuard (runAutomationReadyGuard) and
 * registered as no session's hook: the automation session holds no tool a
 * hook could stand in front of. Pinned here: that session gets the same guards
 * as any Loop phase and nothing on UserPromptSubmit, the script answers before
 * runGuard would kill it, and every way the check can fail — GitLab down, no
 * token, a script that says nothing — reads as `unknown`, which the runner
 * holds on, without a FAIL_CLOSED entry.
 *
 * No test reads a real credential or calls a real host. The project is the
 * example one (test-project-env), the read token is set to a test value
 * BEFORE anything asks for it, and the tests that spawn the real script point
 * it at a closed local port and a throwaway ONESHOT_HOME.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DRY_RUN } from '../lib/config.js';
import { editIssueLabels, issuesWithLabel, readToken } from '../lib/gitlab.js';
import { scratchHome } from '../lib/test-scratch-home.js';
import { AUTOMATION_PHASE, readinessFromHookOutput } from '../automation/readiness.js';
import { guardTimeoutMs, hooksFor, runAutomationReadyGuard } from './hooks.js';

// Set rather than inherited, so this machine's .env and desk token cannot change the answer.
process.env.GITLAB_READ_TOKEN = 'test-read-token';
process.env.ONESHOT_GITLAB_TOKEN = 'test-write-token';

const hook = createRequire(import.meta.url)('../../hooks/automation-ready.cjs') as { DEADLINE_MS: number };

/** What the SDK is handed, minus the callbacks: event → [matcher, timeout] per entry. */
function shape(env: Record<string, string>): Record<string, Array<[string | undefined, number]>> {
  const out: Record<string, Array<[string | undefined, number]>> = {};
  for (const [event, entries] of Object.entries(hooksFor(env))) {
    out[event] = entries.map((raw) => {
      const e = raw as { matcher?: string; timeout: number };
      return [e.matcher, e.timeout];
    });
  }
  return out;
}

test('the automation session gets exactly the guards a Loop phase gets, and none on UserPromptSubmit', () => {
  const automation = shape({ ONESHOT_PHASE: AUTOMATION_PHASE });
  assert.deepEqual(automation, shape({ ONESHOT_PHASE: 'implement' }));
  assert.equal('UserPromptSubmit' in automation, false);
});

test('the readiness script gives its own answer before runGuard kills it', () => {
  const kill = guardTimeoutMs('automation-ready.cjs');
  assert.ok(hook.DEADLINE_MS < kill, `script ${hook.DEADLINE_MS} < kill ${kill}`);
  // Guards without an entry keep the default.
  assert.equal(guardTimeoutMs('pause-check.cjs'), 15_000);
  assert.equal(guardTimeoutMs('py-lint.cjs'), 60_000);
  // eslint-guard spawns eslint with its own 55s bound, so the kill must land
  // after that or the hook dies with nothing said about which file was slow.
  assert.equal(guardTimeoutMs('eslint-guard.cjs'), 60_000);
});

test('runAutomationReadyGuard with GitLab unreachable reads as unknown, with the reason', async () => {
  const { home, cleanup } = scratchHome();
  try {
    const out = await runAutomationReadyGuard(101, {
      ONESHOT_AUTOMATION_API: 'http://127.0.0.1:9/api/v4',
      ONESHOT_HOME: home,
    });
    assert.equal(out.decision, 'block');
    const r = readinessFromHookOutput(out, 101);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.errorKind, 'network');
    assert.match(r.error ?? '', /GitLab could not be reached/);
    assert.equal(JSON.stringify(out).includes('test-read-token'), false);
  } finally {
    cleanup();
  }
});

test('runAutomationReadyGuard with no token reads as unknown, a config problem, before any call', async () => {
  const { home, cleanup } = scratchHome();
  try {
    const out = await runAutomationReadyGuard(101, {
      ONESHOT_AUTOMATION_API: 'http://127.0.0.1:9/api/v4',
      ONESHOT_AUTOMATION_TOKEN: '',
      ONESHOT_HOME: home,
    });
    const r = readinessFromHookOutput(out, 101);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.errorKind, 'config');
    assert.match(r.error ?? '', /ONESHOT_AUTOMATION_TOKEN\) is missing/);
  } finally {
    cleanup();
  }
});

test('a readiness script that answers nothing reads as unknown, not ready, with no FAIL_CLOSED entry', async () => {
  // Outside its phase the script allows the way every guard does: exit 0,
  // empty stdout. runGuard fails that open to `{}`; the verdict must not.
  const { home, cleanup } = scratchHome();
  try {
    const out = await runAutomationReadyGuard(101, { ONESHOT_PHASE: 'implement', ONESHOT_HOME: home });
    assert.deepEqual(out, {});
    const r = readinessFromHookOutput(out, 101);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.error, 'the readiness hook gave no verdict');
  } finally {
    cleanup();
  }
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
