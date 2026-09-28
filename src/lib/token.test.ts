/**
 * Where an operator is sent to create a token, and which GitLab a token is
 * checked against, both follow GITLAB_REPO_URL — a token minted on any other
 * instance could not act on the project. Both are read at call time: token.ts
 * and identity.ts are evaluated before config.ts has loaded .env, so anything
 * captured at import would never see the URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupHint, tokenPageUrl } from './token.js';
import { checkIdentity, tokenIdentity } from './identity.js';

function withUrl<T>(url: string, fn: () => T): T {
  const before = process.env.GITLAB_REPO_URL;
  process.env.GITLAB_REPO_URL = url;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.GITLAB_REPO_URL;
    else process.env.GITLAB_REPO_URL = before;
  }
}

test('the token page is on the GitLab the URL names, port and scheme included', () => {
  assert.equal(withUrl('https://gitlab.example.com/acme/erp', tokenPageUrl),
    'https://gitlab.example.com/-/user_settings/personal_access_tokens');
  assert.equal(withUrl('http://gitlab.internal:8080/acme/erp', tokenPageUrl),
    'http://gitlab.internal:8080/-/user_settings/personal_access_tokens');
  assert.equal(withUrl('git@gitlab.example.com:acme/erp.git', tokenPageUrl),
    'https://gitlab.example.com/-/user_settings/personal_access_tokens');
  assert.match(withUrl('https://gitlab.example.com/acme/erp', setupHint),
    /Create one at https:\/\/gitlab\.example\.com\/-\/user_settings\/personal_access_tokens/);
});

test('without a URL the hint says where the host comes from instead of inventing one', () => {
  assert.match(withUrl('', tokenPageUrl), /GITLAB_REPO_URL/);
});

test('without a URL there is no GitLab to ask who a token is, and the warning says so', async () => {
  const before = { url: process.env.GITLAB_REPO_URL, tok: process.env.ONESHOT_GITLAB_TOKEN };
  process.env.GITLAB_REPO_URL = '';
  process.env.ONESHOT_GITLAB_TOKEN = 'glpat-test';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  try {
    assert.equal(await tokenIdentity(), null);
    const idc = await checkIdentity();
    assert.match(idc.warning ?? '', /GITLAB_REPO_URL is unset or invalid/);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['GITLAB_REPO_URL', before.url], ['ONESHOT_GITLAB_TOKEN', before.tok]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
