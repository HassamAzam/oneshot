/**
 * Composing `.claude` has to REPAIR one that drifted, not only build a fresh one.
 *
 * The fresh case is the one that gets exercised constantly — every worktree
 * lease composes into an empty directory — so it was the only one that worked.
 * Re-pointing a link that already exists is the rarer path and the one that
 * matters on a desk: it fires when SKILLS_ROOT moves, when the project is
 * switched, or when a `.claude` outlives the checkout its links named. There,
 * `rmSync(path, { force: true })` throws ERR_FS_EISDIR on a symlink whose
 * TARGET is a directory — `lstat` reports a symlink, but rm's own check follows
 * the link and refuses a directory without `recursive`. Every skill link is a
 * symlink to a directory, so the first stale one threw, `ensureClaudeDir`'s
 * catch logged a warning, and the phases ran with whatever the old links
 * resolved to. The loss was a warning on a console nobody reads.
 *
 * These cases pin the repair, so a composed `.claude` is a function of config
 * rather than of what happened to be on disk first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClaudeDir } from './claudedir.js';
import { SKILLS_ROOT } from './config.js';

/** A repo root with a `.claude/skills` holding whatever `links` names, and a decoy to point them at. */
function desk(links: Record<string, string>): { root: string; decoy: string } {
  const root = mkdtempSync(join(tmpdir(), 'claudedir-'));
  const decoy = join(root, 'elsewhere');
  const skills = join(root, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  for (const [name, points] of Object.entries(links)) {
    const target = join(decoy, points);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(skills, name));
  }
  return { root, decoy };
}

/** The first skill the real SKILLS_ROOT ships — the one a stale link must be re-pointed to. */
function aContextSkill(): string {
  const [first] = readdirSync(join(SKILLS_ROOT, 'skills')).filter((n) => !n.startsWith('.'));
  assert.ok(first, 'SKILLS_ROOT ships no skills, so these cases prove nothing');
  return first;
}

test('a stale skill link is re-pointed at SKILLS_ROOT, not left as it was', () => {
  const name = aContextSkill();
  const { root } = desk({ [name]: name });

  const seeded = ensureClaudeDir(root);

  assert.deepEqual(seeded, ['.claude'], 'compose reported failure');
  assert.equal(
    readlinkSync(join(root, '.claude', 'skills', name)),
    join(SKILLS_ROOT, 'skills', name),
    'the link still names the old target',
  );
});

test('one stale link does not cost the other skills their links', () => {
  const name = aContextSkill();
  const { root } = desk({ [name]: name });

  ensureClaudeDir(root);

  const linked = readdirSync(join(root, '.claude', 'skills'));
  const shipped = readdirSync(join(SKILLS_ROOT, 'skills')).filter((n) => !n.startsWith('.'));
  assert.ok(
    linked.length >= shipped.length,
    `composed ${linked.length} skills, SKILLS_ROOT ships ${shipped.length}`,
  );
});

test('a link whose target is gone is removed rather than throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudedir-'));
  const skills = join(root, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  symlinkSync(join(root, 'never-existed'), join(skills, 'ghost'));

  const seeded = ensureClaudeDir(root);

  assert.deepEqual(seeded, ['.claude']);
  assert.ok(!readdirSync(skills).includes('ghost'), 'the dangling link survived');
});

test('a real directory a human put there is never replaced by a link', () => {
  const name = aContextSkill();
  const root = mkdtempSync(join(tmpdir(), 'claudedir-'));
  const mine = join(root, '.claude', 'skills', name);
  mkdirSync(mine, { recursive: true });

  ensureClaudeDir(root);

  assert.ok(lstatSync(mine).isDirectory(), 'a human-authored skill directory was replaced');
  assert.ok(!lstatSync(mine).isSymbolicLink(), 'a human-authored skill directory became a link');
});
