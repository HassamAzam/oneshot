/**
 * Is the managed local login real, before `verify` spends a lap finding out?
 *
 * Ticket #189 lost a whole verify lap, and then a remediation session, to an
 * account that did not exist: ONESHOT_TEST_LOGIN named a user the worktree's
 * database had never held, and the only thing that could discover it was a
 * model, logging in through a browser, after bringing the app up. None of that
 * needs a model or a server. The database answers it in a few seconds.
 *
 * Asked of the DATABASE, not the login endpoint, because there is no server
 * before verify starts one. The checks mirror the email-login view: a User
 * with that exact email, a Person or ClientPerson linked to it (without one the
 * view answers "This user does not exist" whatever the password), and a
 * password that matches.
 *
 * Read-only by construction. `User.check_password()` re-saves the hash when the
 * hasher wants an upgrade, so the bare hasher function is used instead — and
 * the interpreter opens with `import ssl, hashlib` regardless, because this
 * venv computes corrupted hashes when psycopg2 loads first (HANDOFF.md).
 *
 * Only a definite answer blocks. A check that cannot run — no venv, a DB that
 * is down, a model that moved — returns `ok: null` and verify proceeds exactly
 * as it did before this existed; the harness has its own named errors for
 * those, and a pre-check must never be the thing that stops a healthy run.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { envOr } from './config.js';

const exec = promisify(execFile);

const CHECK_TIMEOUT_MS = 90_000;

export type TestLoginCheck =
  | { ok: true; email: string }
  | { ok: false; email: string; reason: string }
  | { ok: null; reason: string };

const SCRIPT = `
import ssl, hashlib
import json, os
import django
django.setup()
from django.contrib.auth.hashers import check_password
from django.contrib.auth.models import User
from apps.core.models import ClientPerson, Person

email, _, password = os.environ["ONESHOT_TEST_LOGIN"].partition(":")
user = User.objects.filter(email=email).first()
if user is None:
    verdict = "no-user"
elif not (Person.objects.filter(user=user).exists() or ClientPerson.objects.filter(user=user).exists()):
    verdict = "no-person"
elif not user.is_active:
    verdict = "inactive"
elif not check_password(password, user.password):
    verdict = "bad-password"
else:
    verdict = "ok"
print("ONESHOT_LOGIN_CHECK " + json.dumps({"verdict": verdict}))
`;

const PROVISION =
  'Provision it in the local database with a shell that opens `import ssl, hashlib` BEFORE ' +
  'anything imports Django, then `npm run unblock <iid>`. Never from an ad-hoc shell: this venv ' +
  'writes a corrupted hash when psycopg2 loads first, and the login stays rejected.';

const REASONS: Record<string, (email: string) => string> = {
  'no-user': (e) => `the managed test login ${e} (ONESHOT_TEST_LOGIN) does not exist in this ` +
    `worktree's database, so every case that logs in would fail. ${PROVISION}`,
  'no-person': (e) => `the managed test login ${e} exists as a User but has no Person or ` +
    'ClientPerson linked to it, and the email-login view refuses such a user as "does not ' +
    `exist". ${PROVISION}`,
  'inactive': (e) => `the managed test login ${e} is deactivated in this worktree's database. ` +
    PROVISION,
  'bad-password': (e) => `the managed test login ${e} exists, but the password in ` +
    `ONESHOT_TEST_LOGIN does not match its stored hash. ${PROVISION}`,
};

export async function checkTestLogin(worktree: string): Promise<TestLoginCheck> {
  const raw = envOr('ONESHOT_TEST_LOGIN');
  const email = raw.split(':')[0] ?? '';
  if (!email || !raw.includes(':')) {
    return { ok: null, reason: 'ONESHOT_TEST_LOGIN is unset or not email:password' };
  }
  const python = join(worktree, 'venv/bin/python');
  if (!existsSync(python)) return { ok: null, reason: `no venv at ${python}` };

  let stdout: string;
  try {
    ({ stdout } = await exec(python, ['-c', SCRIPT], {
      cwd: worktree,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      // The credential travels in the environment, never argv: argv is
      // readable by every `ps` on the machine.
      env: {
        ...process.env,
        ONESHOT_TEST_LOGIN: raw,
        DJANGO_SETTINGS_MODULE: 'hrdb.settings',
        PYTHONUNBUFFERED: '1',
      },
    }));
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const last = String(e.stderr ?? '').trim().split('\n').pop() || e.message;
    return { ok: null, reason: `login pre-check could not run: ${last.slice(0, 200)}` };
  }

  const line = stdout.split('\n').find((l) => l.startsWith('ONESHOT_LOGIN_CHECK '));
  if (!line) return { ok: null, reason: 'login pre-check printed no verdict' };
  const { verdict } = JSON.parse(line.slice('ONESHOT_LOGIN_CHECK '.length)) as { verdict: string };
  if (verdict === 'ok') return { ok: true, email };
  const reason = REASONS[verdict];
  return reason
    ? { ok: false, email, reason: reason(email) }
    : { ok: null, reason: `login pre-check returned an unknown verdict '${verdict}'` };
}
