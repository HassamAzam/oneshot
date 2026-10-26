/**
 * The session environment a provider actually produces, measured in a fresh
 * process.
 *
 * config.ts builds BASE_ENV once, at module load, and the ORDER inside it is
 * the control: whatever ANTHROPIC_* the shell was carrying is deleted, and only
 * then does the chosen provider put its own names back. That ordering cannot be
 * observed from inside an already-loaded module — ES imports run before any
 * assignment a test file makes — so each case boots a conductor-shaped process
 * with an environment of its own and reports what reached it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const KEY = 'sk-not-a-real-key';

/** The variables a session would be started with, plus what the audit says about them. */
interface Boot {
  base: Record<string, string | undefined>;
  credential: string;
  problems: string[];
  notes: string[];
  provider: string;
  billing: string;
  models: Record<string, string>;
  printed: string;
}

/**
 * Printed by the probe process. A dynamic import of an absolute URL, because
 * `tsx -e` resolves a relative static import against `[eval]` rather than the
 * working directory.
 */
const PROBE = `
Promise.all([
  import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "lib", "config.ts")).href)}),
  import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "lib", "provider.ts")).href)}),
]).then(([c, pv]) => {
  const auth = c.auditAuth();
  const p = c.llmProvider();
  const named = (n) => { const cfg = c.phaseByName(n); return cfg ? c.modelFor(cfg) : ''; };
  console.log('@@' + JSON.stringify({
    base: Object.fromEntries(['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY',
      'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_DISABLE_1M_CONTEXT','GITLAB_TOKEN']
      .map((k) => [k, c.BASE_ENV[k]])),
    credential: auth.credential,
    problems: auth.problems, notes: auth.notes,
    provider: p.name, billing: p.billing,
    models: { heavy: named('research'), standard: named('implement'), design: named('design'), narrator: c.narratorModel() },
    printed: [pv.describeProvider(p), auth.credential, ...auth.problems, ...auth.notes].join(' | '),
  }));
}).catch((e) => { console.error(e); process.exit(1); });
`;

/**
 * Boot config.ts in a process whose whole environment is the argument, and
 * report what a session would have been started with. The environment is built
 * rather than inherited, so the desk running the suite cannot change the answer.
 */
/**
 * Every variable these cases are about, blanked.
 *
 * Load-bearing, not tidiness: the probe runs in this repo, config.ts loads this
 * repo's .env, and dotenv fills any key that is ABSENT. A desk with a real
 * ONESHOT_LLM_API_KEY in .env would therefore hand one to the case that asserts
 * a provider with NO key refuses — and the case would fail on a configured desk
 * while passing on a bare checkout. Blanking is what makes the environment the
 * argument rather than a property of whoever is running the suite; readEnv()
 * counts a blank as unset, so '' is the same as never-set to the code.
 */
const NEUTRAL: Record<string, string> = Object.fromEntries([
  'ONESHOT_LLM_PROVIDER', 'ONESHOT_LLM_API_KEY', 'ONESHOT_LLM_BASE_URL', 'ONESHOT_LLM_AUTH',
  'ONESHOT_LLM_MODEL_HEAVY', 'ONESHOT_LLM_MODEL_STANDARD', 'ONESHOT_LLM_MODEL_LIGHT',
  'ONELOOP_LLM_PROVIDER', 'ONELOOP_LLM_API_KEY',
  'ONESHOT_LLM_MODEL_DESIGN', 'ONELOOP_LLM_MODEL_DESIGN',
  'ONESHOT_REQUIRE_SUBSCRIPTION', 'ONESHOT_ALLOW_1M_CONTEXT',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
].map((k) => [k, '']));

function boot(overrides: Record<string, string>): Boot {
  let out: string;
  try {
    out = execFileSync(TSX, ['-e', PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GITLAB_REPO_URL: 'https://gitlab.example.com/acme/erp',
        GITLAB_TOKEN: 'glpat-not-a-real-token',
        ...NEUTRAL,
        ...overrides,
      },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    assert.fail(`the probe process failed: ${e.message}\n${e.stderr ?? ''}${e.stdout ?? ''}`);
  }
  const line = out.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `the probe printed no result:\n${out}`);
  return JSON.parse(line.slice(2)) as Boot;
}

test('a metered provider routes and authenticates every session', () => {
  const b = boot({ ONESHOT_LLM_PROVIDER: 'deepseek', ONESHOT_LLM_API_KEY: KEY });
  assert.equal(b.provider, 'deepseek');
  assert.equal(b.billing, 'metered');
  assert.equal(b.base.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(b.base.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(b.base.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro[1m]');
  assert.deepEqual(b.problems, []);
  assert.match(b.credential, /metered: deepseek/);
  // Unrelated controls are untouched: the session is still an allowlist.
  assert.equal(b.base.GITLAB_TOKEN, undefined, 'the GitLab token still goes only to the MCP server');
  // The 1M switch is about Anthropic's purchased credits, so it does not travel
  // here — and must not, since this preset's model names carry the `[1m]` suffix
  // the flag would strip.
  assert.equal(b.base.CLAUDE_CODE_DISABLE_1M_CONTEXT, undefined);
  assert.equal(b.base.ANTHROPIC_DEFAULT_OPUS_MODEL?.endsWith('[1m]'), true);
});

test("the shell's own credentials never survive, whichever provider is chosen", () => {
  const dirty = {
    ANTHROPIC_BASE_URL: 'https://proxy.invalid',
    ANTHROPIC_API_KEY: 'sk-ant-from-the-shell',
    ANTHROPIC_AUTH_TOKEN: 'token-from-the-shell',
    CLAUDE_CODE_USE_BEDROCK: '1',
  };
  const metered = boot({ ...dirty, ONESHOT_LLM_PROVIDER: 'deepseek', ONESHOT_LLM_API_KEY: KEY });
  assert.equal(metered.base.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(metered.base.ANTHROPIC_AUTH_TOKEN, KEY, "the desk's chosen key, not the shell's");
  assert.equal(metered.base.ANTHROPIC_API_KEY, undefined);
  assert.equal(metered.base.CLAUDE_CODE_USE_BEDROCK, undefined);

  const sub = boot({ ...dirty, ONESHOT_LLM_PROVIDER: 'claude' });
  for (const k of Object.keys(dirty)) assert.equal(sub.base[k], undefined, `${k} reached a subscription session`);
  assert.match(sub.credential, /subscription/);
  // The old behaviour, unchanged: a key in the shell still bills the operator's
  // own interactive sessions, so it is still a doctor failure.
  assert.ok(sub.problems.some((p) => p.includes('ANTHROPIC_API_KEY')));
});

test('the subscription desk is exactly what it was', () => {
  const b = boot({ ONESHOT_LLM_PROVIDER: 'claude', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' });
  assert.equal(b.base.ANTHROPIC_BASE_URL, undefined, 'the runtime goes to its own endpoint');
  assert.equal(b.base.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-token', 'a headless desk still gets its token');
  assert.equal(b.base.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1', 'the paid 1M window stays off on the subscription');
  assert.deepEqual(b.models, {
    heavy: 'claude-opus-5',
    standard: 'claude-sonnet-5',
    design: 'claude-opus-5',
    narrator: 'claude-haiku-4-5-20251001',
  }, 'config/models.json still decides on the subscription, design included');
  assert.deepEqual(b.problems, []);
});

test('the subscription token stays behind on a metered desk', () => {
  const b = boot({ ONESHOT_LLM_PROVIDER: 'deepseek', ONESHOT_LLM_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' });
  assert.equal(b.base.CLAUDE_CODE_OAUTH_TOKEN, undefined,
    'two model credentials in one session is one more than anything needs');
});

test('every phase keeps a model when the provider supplies the tiers', () => {
  const b = boot({ ONESHOT_LLM_PROVIDER: 'deepseek', ONESHOT_LLM_API_KEY: KEY });
  assert.equal(b.models.heavy, 'deepseek-v4-pro[1m]');
  assert.equal(b.models.standard, 'deepseek-flash[1m]');
  assert.equal(b.models.narrator, 'deepseek-flash');
});

test('a half-configured provider refuses boot instead of starting a session', () => {
  const b = boot({ ONESHOT_LLM_PROVIDER: 'deepseek' });
  assert.ok(b.problems.some((p) => p.includes('ONESHOT_LLM_API_KEY')));
  assert.equal(b.base.ANTHROPIC_BASE_URL, undefined, 'nothing is half-wired into a session');
  assert.equal(b.base.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('no key ever reaches a log line', () => {
  const cases: Record<string, string>[] = [
    { ONESHOT_LLM_PROVIDER: 'deepseek', ONESHOT_LLM_API_KEY: KEY },
    { ONESHOT_LLM_PROVIDER: 'deepseek', ONESHOT_LLM_API_KEY: KEY, ONESHOT_LLM_AUTH: 'x-api-key' },
  ];
  for (const env of cases) {
    const b = boot(env);
    assert.ok(!b.printed.includes(KEY), `a key reached printed output: ${b.printed}`);
  }
});

test('one phase can be pinned to one model without moving its tier', () => {
  // The measured case: `design` renders mockups and is then told to read its own
  // screenshots critically, which needs vision — and this provider's heavy model
  // cannot see. Moving the heavy tier would change six other phases to fix one.
  const b = boot({
    ONESHOT_LLM_PROVIDER: 'deepseek',
    ONESHOT_LLM_API_KEY: KEY,
    ONESHOT_LLM_MODEL_DESIGN: 'deepseek-flash[1m]',
  });
  assert.equal(b.models.design, 'deepseek-flash[1m]', 'the pinned phase takes the pin');
  assert.equal(b.models.heavy, 'deepseek-v4-pro[1m]', 'its tier-mates are untouched');
  assert.equal(b.models.standard, 'deepseek-flash[1m]');
  assert.deepEqual(b.problems, []);
});

test('with nothing pinned, design is just another heavy phase', () => {
  const b = boot({ ONESHOT_LLM_PROVIDER: 'deepseek', ONESHOT_LLM_API_KEY: KEY });
  assert.equal(b.models.design, b.models.heavy);
});

test('a pin works on the subscription too, and changes nothing else', () => {
  const b = boot({ ONESHOT_LLM_PROVIDER: 'claude', ONESHOT_LLM_MODEL_DESIGN: 'claude-sonnet-5' });
  assert.equal(b.models.design, 'claude-sonnet-5');
  assert.equal(b.models.heavy, 'claude-opus-5', 'config/models.json still decides the tiers');
});
