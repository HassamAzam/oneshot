/**
 * The read token being blind to the project it is pointed at.
 *
 * GITLAB_READ_TOKEN wins over the desk credential for every read, and a token
 * that is not a member of the project is not told so: GitLab answers the list
 * endpoints with 200 and an EMPTY ARRAY rather than 403. So
 * `issuesWithEntryLabel()` comes back clean and empty, the watcher reports "no
 * tickets carry the entry label", the desk claims nothing, and every line of
 * that is green. `permissions.project_access` is the field that tells it apart
 * from a genuinely empty board, and these cases pin the reading of it.
 *
 * The other half of the check is what it must NOT do. A VPN blip has to leave
 * the conductor running, and an unset variable has to cost nothing at all —
 * which is why the stub records attempts instead of only answering them.
 *
 * Nothing here touches the network or this machine's own credentials: both
 * tokens are pinned per case and restored afterwards, and fetch is a stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectConfig } from './config.js';
import { checkReadAccess } from './gitlab.js';
import type { ReadAccessCheck } from './gitlab.js';

const VAR = 'GITLAB_READ_TOKEN';
const DESK_VAR = 'ONESHOT_GITLAB_TOKEN';
const READ_TOKEN = 'glpat-fake-read-token';
const DESK_TOKEN = 'glpat-fake-desk-token';

interface Attempt { url: string; token: string }

const PROJECT = projectConfig().gitlab.project;
const passing = (result: ReadAccessCheck): void =>
  assert.deepEqual(result, { ok: true, scoped: true, project: PROJECT });

const jsonReply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/**
 * Run the check with GITLAB_READ_TOKEN pinned to `token` and fetch answered by
 * `reply`, then put this machine's own variables and fetch back.
 *
 * The desk credential is pinned too, and to a value that resolves. It is the
 * fallback the read token displaces, and leaving it to the machine would make
 * the unset case pass for the wrong reason on a desk that has no token file:
 * the call would be attempted and die in `token()` before ever reaching fetch,
 * which looks exactly like not calling at all.
 *
 * The returned `attempts` are what make "asks nothing" provable — a check that
 * dialled GitLab and then discarded the answer returns the same shape.
 */
async function check(
  token: string | undefined,
  reply: () => Response | Promise<Response> = () => jsonReply({}),
): Promise<{ result: ReadAccessCheck; attempts: Attempt[] }> {
  const vars: Record<string, string | undefined> = { [VAR]: token, [DESK_VAR]: DESK_TOKEN };
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const attempts: Attempt[] = [];

  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    attempts.push({
      url: String(input),
      token: new Headers(init?.headers).get('PRIVATE-TOKEN') ?? '',
    });
    return reply();
  }) as typeof fetch;

  try {
    return { result: await checkReadAccess(), attempts };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('an unset read token is not a scoped read, and asks GitLab nothing at all', async () => {
  // With no read token there is no second credential to be wrong about: the
  // desk credential does the reads too, and it is the one every write is
  // already attributed to. A boot-time HTTP call nobody needs is one more way
  // for startup to hang behind a dead VPN.
  const { result, attempts } = await check(undefined);
  assert.deepEqual(result, { ok: true, scoped: false, project: PROJECT });
  assert.equal(attempts.length, 0);
});

test('a present-but-empty or placeholder read token reads as unset, not as a scoped read', async () => {
  // envOr() screens both, so `GITLAB_READ_TOKEN=` left in a .env must not be
  // reported as a scoped read that then fails to verify.
  for (const value of ['', '<token>']) {
    const { result, attempts } = await check(value);
    assert.deepEqual(result, { ok: true, scoped: false, project: PROJECT },
      `${value || '(empty)'} must read as unset`);
    assert.equal(attempts.length, 0);
  }
});

test('a GitLab nobody can reach is reported as unverified rather than answered', async () => {
  // Refusing to boot because the laptop is off the VPN trades a silent failure
  // for a noisy one that is just as wrong.
  const { result } = await check(READ_TOKEN, () => {
    throw new Error('getaddrinfo ENOTFOUND gitlab.arbisoft.com');
  });
  assert.equal(result.ok, true);
  assert.equal(result.scoped, true);
  assert.match(result.reason ?? '', /could not be verified \(network, HTTP 0\)/);
});

test('an auth failure and a 5xx are unverified too, and name what happened', async () => {
  const rejected = await check(READ_TOKEN, () => jsonReply({ message: '401 Unauthorized' }, 401));
  assert.equal(rejected.result.ok, true);
  assert.equal(rejected.result.scoped, true);
  assert.match(rejected.result.reason ?? '', /could not be verified \(auth, HTTP 401\)/);

  const down = await check(READ_TOKEN, () => jsonReply({ message: '503' }, 503));
  assert.equal(down.result.ok, true);
  assert.equal(down.result.scoped, true);
  assert.match(down.result.reason ?? '', /could not be verified \(server, HTTP 503\)/);
});

test('a read token with no membership fails the check even though GitLab answered 200', async () => {
  // The bug itself. An internal-visibility project answers 200 to a
  // non-member, so the status code says nothing; both access fields coming
  // back null is the only signal that every board read will be empty.
  const { result } = await check(READ_TOKEN, () => jsonReply({
    id: projectConfig().gitlab.projectId,
    permissions: { project_access: null, group_access: null },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.scoped, true);
  assert.equal(result.project, PROJECT);
  assert.match(result.reason ?? '', /no membership/);
});

test('membership passes whether it is held on the project or inherited from the group', async () => {
  const direct = await check(READ_TOKEN, () => jsonReply({
    permissions: { project_access: { access_level: 40 }, group_access: null },
  }));
  passing(direct.result);

  const inherited = await check(READ_TOKEN, () => jsonReply({
    permissions: { project_access: null, group_access: { access_level: 30 } },
  }));
  passing(inherited.result);
});

test('a payload carrying no permissions block at all is not failed closed', async () => {
  // A shape nobody anticipated is not evidence of a scoping mistake, and
  // blocking the desk on one would make an API change look like a bad token.
  const { result } = await check(READ_TOKEN, () => jsonReply({
    id: projectConfig().gitlab.projectId,
    path_with_namespace: PROJECT,
  }));
  passing(result);
});

test('the project is checked with the read token itself, which is the one doing the reads', async () => {
  // Verifying the desk credential here would pass on exactly the machine the
  // check exists to catch, since that credential is a member.
  const { attempts } = await check(READ_TOKEN, () => jsonReply({
    permissions: { project_access: { access_level: 40 }, group_access: null },
  }));
  const { gitlab } = projectConfig();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.token, READ_TOKEN);
  assert.equal(attempts[0]?.url, `${gitlab.apiUrl}/projects/${gitlab.projectId}`);
});
