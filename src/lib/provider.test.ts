/**
 * The provider switch, and the invariant it must not break: a credential
 * reaches a session only when this desk chose one on purpose, and then only
 * the one it chose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_KEY_VAR, AUTH_VAR, BASE_URL_VAR, PROVIDER_VAR, TIERS,
  describeProvider, resolveProvider, tierVar, type ProvidersTable,
} from './provider.js';

const TABLE: ProvidersTable = {
  default: 'claude',
  providers: {
    claude: { label: 'Claude subscription', billing: 'subscription' },
    deepseek: {
      label: 'DeepSeek',
      billing: 'metered',
      baseUrl: 'https://api.deepseek.com/anthropic',
      auth: 'bearer',
      tiers: { heavy: 'deepseek-v4-pro', standard: 'deepseek-flash', light: 'deepseek-flash' },
      env: { API_TIMEOUT_MS: '600000' },
      notes: ['no prompt caching here'],
    },
    custom: { billing: 'metered', auth: 'bearer' },
  },
};

const KEY = 'sk-not-a-real-key';
const metered = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ [PROVIDER_VAR]: 'deepseek', [API_KEY_VAR]: KEY, ...extra });

test('no provider set is the Claude subscription, and nothing reaches the session', () => {
  const p = resolveProvider(TABLE, {});
  assert.equal(p.name, 'claude');
  assert.equal(p.billing, 'subscription');
  assert.deepEqual(p.sessionEnv, {});
  assert.deepEqual(p.problems, []);
  assert.equal(p.tiers, null, 'the subscription takes its models from config/models.json');
});

test('the legacy ONELOOP_ spelling selects a provider too', () => {
  const p = resolveProvider(TABLE, { ONELOOP_LLM_PROVIDER: 'deepseek', ONELOOP_LLM_API_KEY: KEY });
  assert.equal(p.name, 'deepseek');
  assert.deepEqual(p.problems, []);
  assert.equal(p.sessionEnv.ANTHROPIC_AUTH_TOKEN, KEY);
});

test('a metered provider routes, authenticates and maps every alias', () => {
  const env = resolveProvider(TABLE, metered()).sessionEnv;
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'bearer auth must not also set the x-api-key name');
  // The aliases are not decoration: the bundled subagents in context/agents/*.md
  // ask for `opus`/`sonnet`, and the runtime makes its own background calls on
  // the haiku one. Unmapped, each would ask DeepSeek for a Claude model.
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-flash');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-flash');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-flash');
});

test('x-api-key auth sends the key under that name and no other', () => {
  const p = resolveProvider(TABLE, metered({ [AUTH_VAR]: 'x-api-key' }));
  assert.equal(p.authVar, 'ANTHROPIC_API_KEY');
  assert.equal(p.sessionEnv.ANTHROPIC_API_KEY, KEY);
  assert.equal(p.sessionEnv.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("the preset's own variables travel, and .env overrides the preset", () => {
  const p = resolveProvider(TABLE, metered({
    [BASE_URL_VAR]: 'https://ark.example.com/api/v3/anthropic/',
    [tierVar('heavy')]: 'my-big-model',
  }));
  assert.equal(p.sessionEnv.API_TIMEOUT_MS, '600000');
  assert.equal(p.sessionEnv.ANTHROPIC_BASE_URL, 'https://ark.example.com/api/v3/anthropic',
    'a trailing slash is trimmed: the runtime appends its own path');
  assert.equal(p.sessionEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'my-big-model');
  assert.equal(p.tiers?.standard, 'deepseek-flash', 'an override of one tier leaves the others alone');
});

test('a key with no provider is ignored rather than leaked', () => {
  const p = resolveProvider(TABLE, { [API_KEY_VAR]: KEY });
  assert.equal(p.billing, 'subscription');
  assert.deepEqual(p.sessionEnv, {}, 'the key must not reach a session that is not using it');
  assert.ok(p.notes.some((n) => n.includes('ignored')));
  assert.deepEqual(p.problems, []);
});

test('a half-configured provider is a problem, and sends nothing', () => {
  const noKey = resolveProvider(TABLE, { [PROVIDER_VAR]: 'deepseek' });
  assert.ok(noKey.problems.some((p) => p.includes(API_KEY_VAR)));
  assert.deepEqual(noKey.sessionEnv, {}, 'a session that would fail must not start half-wired');

  const custom = resolveProvider(TABLE, { [PROVIDER_VAR]: 'custom', [API_KEY_VAR]: KEY });
  assert.ok(custom.problems.some((p) => p.includes(BASE_URL_VAR)));
  for (const tier of TIERS) assert.ok(custom.problems.some((p) => p.includes(tierVar(tier))));
  assert.deepEqual(custom.sessionEnv, {});
});

test('an unknown provider name is named, with the ones that exist', () => {
  const p = resolveProvider(TABLE, { [PROVIDER_VAR]: 'gpt5', [API_KEY_VAR]: KEY });
  assert.ok(p.problems[0]?.includes('gpt5'));
  assert.ok(p.problems[0]?.includes('deepseek'));
  assert.deepEqual(p.sessionEnv, {});
});

test('a base URL that is not a URL is refused, not forwarded', () => {
  const p = resolveProvider(TABLE, metered({ [BASE_URL_VAR]: 'ark.example.com' }));
  assert.ok(p.problems.some((x) => x.includes('not a URL')));
  assert.deepEqual(p.sessionEnv, {});
});

test('pointing a metered provider at Anthropic is allowed but said out loud', () => {
  const p = resolveProvider(TABLE, metered({ [BASE_URL_VAR]: 'https://api.anthropic.com' }));
  assert.deepEqual(p.problems, []);
  assert.ok(p.notes.some((n) => n.includes('metered')), 'that is the subscription becoming a bill');
});

test('nothing printed about a provider contains its key', () => {
  for (const env of [metered(), metered({ [AUTH_VAR]: 'x-api-key' }), { [PROVIDER_VAR]: 'deepseek' }]) {
    const p = resolveProvider(TABLE, env);
    const printed = [describeProvider(p), ...p.problems, ...p.notes].join(' ');
    assert.ok(!printed.includes(KEY), `the key leaked into output: ${printed}`);
    assert.equal(typeof p.hasKey, 'boolean');
  }
});

test('the shipped config/providers.json resolves for every preset it offers', () => {
  const table = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'config', 'providers.json'), 'utf8'),
  ) as ProvidersTable;
  assert.equal(table.default, 'claude');
  assert.equal(table.providers.claude?.billing, 'subscription');

  for (const [name, preset] of Object.entries(table.providers)) {
    if (preset.billing !== 'metered') continue;
    const p = resolveProvider(table, { [PROVIDER_VAR]: name, [API_KEY_VAR]: KEY });
    // `custom` is configured entirely from .env, so it is incomplete by design;
    // a named preset must work from its own file plus a key.
    if (name === 'custom') { assert.ok(p.problems.length > 0); continue; }
    assert.deepEqual(p.problems, [], `${name} should be usable with only a key: ${p.problems.join('; ')}`);
    assert.ok(p.sessionEnv.ANTHROPIC_BASE_URL?.startsWith('https://'), `${name} needs an https endpoint`);
    for (const tier of TIERS) assert.ok(p.tiers?.[tier], `${name} is missing the ${tier} tier`);
    assert.ok(preset.notes?.length, `${name} should say what it costs a reader to know`);
  }
});
