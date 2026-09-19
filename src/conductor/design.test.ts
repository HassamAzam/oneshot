import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingDesignDeliverables } from './design.js';

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'design-'));
  mkdirSync(join(dir, 'design'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const OK = { files: ['design/01-default.png', 'design/doc.pdf'], groundedIn: ['frontend/src/jss/Theme.js'] };

test('real PNG + PDF + grounding passes', () => {
  const dir = root({ 'design/01-default.png': 'x', 'design/doc.pdf': 'x' });
  assert.equal(missingDesignDeliverables(1, OK, dir), null);
});

test('a reported file that is not on disk is overruled', () => {
  const dir = root({ 'design/01-default.png': 'x' });
  assert.match(missingDesignDeliverables(1, OK, dir) ?? '', /missing or empty.*doc\.pdf/);
});

test('an empty file does not count', () => {
  const dir = root({ 'design/01-default.png': '', 'design/doc.pdf': 'x' });
  assert.match(missingDesignDeliverables(1, OK, dir) ?? '', /01-default\.png/);
});

test('no PDF is no design', () => {
  const dir = root({ 'design/01-default.png': 'x' });
  assert.equal(missingDesignDeliverables(1, { ...OK, files: ['design/01-default.png'] }, dir), 'no design PDF');
});

test('no PNG is no design', () => {
  const dir = root({ 'design/doc.pdf': 'x' });
  assert.equal(missingDesignDeliverables(1, { ...OK, files: ['design/doc.pdf'] }, dir), 'no rendered PNG mockup');
});

test('ungrounded output means the skill was not followed', () => {
  const dir = root({ 'design/01-default.png': 'x', 'design/doc.pdf': 'x' });
  assert.match(missingDesignDeliverables(1, { ...OK, groundedIn: [] }, dir) ?? '', /design-agent/);
});

test('paths escaping the artifacts directory are refused', () => {
  const dir = root({});
  assert.match(missingDesignDeliverables(1, { ...OK, files: ['../../etc/x.png'] }, dir) ?? '', /outside/);
});
