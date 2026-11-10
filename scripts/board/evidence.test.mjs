/**
 * Evidence: which artifact files ship, with what tags, and how they land in the
 * media dir. Pure filesystem — every test works on a temp copy of the fixture run.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEvidence, evidenceStats, shotTag } from './evidence.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'run-evidence');
const journal = {
  runId: 'r-ev', iid: 42,
  phases: [{ phase: 'verify', lap: 0 }, { phase: 'verify', lap: 2 }, { phase: 'ui-evidence', lap: 1 }],
};
const temps = [];
const restore = [];
after(() => {
  for (const f of restore) { try { chmodSync(f, 0o644); } catch { /* gone */ } }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'board-ev-'));
  temps.push(root);
  const runDir = join(root, 'run');
  cpSync(FIXTURE, runDir, { recursive: true });
  return { runDir, mediaDir: join(root, 'media') };
}
const collect = (s, extra = {}) => collectEvidence({
  runDir: s.runDir, journal, operatorId: 'op', mediaDir: s.mediaDir, maxBytes: 1_000_000, seen: new Set(), ...extra,
});
const bySource = (rows, p) => rows.find((r) => r.source_path === p);

test('evidence copies referenced files and returns rows', () => {
  const s = setup();
  const { rows, skipped } = collect(s);
  assert.deepEqual(skipped, []);
  assert.equal(rows.length, 3);

  const ui = bySource(rows, 'settings-after.png');
  assert.equal(ui.phase, 'ui-evidence');
  assert.equal(ui.kind, 'screenshot');
  assert.equal(ui.tag, 'after');
  assert.equal(ui.caption, 'Settings page with the new toggle');
  assert.equal(ui.lap, 1);

  const tc = bySource(rows, 'TC-01-pass.png');
  assert.equal(tc.phase, 'verify');
  assert.equal(tc.tag, 'tc-pass');
  assert.equal(tc.caption, 'TC-01 pass');
  assert.equal(tc.lap, 2);

  const vid = bySource(rows, 'design/walkthrough.webm');
  assert.equal(vid.phase, 'design');
  assert.equal(vid.kind, 'video');
  assert.equal(vid.tag, 'walkthrough');
  assert.equal(vid.lap, 0, 'a phase absent from the journal is lap 0, never null');
  assert.equal(vid.width, null);
  assert.equal(vid.bytes, 1);

  for (const r of rows) {
    assert.match(r.id, /^[0-9a-f]{64}$/);
    assert.equal(r.run_id, 'r-ev');
    assert.equal(r.ticket_iid, 42);
    assert.equal(r.operator_id, 'op');
    assert.equal(r.duration_ms, null);
    assert.equal(r.path, `r-ev/${r.id}.${r.source_path.split('.').pop()}`);
    assert.ok(existsSync(join(s.mediaDir, r.path)), `${r.path} copied into the media dir`);
  }
  for (const r of [ui, tc]) { assert.equal(r.width, 2); assert.equal(r.height, 2); }
});

test('evidence is idempotent via seen', () => {
  const s = setup();
  const first = collect(s);
  const again = collect(s, { seen: new Set(first.rows.map((r) => r.id)) });
  assert.equal(again.rows.length, 0);
  assert.deepEqual(again.skipped, []);
});

test('evidence skips unreadable file', { skip: process.getuid?.() === 0 && 'root reads anything' }, () => {
  const s = setup();
  const locked = join(s.runDir, 'artifacts', 'TC-01-pass.png');
  chmodSync(locked, 0o000);
  restore.push(locked);
  const { rows, skipped } = collect(s);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /^TC-01-pass\.png: /);
  assert.deepEqual(rows.map((r) => r.source_path).sort(), ['design/walkthrough.webm', 'settings-after.png']);
});

test('evidence falls back to unreferenced media', () => {
  const s = setup();
  // A distinct byte so the sha differs from the referenced fixtures.
  writeFileSync(join(s.runDir, 'artifacts', 'stray-mobile.gif'), 'g');
  writeFileSync(join(s.runDir, 'artifacts', 'notes.txt'), 'not media');
  const { rows } = collect(s);
  const stray = bySource(rows, 'stray-mobile.gif');
  assert.ok(stray, 'unreferenced gif shipped');
  assert.equal(stray.phase, 'ui-evidence');
  assert.equal(stray.tag, null);
  assert.equal(stray.caption, 'stray-mobile.gif');
  assert.equal(rows.length, 4, 'the txt is not media; referenced files are not shipped twice');
});

test('evidence ignores paths outside artifacts', () => {
  const s = setup();
  writeFileSync(join(s.runDir, 'outside.png'), 'o');
  writeFileSync(join(s.runDir, 'ui-evidence.json'), JSON.stringify({
    screenshots: [{ file: '../outside.png', caption: 'x' }, { file: join(s.runDir, 'outside.png'), caption: 'y' }],
  }));
  const { rows, skipped } = collect(s);
  assert.ok(!rows.some((r) => r.source_path.includes('outside')));
  assert.deepEqual(skipped, []);
});

test('shotTag reads the name before the caption', () => {
  assert.equal(shotTag('a.png', 'Mobile view at 375px'), 'mobile');
  assert.equal(shotTag('04-empty-state.png', 'No rows'), 'empty');
  assert.equal(shotTag('05-error.png', 'Error state: the list came back empty'), 'after');
  assert.equal(shotTag('profile-v1-legacy.png', 'Profile'), 'before');
  assert.equal(shotTag('tabs.png', 'Before the fix every tab was named log-month; now December'), 'before');
  assert.equal(shotTag('tabs.png', 'December tab. Before the fix every tab was named log-month'), 'after');
});

test('evidence skips an unwritable media dir', () => {
  const s = setup();
  const blocker = join(dirname(s.mediaDir), 'not-a-dir');
  writeFileSync(blocker, 'file');
  const mediaDir = join(blocker, 'media'); // under a regular file: mkdir fails for anyone, root included
  const before = evidenceStats.hashes;
  for (let i = 0; i < 2; i += 1) {
    const { rows, skipped } = collect(s, { mediaDir });
    assert.deepEqual(rows, []);
    assert.equal(skipped.length, 1);
    assert.ok(skipped[0].startsWith(`${mediaDir}: not writable (`), skipped[0]);
  }
  assert.equal(evidenceStats.hashes, before, 'no file was hashed');
});

test('evidence respects maxBytes', () => {
  const s = setup();
  const { rows, skipped } = collect(s, { maxBytes: 10 });
  assert.deepEqual(rows.map((r) => r.source_path), ['design/walkthrough.webm']);
  assert.equal(skipped.length, 2);
  for (const m of skipped) assert.match(m, /over 10 bytes/);
});

test('evidence copy is not aliased to the source', () => {
  const s = setup();
  const { rows } = collect(s);
  const tc = bySource(rows, 'TC-01-pass.png');
  const src = join(s.runDir, 'artifacts', 'TC-01-pass.png');
  const media = join(s.mediaDir, tc.path);
  assert.notEqual(statSync(media).ino, statSync(src).ino, 'a separate inode, not a hard link');
  // The next verify lap re-captures under the same name, truncating in place.
  writeFileSync(src, 'a different capture');
  const sha = createHash('sha256').update(readFileSync(media)).digest('hex');
  assert.equal(sha, tc.id, 'the media file still holds the bytes its id names');
});

test('evidence replaces a torn copy and skips a complete one', () => {
  const s = setup();
  const first = collect(s).rows;
  const tc = bySource(first, 'TC-01-pass.png');
  const media = join(s.mediaDir, tc.path);
  writeFileSync(media, 'x'); // a copy cut short
  collect(s);
  assert.equal(createHash('sha256').update(readFileSync(media)).digest('hex'), tc.id, 'the torn copy was replaced');
  const ino = statSync(media).ino;
  collect(s);
  assert.equal(statSync(media).ino, ino, 'a complete copy is left alone');
});
