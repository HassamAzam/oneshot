#!/usr/bin/env node
'use strict';
/**
 * SessionStart: put the test-case traps list in front of `testcases` before it
 * writes a single case.
 *
 * WHY A HOOK AND NOT A PROMPT LINE. `erp-ticket-test-plan` already says to read
 * `refs/traps.md`, and an instruction to read a file is a request, not a
 * guarantee: the phase has died at its turn cap before now, and the first thing
 * a session under budget pressure drops is a read whose value it cannot see
 * yet. Injecting the content costs the phase ZERO turns and cannot be skipped,
 * which is the whole difference between "should consult" and "has consulted".
 *
 * It also lands earlier than a read ever could. The traps are about how a case
 * is SHAPED — assert only what the diff can change, pair an absence claim with
 * a positive control, write the case for the state a removed blur was hiding.
 * Read after twenty cases are drafted, that list is a rewrite. Read before the
 * first one, it is just how the cases come out.
 *
 * SCOPE. `testcases` only. Every other phase exits before reading anything:
 * `verify` executes a list it did not write, and `implement` does not need a
 * QA checklist competing with its own standards for attention.
 *
 * FAILS OPEN, loudly. A missing or unreadable traps file must never wedge the
 * phase — the prompt still carries the method, and a list authored without the
 * traps is worse than one authored with them but far better than no list at
 * all. The failure is recorded as an event so a silently absent brief is
 * visible in state/hook-events.jsonl rather than being mistaken for a phase
 * that simply ignored its instructions.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const PHASE = 'testcases';
const SKILL = 'erp-ticket-test-plan';

/**
 * Above this the brief stops being a brief. The file is curated by hand and is
 * meant to stay walkable in one pass; if it has grown past this, injecting it
 * whole starts costing more attention than it buys, and the honest answer is to
 * point at it and let the session read what it needs. The number is the point
 * at which a human reviewer would also stop reading in one sitting.
 */
const MAX_INLINE_BYTES = 24_000;

/**
 * Resolve the skill the same way the conductor does — ONESHOT_SKILLS_ROOT when
 * a machine has pointed at a live `.claude`, otherwise the vendored `context/`
 * snapshot that ships with the repo. Duplicated rather than imported because
 * hooks stay dependency-free: they must run before `npm install` and must not
 * be breakable by a bad node_modules.
 */
function trapsPath() {
  const root = C.expandTilde(process.env.ONESHOT_SKILLS_ROOT || path.join(C.ONESHOT, 'context'));
  return path.join(root, 'skills', SKILL, 'refs', 'traps.md');
}

function inject(context) {
  C.emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
  process.exit(0);
}

if (C.phase() !== PHASE) C.allow();

const file = trapsPath();
let traps = '';
try {
  traps = fs.readFileSync(file, 'utf8');
} catch (err) {
  C.event('traps_brief_missing', { file, error: err.message });
  C.allow();
}

if (!traps.trim()) {
  C.event('traps_brief_empty', { file });
  C.allow();
}

const oversized = Buffer.byteLength(traps, 'utf8') > MAX_INLINE_BYTES;
C.event('traps_brief_injected', { file, bytes: Buffer.byteLength(traps, 'utf8'), oversized });

if (oversized) {
  inject(
    `## Traps — read this before you write any case\n\n` +
    `\`${file}\` has outgrown an inline brief. READ IT NOW, before drafting, not after. ` +
    'Every entry in it is a revision request QA has already had to make on a real ticket: ' +
    'a case that failed on a correct build, passed on an unchanged one, or was never written. ' +
    'Walking it first is the difference between a list approved in one round and one that costs three.',
  );
}

inject(
  `## Traps — what QA has already had to send back\n\n` +
  'This is the curated list of test-case mistakes made on earlier tickets in this codebase, ' +
  'injected so you have it before you draft rather than after. It is not optional background: ' +
  'walk it against your draft before you present, and again over any list you revise.\n\n' +
  'Two checks it exists to make you run, on EVERY case:\n' +
  '  1. Would this case still pass if the diff were reverted? Then it proves nothing about the ' +
  'change — label it a smoke check and give it a positive control.\n' +
  '  2. Does this change REMOVE something that was hiding a state (a blur, a disabled look, a ' +
  'muted colour, a collapsed row)? Then write the cases for what it was hiding, not just for its ' +
  'absence. That class is the most-missed one on record.\n\n' +
  `Say in your output which traps you applied and which you considered and ruled out.\n\n` +
  `Source of truth, if you need to re-read it: \`${file}\`\n\n` +
  `---\n\n${traps}`,
);
