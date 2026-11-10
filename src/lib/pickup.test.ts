import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePickupRule, pickupVerdict } from './pickup.js';

test('parsePickupRule: unset is self, * is any, a list is normalised', () => {
  assert.deepEqual(parsePickupRule(undefined), { mode: 'self' });
  assert.deepEqual(parsePickupRule('  '), { mode: 'self' });
  assert.deepEqual(parsePickupRule('*'), { mode: 'any' });
  assert.deepEqual(parsePickupRule(' @Hassam.Azam , bob,,bob '), { mode: 'list', users: ['hassam.azam', 'bob'] });
  assert.deepEqual(parsePickupRule(' , '), { mode: 'self' });
});

test('unassigned tickets are claimable under every rule, even with no identity', () => {
  for (const raw of [undefined, '*', 'bob']) assert.deepEqual(pickupVerdict([], '', parsePickupRule(raw)), { ok: true });
});

test('self: only the token user\'s tickets; a teammate\'s is a silent skip; no identity is a loud one', () => {
  const self = parsePickupRule(undefined);
  assert.deepEqual(pickupVerdict(['hassam.azam'], 'hassam.azam', self), { ok: true });
  assert.deepEqual(pickupVerdict(['Hassam.Azam', 'bob'], 'hassam.azam', self), { ok: true });
  assert.deepEqual(pickupVerdict(['bob'], 'hassam.azam', self), { ok: false, silent: true, why: 'assigned to bob, not to hassam.azam' });
  const none = pickupVerdict(['bob'], '', self);
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.silent, false);
});

test('a bot token on a server: the list decides, the bot is never needed as an assignee', () => {
  const rule = parsePickupRule('hassam.azam');
  const bot = 'project_304_bot_abc';
  assert.deepEqual(pickupVerdict(['hassam.azam'], bot, rule), { ok: true });
  assert.deepEqual(pickupVerdict(['bob'], bot, rule), { ok: false, silent: true, why: 'assigned to bob' });
  assert.deepEqual(pickupVerdict(['bob'], bot, parsePickupRule('*')), { ok: true });
});
