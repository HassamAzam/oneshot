/**
 * The guards the conductor hands a session, and the GitLab helpers the local
 * automation tests mode writes labels with.
 *
 * Pinned here: a Glob that hunts for the Cypress credentials reaches
 * secret-guard, the guards read the local-tests paths the way the config does,
 * the guards that need longer than the default get it, and the label helpers
 * send exactly one request as this desk.
 *
 * No test reads a real credential or calls a real host. The project is the
 * example one (test-project-env), the read token is set to a test value
 * BEFORE anything asks for it, and the tests that spawn a real guard point it
 * at a throwaway ONESHOT_HOME.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DRY_RUN, localTestsConfig } from '../lib/config.js';
import { editIssueLabels, issuesWithLabel, readToken } from '../lib/gitlab.js';
import { scratchHome } from '../lib/test-scratch-home.js';
import { guardTimeoutMs, hooksFor } from './hooks.js';

// Set rather than inherited, so this machine's .env and desk token cannot change the answer.
process.env.GITLAB_READ_TOKEN = 'test-read-token';
process.env.ONESHOT_GITLAB_TOKEN = 'test-write-token';

const common = createRequire(import.meta.url)('../../hooks/_common.cjs') as {
  localTests: (env?: Record<string, string | undefined>) => { repo: string; creds: string };
};

type HookFn = (input: unknown) => Promise<Record<string, unknown>>;
type Entry = { matcher?: string; hooks: HookFn[] };

function denial(out: Record<string, unknown>): string | null {
  const h = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
  return h?.permissionDecision === 'deny' ? h.permissionDecisionReason ?? '' : null;
}

test('a Glob reaches secret-guard: one hunting for cypress.env.json is denied, one for specs is not', async () => {
  // Routed the way the SDK routes it: every PreToolUse entry whose matcher takes
  // `Glob` (or that has none) runs. Dropping Glob from secret-guard's matcher
  // leaves the script's own test green and this one red.
  const { home, cleanup } = scratchHome();
  try {
    const entries = hooksFor({ ONESHOT_PHASE: 'implement', ONESHOT_HOME: home }).PreToolUse as Entry[];
    const routed = entries.filter((e) => e.matcher === undefined || new RegExp(e.matcher).test('Glob'));
    const run = async (pattern: string): Promise<string[]> => {
      const outs = await Promise.all(routed.flatMap((e) => e.hooks.map((h) => h({
        hook_event_name: 'PreToolUse', tool_name: 'Glob', cwd: home, tool_input: { pattern, path: home },
      }))));
      return outs.map(denial).filter((r): r is string => r !== null);
    };
    const hunt = await run('**/cypress.env.json');
    assert.equal(hunt.length, 1, 'exactly one guard refuses it');
    assert.match(hunt[0] ?? '', /Cypress credentials/);
    assert.deepEqual(await run('cypress/e2e/**/*.cy.ts'), []);
  } finally {
    cleanup();
  }
});

test('the guards read the local-tests paths as localTestsConfig() does: spelling, placeholders, ~ and relative paths', () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ['unset', {}],
    ['plain', { ONESHOT_LOCAL_TESTS_REPO: '/tmp/wsa', ONESHOT_LOCAL_TESTS_CREDS: '/tmp/creds.json' }],
    ['legacy spelling', { ONELOOP_LOCAL_TESTS_REPO: '~/wsa', ONELOOP_LOCAL_TESTS_CREDS: '~/secrets/wsa.json' }],
    ['ONESHOT_ wins over ONELOOP_', { ONESHOT_LOCAL_TESTS_REPO: '/tmp/a', ONELOOP_LOCAL_TESTS_REPO: '/tmp/b' }],
    ['placeholders count as unset', { ONESHOT_LOCAL_TESTS_REPO: '<your/path/to>/wsa', ONESHOT_LOCAL_TESTS_CREDS: 'REPLACE_ME' }],
    ['blank falls through to the legacy spelling', { ONESHOT_LOCAL_TESTS_REPO: '', ONELOOP_LOCAL_TESTS_REPO: '/tmp/legacy' }],
    ['relative to the checkout', { ONESHOT_LOCAL_TESTS_REPO: 'wsa', ONESHOT_LOCAL_TESTS_CREDS: 'creds.json' }],
  ];
  for (const [name, env] of cases) {
    const want = localTestsConfig(undefined, env);
    assert.deepEqual(common.localTests(env), { repo: want.repo, creds: want.credsFile }, name);
  }
});

test('the guards that need longer than the default get it, and every other keeps the default', () => {
  // Guards without an entry keep the default.
  assert.equal(guardTimeoutMs('pause-check.cjs'), 15_000);
  assert.equal(guardTimeoutMs('py-lint.cjs'), 60_000);
  // eslint-guard spawns eslint with its own 55s bound, so the kill must land
  // after that or the hook dies with nothing said about which file was slow.
  assert.equal(guardTimeoutMs('eslint-guard.cjs'), 60_000);
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
    await issuesWithLabel('Ready for Automation Testing', { notLabel: 'Automation Testing Done' });
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.token]), [[
      'GET',
      `${API}/projects/acme%2Ferp/issues?labels=Ready%20for%20Automation%20Testing&state=all` +
        '&not%5Blabels%5D=Automation%20Testing%20Done&per_page=100&order_by=updated_at&sort=desc',
      'test-read-token',
    ]]);
    calls.length = 0;
    await issuesWithLabel('Ready for Automation Testing', { state: 'opened' });
    assert.equal(calls[0]?.url,
      `${API}/projects/acme%2Ferp/issues?labels=Ready%20for%20Automation%20Testing&state=opened&per_page=100&order_by=updated_at&sort=desc`);
  } finally {
    restore();
  }
});

test('editIssueLabels adds and removes in one PUT as this desk, and an empty change makes no call', async () => {
  const restore = stubFetch();
  try {
    calls.length = 0;
    const res = await editIssueLabels(101, { add: ['Running TestCases Locally'], remove: ['Ready for Automation Testing'] });
    assert.equal(res.ok, true);
    if (DRY_RUN) {
      assert.deepEqual(calls, []);                  // a dry run never writes
      return;
    }
    assert.deepEqual(calls, [{
      url: `${API}/projects/acme%2Ferp/issues/101`,
      method: 'PUT',
      token: 'test-write-token',
      body: { add_labels: 'Running TestCases Locally', remove_labels: 'Ready for Automation Testing' },
    }]);
    calls.length = 0;
    assert.equal((await editIssueLabels(101, { add: [], remove: [] })).ok, true);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});
