import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountActionRequired, accountActionReason } from './accountgate.js';

// Verbatim from state/runs/168/transcripts/plan-lap1.jsonl — the bundled CLI's
// whole output before it exited 1.
const TERMS = '\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect ' +
  'on October 8, 2025. You must run `claude` to review the updated terms.\n\n';

test('the terms hard-exit is recognised and its notice kept', () => {
  assert.equal(
    accountActionRequired(TERMS),
    'An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. ' +
    'You must run `claude` to review the updated terms.',
  );
});

test('ordinary stderr is not an account action', () => {
  assert.equal(accountActionRequired(''), null);
  assert.equal(accountActionRequired('⚠️  [BashTool] Pre-flight check is taking longer than expected.\n'), null);
  assert.equal(accountActionRequired('Claude Code process exited with code 1'), null);
});

test('the reason names the notice, the bundled CLI and the way back', () => {
  const why = accountActionReason('You must run `claude` to review the updated terms.', 168);
  assert.match(why, /review the updated terms/);
  assert.match(why, /claude-agent-sdk\/cli\.js/);
  assert.match(why, /npm run unblock -- 168/);
});
