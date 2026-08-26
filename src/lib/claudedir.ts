/**
 * The `.claude` directory a phase session can actually read.
 *
 * Sessions are spawned with `settingSources: ['project']`, so the only place a
 * skill, agent or rule can come from is a `.claude` directory in the session's
 * cwd. Worktree phases had one — seed() symlinked the whole of the context
 * repo's `.claude` into the worktree — but conductor-cwd phases (recall, qa,
 * demo, document, memorize) run in the Oneshot repo root, which had no
 * `.claude` at all. Every skill their prompts named silently failed to resolve:
 * the recorded run-5 transcripts show the recall session listing eight built-in
 * slash commands and not one project skill, while the worktree sessions listed
 * forty-two. Nothing errored. The phase did the work from the prompt alone and
 * the loss was invisible from outside.
 *
 * A whole-dir symlink cannot fix that, because the five pipeline skills
 * (local-browser-verify, ui-evidence-pack, demo-server-qa, mr-documentation,
 * ticket-memory-write) describe THIS system and live in THIS repo — a fresh
 * clone has to carry them, and writing them into the context repo would make
 * Oneshot's own method something you have to remember to install next to it. So
 * `.claude` is composed instead: a real directory whose `skills/` holds one
 * symlink per skill, taken from the context repo first and topped up from
 * `skills/` here.
 *
 * Context-repo-first is the collision rule. If the ERP repo ever ships a skill
 * under one of these names, that copy wins — it is the one humans maintain and
 * the one an interactive session on this machine would get. Oneshot only fills
 * gaps, and a name that appears on both sides is a signal to delete ours, not
 * to shadow theirs.
 *
 * `settings.json` is deliberately not linked. It carries the context repo's own
 * hook wiring and permission set; Oneshot supplies its guards through the SDK's
 * `hooks` option so they travel with this repo and apply at every cwd. A
 * second, unversioned guard configuration arriving through project settings is
 * precisely the thing nobody can reason about after an incident.
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { ROOT, SKILLS_ROOT } from './config.js';
import { log } from './log.js';

/** Subdirectories taken whole from the context repo — no Oneshot equivalent exists. */
const LINKED_SUBDIRS = ['agents', 'rules'] as const;

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Follows symlinks deliberately: a linked skill directory must count as one. */
function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Point `at` at `target`, replacing a stale or dangling link.
 *
 * Self-healing matters more than it looks: the seed repo gets renamed, a skill
 * gets deleted upstream, a worktree outlives a config change. A dangling
 * symlink under `skills/` is not inert — the harness enumerates the directory,
 * so one broken entry is a per-session error on a path nobody is watching.
 * A real file or directory left there by a human is never touched.
 */
function relink(at: string, target: string): void {
  if (isSymlink(at)) {
    let current = '';
    try { current = readlinkSync(at); } catch { current = ''; }
    if (current === target && existsSync(at)) return;
    rmSync(at, { force: true });
  } else if (existsSync(at)) {
    return;
  }
  symlinkSync(target, at);
}

function pruneDangling(dir: string): void {
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name);
    if (isSymlink(entry) && !existsSync(entry)) rmSync(entry, { force: true });
  }
}

/** Link every skill directory under `from` whose name is not already claimed. */
function linkSkills(from: string, into: string, claimed: Set<string>): void {
  if (!isDirectory(from)) return;
  for (const name of readdirSync(from)) {
    if (name.startsWith('.') || claimed.has(name)) continue;
    const src = join(from, name);
    if (!isDirectory(src)) continue;
    claimed.add(name);
    relink(join(into, name), src);
  }
}

/**
 * Build (or repair) `<repoRoot>/.claude` and report what it seeded.
 *
 * Returns repo-relative paths so the caller can keep them out of `git status`;
 * the conductor root ignores the return value because `/.claude/` is already in
 * .gitignore there.
 *
 * Idempotent by construction — every step is a relink or a mkdir -p, so calling
 * it on every worktree lease and every conductor boot costs nothing and quietly
 * repairs whatever drifted. An existing whole-dir `.claude` SYMLINK is left
 * exactly as it is: worktrees created before this function existed are still
 * running phases, and replacing the thing they resolve skills through mid-run
 * would break them to fix a problem they do not have.
 */
export function ensureClaudeDir(repoRoot: string): string[] {
  const dotClaude = join(repoRoot, '.claude');
  if (isSymlink(dotClaude)) return ['.claude'];

  const contextSkills = join(SKILLS_ROOT, 'skills');
  const oneshotSkills = join(ROOT, 'skills');
  if (!isDirectory(contextSkills) && !isDirectory(oneshotSkills)) {
    log.warn('no skills to seed — phases will run on their prompts alone', { SKILLS_ROOT });
    return [];
  }

  try {
    const skills = join(dotClaude, 'skills');
    mkdirSync(skills, { recursive: true });
    pruneDangling(skills);

    for (const sub of LINKED_SUBDIRS) {
      const src = join(SKILLS_ROOT, sub);
      if (isDirectory(src)) relink(join(dotClaude, sub), src);
    }

    const claimed = new Set<string>();
    linkSkills(contextSkills, skills, claimed);
    linkSkills(oneshotSkills, skills, claimed);
    return ['.claude'];
  } catch (err) {
    // A phase without skills still runs; a conductor that cannot boot does not.
    log.warn('could not compose .claude — skills may not resolve', {
      repoRoot, error: (err as Error).message,
    });
    return [];
  }
}
