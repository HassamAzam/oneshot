/**
 * The read token being blind to the project it is pointed at.
 *
 * GITLAB_READ_TOKEN wins over the desk credential for every read, and a token
 * that is not a member of the project is not told so: GitLab answers the list
 * endpoints with 200 and an EMPTY ARRAY rather than 403. So
 * `issuesWithEntryLabel()` comes back clean and empty, the watcher reports "no
 * tickets carry the entry label", the desk claims nothing, and every line of
 * that is green. What tells it apart from a genuinely empty board is the desk
 * credential seeing issues the read token does not, and these cases pin that.
 *
 * The other half of the check is what it must NOT do. A VPN blip has to leave
 * the conductor running, and an unset variable has to cost nothing at all —
 * which is why the stub records attempts instead of only answering them.
 *
 * Nothing here touches the network or this machine's own credentials: both
 * tokens are pinned per case and restored afterwards, and fetch is a stub.
 */
import './test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReadAccess } from './gitlab.js';
import type { ReadAccessCheck } from './gitlab.js';
import type { ResolvedToken } from './token.js';

const VAR = 'GITLAB_READ_TOKEN';
const DESK_VAR = 'ONESHOT_GITLAB_TOKEN';
const READ_TOKEN = 'glpat-fake-read-token';
const DESK_TOKEN = 'glpat-fake-desk-token';

interface Attempt { url: string; token: string }

const PROJECT = 'acme/erp';
const ISSUES = `https://gitlab.example.com/api/v4/projects/${encodeURIComponent(PROJECT)}/issues?per_page=1`;
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
 *
 * `desk` stands in for resolveToken() where a case needs a desk with no
 * credential at all. No variable can promise that: resolveToken() goes on to a
 * token file, the keychain and glab, and this machine may have any of them.
 */
async function check(
  token: string | undefined,
  reply: (attempt: Attempt) => Response | Promise<Response> = () => jsonReply([]),
  repo?: null,
  desk?: () => ResolvedToken,
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
    const attempt = { url: String(input), token: new Headers(init?.headers).get('PRIVATE-TOKEN') ?? '' };
    attempts.push(attempt);
    return reply(attempt);
  }) as typeof fetch;

  try {
    return { result: await checkReadAccess(repo, desk), attempts };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Answer the read token with `read` and the desk credential with `desk`. */
const byToken = (read: unknown, desk: unknown) => (a: Attempt): Response =>
  jsonReply(a.token === READ_TOKEN ? read : desk);

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

test('with no project named, a set read token is left unchecked instead of throwing', async () => {
  // preflight already refuses an unset or placeholder GITLAB_REPO_URL with its
  // own message; asking projectConfig().gitlab for the project would throw
  // first and take the conductor down on an unhandled rejection instead.
  const { result, attempts } = await check(READ_TOKEN, undefined, null);
  assert.equal(result.ok, true);
  assert.equal(result.scoped, true);
  assert.equal(result.project, '');
  assert.match(result.reason ?? '', /not checked/);
  assert.equal(attempts.length, 0);
});

test('a GitLab nobody can reach is reported as unverified rather than answered', async () => {
  // Refusing to boot because the laptop is off the VPN trades a silent failure
  // for a noisy one that is just as wrong.
  const { result } = await check(READ_TOKEN, () => {
    throw new Error('getaddrinfo ENOTFOUND gitlab.example.com');
  });
  assert.equal(result.ok, true);
  assert.equal(result.scoped, true);
  assert.match(result.reason ?? '', /probe made with GITLAB_READ_TOKEN failed \(network, HTTP 0\)/);
});

test('a 5xx is unverified too, and the warning says it was the read token\'s probe that failed', async () => {
  const { result } = await check(READ_TOKEN, () => jsonReply({ message: '503' }, 503));
  assert.equal(result.ok, true);
  assert.match(result.reason ?? '', /probe made with GITLAB_READ_TOKEN failed \(server, HTTP 503\)/);
});

test('a 401 on the read token\'s probe refuses, since GitLab was reached and turned the token itself away', async () => {
  // Booting on it fails every board read, and the only sign after boot is the
  // watcher's scan error, which blames GITLAB_TOKEN: the wrong variable.
  const { result, attempts } = await check(READ_TOKEN, () => jsonReply({ message: '401 Unauthorized' }, 401));
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.equal(result.project, PROJECT);
  assert.match(result.reason ?? '', /rejected .*revoked, expired or mistyped/);
  assert.equal(attempts.length, 1);
});

test('a 404 or 403 on the project refuses, since that is how a private project hides from a non-member', async () => {
  for (const status of [404, 403]) {
    const { result } = await check(READ_TOKEN, () => jsonReply({ message: String(status) }, status));
    assert.equal(result.ok, false, `HTTP ${status} must refuse`);
    assert.equal(result.project, PROJECT);
    assert.match(result.reason ?? '', new RegExp(`HTTP ${status}`));
  }
});

test('a read token that lists nothing where the desk credential lists issues fails, though GitLab answered 200', async () => {
  // The bug itself. An internal project answers 200 and an empty list to a
  // non-member, so the status code says nothing; the desk seeing what the read
  // token cannot is the only signal that every board read will be empty.
  const { result, attempts } = await check(READ_TOKEN, byToken([], [{ iid: 1 }]));
  assert.equal(result.ok, false);
  assert.equal(result.scoped, true);
  assert.equal(result.project, PROJECT);
  assert.match(result.reason ?? '', /lists no issues/);
  assert.deepEqual(attempts.map((a) => a.token), [READ_TOKEN, DESK_TOKEN]);
});

test('a read token that lists issues passes without asking the desk, whatever its membership', async () => {
  // Admin and auditor tokens, members of a group the project is shared with,
  // and non-members on an internal project with public issues all carry null
  // access fields and read the board fine. Seeing issues is what counts.
  const { result, attempts } = await check(READ_TOKEN, byToken([{ iid: 1 }], []));
  passing(result);
  assert.equal(attempts.length, 1);
});

test('a project with no issues at all is not failed on the read token\'s account', async () => {
  const { result } = await check(READ_TOKEN, byToken([], []));
  passing(result);
});

test('when the desk credential cannot be asked, an empty read is unverified, not refused, and the desk is named', async () => {
  // A bare "(notfound, HTTP 404)" here read as the read token's own 404, which
  // refuses. A 401 to the desk is the desk's problem too, so it only warns.
  for (const status of [502, 404, 401]) {
    const { result } = await check(READ_TOKEN, (a) =>
      (a.token === READ_TOKEN ? jsonReply([]) : jsonReply({ message: String(status) }, status)));
    const reason = result.reason ?? '';
    assert.equal(result.ok, true, `HTTP ${status} to the desk must not refuse`);
    assert.match(reason, new RegExp(`desk credential \\(.*${DESK_VAR}.*\\) failed \\(\\w+, HTTP ${status}\\)`));
    assert.match(reason, /empty answer could not be compared/);
    assert.doesNotMatch(reason, /probe made with GITLAB_READ_TOKEN/);
  }
});

test('with no desk credential at all, an empty read says so plainly instead of "(network, HTTP 0)"', async () => {
  // call() reports writeToken() throwing as a network failure, which blamed a
  // dead link for a desk that simply has no token to compare with.
  const noDesk = (): ResolvedToken => ({ token: '', source: 'none', where: 'nowhere', shared: false });
  const { result, attempts } = await check(READ_TOKEN, byToken([], [{ iid: 1 }]), undefined, noDesk);
  assert.equal(result.ok, true);
  assert.match(result.reason ?? '', /this desk has no GitLab token of its own/);
  assert.doesNotMatch(result.reason ?? '', /network|HTTP 0/);
  assert.deepEqual(attempts.map((a) => a.token), [READ_TOKEN]);
});

test('the project is probed with the read token itself, which is the one doing the reads', async () => {
  // Verifying the desk credential alone would pass on exactly the machine the
  // check exists to catch, since that credential is a member.
  const { attempts } = await check(READ_TOKEN, byToken([{ iid: 1 }], []));
  assert.equal(attempts[0]?.token, READ_TOKEN);
  assert.equal(attempts[0]?.url, ISSUES);
});
