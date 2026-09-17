import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountActionRequired, accountActionReason } from './accountgate.js';

// Verbatim from state/runs/168/transcripts/plan-lap1.jsonl — the bundled CLI's
// whole output before it exited 1.
const TERMS = '\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect ' +
  'on October 8, 2025. You must run `claude` to review the updated terms.\n\n';

const NOTICE = 'An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. ' +
  'You must run `claude` to review the updated terms.';

test('the terms hard-exit is recognised and its notice kept', () => {
  assert.equal(accountActionRequired(TERMS), NOTICE);
});

test('ordinary stderr is not an account action', () => {
  assert.equal(accountActionRequired(''), null);
  assert.equal(accountActionRequired('⚠️  [BashTool] Pre-flight check is taking longer than expected.\n'), null);
  assert.equal(accountActionRequired('Claude Code process exited with code 1'), null);
});

// The negatives above share no token with the pattern, so they hold however it
// is written. These do share it, and they are the ones that cost something:
// detection ends the run with noRemediation, so stderr that merely QUOTES the
// phrase must not reach that.
test('the phrase quoted mid-line is not the CLI printing it', () => {
  assert.equal(accountActionRequired('the ticket says [ACTION REQUIRED] review the spec'), null);
  assert.equal(accountActionRequired('> reviewer: [ACTION REQUIRED] update the terms doc'), null);
  assert.equal(
    accountActionRequired('Error: fixture "[ACTION REQUIRED] sign in to continue" did not match\n'),
    null,
  );
});

test('an indented notice counts; one with text ahead of it on the line does not', () => {
  assert.equal(
    accountActionRequired('   [ACTION REQUIRED] Please accept the updated Terms.\n'),
    'Please accept the updated Terms.',
  );
  assert.equal(
    accountActionRequired('npx: installing... [ACTION REQUIRED] Please accept the updated Terms.\n'),
    null,
  );
});

test('the notice is read only as far as the end of its own line', () => {
  const multi = '\n[ACTION REQUIRED] Your Consumer Terms have changed.\n'
    + 'Run `claude` to review them.\n[ACTION REQUIRED] Your billing needs attention.\n';
  assert.equal(accountActionRequired(multi), 'Your Consumer Terms have changed.');
});

// The other way this misses is truncation, which is why phase.ts keeps a bounded
// HEAD and a bounded TAIL of stderr and asks about both.
test('the notice survives at either end of a truncated stderr buffer', () => {
  const KEEP = 8_000;
  const noise = 'MCP server starting...\n'.repeat(500);
  assert.ok(noise.length > KEEP, 'the noise must actually overflow the buffer');

  assert.equal(accountActionRequired((TERMS + noise).slice(0, KEEP)), NOTICE);
  assert.equal(accountActionRequired((noise + TERMS).slice(-KEEP)), NOTICE);
  // And the case the tail exists for: a head-only buffer holds nothing but noise.
  assert.equal(accountActionRequired((noise + TERMS).slice(0, KEEP)), null);
});

// An account gate is always about terms, privacy, policy, billing or being
// signed out. Anything else under the same banner is a notice this module has no
// advice for, so it degrades to the infra re-attempt that handled it before —
// a retry, not a dead run.
test('an unrecognised [ACTION REQUIRED] degrades instead of halting', () => {
  assert.equal(accountActionRequired('\n[ACTION REQUIRED] Update your CLI to v2.0 to continue.\n'), null);
  assert.equal(accountActionRequired('\n[ACTION REQUIRED] Restart the MCP gateway.\n'), null);
  assert.equal(
    accountActionRequired('\n[ACTION REQUIRED] Your billing details need attention.\n'),
    'Your billing details need attention.',
  );
  assert.equal(
    accountActionRequired('\n[ACTION REQUIRED] You have been signed out. Log in again.\n'),
    'You have been signed out. Log in again.',
  );
});

test('the reason names the notice, the bundled CLI and the way back', () => {
  // Deliberately not 168: with the ticket this was found on in both the call and
  // the pattern, a template that dropped ${iid} and hardcoded the number passes.
  const why = accountActionReason(NOTICE, 4242);
  assert.match(why, /review the updated terms/);
  assert.match(why, /claude-agent-sdk\/cli\.js/);
  assert.match(why, /npm run unblock -- 4242/);
  assert.doesNotMatch(why, /168/);
});
