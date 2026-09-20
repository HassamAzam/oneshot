/**
 * The managed app login reaching the phase that has to use it.
 *
 * A phase environment is an allowlist, so a variable is absent until something
 * names it. This one was named nowhere, and the symptom was not an error: every
 * reproduction returned 'inconclusive' with an empty `account`, indistinguishable
 * from a model that gave up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLoginEnv } from './phase.js';

const VAR = 'ONESHOT_TEST_LOGIN';
const FAKE = 'someone@example.com:not-a-real-password';

/** Swap the variable for one assertion, then put the machine's own value back. */
function withVar<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR);
  const before = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  try { return fn(); } finally {
    if (had) process.env[VAR] = before;
    else delete process.env[VAR];
  }
}

test('a worktree phase gets the login', () => {
  // The whole bug: harness.cjs reads this from the environment, and nothing put
  // it there, so `harness.cjs login` threw E_NO_CREDENTIALS on every Bug ticket.
  withVar(FAKE, () => {
    assert.deepEqual(testLoginEnv('/tmp/wt-1'), { [VAR]: FAKE });
  });
});

test('a conductor phase with no worktree does not', () => {
  // Nothing to log into at ROOT; a credential with no use is a credential in one
  // more transcript's environment.
  withVar(FAKE, () => {
    assert.deepEqual(testLoginEnv(undefined), {});
  });
});

test('an unset variable forwards nothing rather than an empty login', () => {
  // `ONESHOT_TEST_LOGIN=` present-but-empty must not shadow the harness's own
  // E_NO_CREDENTIALS, which names the variable and says how to set it.
  withVar(undefined, () => {
    assert.deepEqual(testLoginEnv('/tmp/wt-1'), {});
  });
});

test('an unedited placeholder is treated as unset', () => {
  // envOr() screens placeholders, so a copied .env.example does not arrive as a
  // fake account that fails at the login form instead of at the check.
  withVar('<email>:<password>', () => {
    assert.deepEqual(testLoginEnv('/tmp/wt-1'), {});
  });
});

test('the value is never altered in transit', () => {
  // A password may contain colons; nothing here may split or trim it.
  const odd = 'a@b.com:pa:ss word ';
  withVar(odd, () => {
    assert.equal(testLoginEnv('/tmp/wt-1')[VAR], odd);
  });
});
