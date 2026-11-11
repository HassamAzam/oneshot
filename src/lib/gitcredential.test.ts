/**
 * The git credential helper answers git, and only git, for one host.
 *
 * A phase session's environment carries no GitLab token by design, and the
 * helper the server was set up with read the token from the environment — so
 * every `git fetch` and `git push` inside a session failed "HTTP Basic: Access
 * denied" (#9174's `mr` phase). scripts/git-credential-oneshot.cjs resolves the
 * token itself. What must stay true is narrow: it answers `get` for the
 * configured GitLab host over https, the environment outranks the file so the
 * conductor is unchanged, and anything else gets no answer at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from './config.js';

type Answer = { username: string; password: string } | null;
const helperPath = join(ROOT, 'scripts', 'git-credential-oneshot.cjs');
const helper = createRequire(import.meta.url)(helperPath) as {
  answer(op: string, request: Record<string, string>, env: Record<string, string | undefined>,
    fileEnv: Record<string, string>): Answer;
  parseRequest(text: string): Record<string, string>;
};

const FILE = { GITLAB_REPO_URL: 'https://gitlab.example.com/acme/erp', GITLAB_TOKEN: 'file-token' };
const REQ = { protocol: 'https', host: 'gitlab.example.com' };

test('a session with no token in its environment is answered from the env file', () => {
  assert.deepEqual(helper.answer('get', REQ, {}, FILE), { username: 'oauth2', password: 'file-token' });
});

test('the environment outranks the file, so the conductor authenticates as it always did', () => {
  assert.equal(helper.answer('get', REQ, { ONESHOT_GITLAB_TOKEN: 'env-token' }, FILE)?.password, 'env-token');
  // An empty variable is unset, not an empty password: that is the exact
  // shape that produced "Access denied" inside a session.
  assert.equal(helper.answer('get', REQ, { ONESHOT_GITLAB_TOKEN: '', GITLAB_TOKEN: ' ' }, FILE)?.password, 'file-token');
});

test('ONESHOT_GITLAB_TOKEN is preferred to GITLAB_TOKEN, as src/lib/token.ts prefers it', () => {
  const file = { ...FILE, ONESHOT_GITLAB_TOKEN: 'bot-token' };
  assert.equal(helper.answer('get', REQ, {}, file)?.password, 'bot-token');
});

test('another host gets nothing, however the remote was pointed there', () => {
  assert.equal(helper.answer('get', { protocol: 'https', host: 'evil.example.net' }, {}, FILE), null);
  assert.equal(helper.answer('get', { protocol: 'https', host: 'gitlab.example.com.evil.net' }, {}, FILE), null);
  assert.equal(helper.answer('get', { protocol: 'http', host: 'gitlab.example.com' }, {}, FILE), null);
});

test('store and erase are no-ops, and a request with no host is not answered', () => {
  assert.equal(helper.answer('store', REQ, {}, FILE), null);
  assert.equal(helper.answer('erase', REQ, {}, FILE), null);
  assert.equal(helper.answer('get', { protocol: 'https' }, {}, FILE), null);
});

test('no configured repo or no token is no answer, not an empty password', () => {
  assert.equal(helper.answer('get', REQ, {}, { GITLAB_TOKEN: 'file-token' }), null);
  assert.equal(helper.answer('get', REQ, {}, { GITLAB_REPO_URL: FILE.GITLAB_REPO_URL }), null);
  assert.equal(helper.answer('get', REQ, {}, { GITLAB_REPO_URL: 'not a url', GITLAB_TOKEN: 'x' }), null);
});

test('git\'s request lines are read as key=value, values kept whole', () => {
  assert.deepEqual(helper.parseRequest('protocol=https\nhost=gitlab.example.com\npath=a=b\n\n'),
    { protocol: 'https', host: 'gitlab.example.com', path: 'a=b' });
});

test('run as git runs it, the process prints both lines for get and nothing for erase', () => {
  const env = {
    PATH: process.env.PATH ?? '', GITLAB_REPO_URL: FILE.GITLAB_REPO_URL, ONESHOT_GITLAB_TOKEN: 'env-token',
  };
  const run = (op: string): string => execFileSync(process.execPath, [helperPath, op], {
    input: 'protocol=https\nhost=gitlab.example.com\n\n', env, encoding: 'utf8',
  });
  assert.equal(run('get'), 'username=oauth2\npassword=env-token\n');
  assert.equal(run('erase'), '');
});
