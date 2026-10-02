/**
 * The two judgements writeMemory makes about a run that recall later ranks by:
 * whether it was verified, and which module it was in. verdictOf already
 * shipped once counting blocked and skipped cases as a pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleName, verdictOf } from './memory.js';

const cases = (...results: string[]): { results: Array<{ id: string; result: string }> } =>
  ({ results: results.map((result, i) => ({ id: `c${i}`, result })) });

test('a run whose only verify case was blocked is unverified, not pass', () => {
  assert.equal(verdictOf(cases('blocked')), 'unverified');
});

test('pass plus skipped is unverified', () => {
  assert.equal(verdictOf(cases('pass', 'skipped')), 'unverified');
});

test('every case passing is a pass', () => {
  assert.equal(verdictOf(cases('pass', 'pass')), 'pass');
});

test('any failed case makes the verdict fail, even beside passes', () => {
  assert.equal(verdictOf(cases('pass', 'fail', 'pass')), 'fail');
  assert.equal(verdictOf(cases('blocked', 'fail')), 'fail');
});

test('no results, or no verify artifact, is unverified', () => {
  assert.equal(verdictOf({ results: [] }), 'unverified');
  assert.equal(verdictOf({}), 'unverified');
  assert.equal(verdictOf(null), 'unverified');
  assert.equal(verdictOf(undefined), 'unverified');
});

test('a space before a parenthesis or em dash ends the module name', () => {
  assert.equal(moduleName('Expenses (Add Food Expense) — root cause in x'), 'Expenses');
  assert.equal(moduleName('Training — Publish Training page'), 'Training');
});

test('a spaced en dash or hyphen ends the module name like an em dash does', () => {
  assert.equal(moduleName('Leaves – annual'), 'Leaves');
  assert.equal(moduleName('Leaves - annual'), 'Leaves');
});

test('a hyphenated module name stays whole', () => {
  assert.equal(moduleName('Self-Service Portal'), 'Self-Service Portal');
});

test('a comma or semicolon ends the module name', () => {
  assert.equal(moduleName('Payroll, increments'), 'Payroll');
  assert.equal(moduleName('Payroll; increments'), 'Payroll');
});
