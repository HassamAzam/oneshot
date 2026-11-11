import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import { ROOT, type PhaseConfig } from '../lib/config.js';
import { schemaFor } from '../conductor/schemas.js';
import { buildEvidence, renderEvidence } from './evidence.js';
import { diagnosePrompt } from './prompt.js';
import { DIAGNOSE_SCHEMA } from './schema.js';
import { CATEGORIES, FIX_BY } from './types.js';
import { bash, init, lateExit, makeRun, success } from './test-fixtures.js';

/** Read from config/phases.json itself: phases() filters by this desk's target. */
const shipped = (name: string): PhaseConfig => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'config', 'phases.json'), 'utf8')) as { phases: PhaseConfig[] };
  const p = raw.phases.find((x) => x.name === name);
  assert.ok(p, `phase ${name} is in config/phases.json`);
  return p;
};

function promptFor(over: { status?: string; earlier?: Parameters<typeof diagnosePrompt>[0]['earlier'] } = {}): string {
  const run = makeRun({
    status: over.status ?? 'blocked', stoppedPhase: 'merge', blockedWhy: 'merge: refused over F-05',
    records: [{ phase: 'verify', status: 'failed', error: 'Claude Code process exited with code 1', turns: 160 }],
    transcripts: { 'verify-lap0.jsonl': [init(), success(160), lateExit()] },
  });
  try {
    const evidence = buildEvidence({ dir: run.dir })!;
    return diagnosePrompt({
      evidence, digest: renderEvidence(evidence), runDir: '/srv/oneshot/state/runs/990174', repo: '/srv/oneshot',
      peek: 'node /srv/oneshot/node_modules/tsx/dist/cli.mjs /srv/oneshot/scripts/diagnose.ts peek --dir /srv/oneshot/state/runs/990174',
      budgetMin: 30, repoHead: 'some/branch @ 81b738e', earlier: over.earlier,
    });
  } finally {
    run.cleanup();
  }
}

test('the session is handed the digest, the run directory and the commands that read a transcript safely', () => {
  const p = promptFor();
  assert.match(p, /# Diagnose run r-test0001-abcdef — ticket #990174/);
  assert.match(p, /This run has stopped, blocked, at `merge`\./);
  assert.match(p, /merge: refused over F-05/, 'the stop reason, from the digest');
  assert.match(p, /\[finished-then-exit\] verify lap 0 was recorded failed/, 'the facts, from the digest');
  assert.ok(p.includes('scripts/diagnose.ts peek --dir /srv/oneshot/state/runs/990174 frames transcripts/'));
  assert.ok(p.includes('peek --dir /srv/oneshot/state/runs/990174 grep '));
  assert.match(p, /It is checked out at some\/branch @ 81b738e\./);
});

test('it is told never to read a transcript raw, and never to change anything', () => {
  const p = promptFor();
  assert.match(p, /NEVER `cat`, `Read`, `head`, `tail`, `sed` or raw-`grep` a file under\n`transcripts\/`/);
  assert.match(p, /You change NOTHING: no file, no git state, no\nGitLab, no service, no database\./);
  assert.match(p, /Never recommend loosening a check/);
});

test('it is told the recorded error is a claim, that citations are checked, and what survives a run is still recorded', () => {
  const p = promptFor();
  assert.match(p, /The journal's error text is a claim to check, never a finding/);
  assert.match(p, /Code re-opens each one after you finish/);
  assert.match(p, /A harness finding MUST cite the code/);
  assert.match(p, /Record what is broken even when it did not stop this run/);
  for (const c of CATEGORIES) assert.ok(p.includes(`\`${c}\` —`), `the ${c} category is defined`);
});

test('a parked run is described as waiting, and an earlier diagnosis of the same run is not derived again', () => {
  assert.match(promptFor({ status: 'parked' }), /This run has parked, waiting on a person/);
  assert.doesNotMatch(promptFor(), /was diagnosed before/);
  const again = promptFor({ earlier: [{ headline: 'The machine cannot create a test database.', nextStep: 'Seed the settings.', findings: [{ id: 'D-1', category: 'harness', title: 'no test settings' }] }] });
  assert.match(again, /## This run was diagnosed before, at an earlier stop/);
  assert.match(again, /- D-1 \[harness\] no test settings/);
  assert.match(again, /Do not re-derive what is above/);
});

test('the shipped phase is read-only, on demand, and has a schema and a skill that exist', () => {
  const p = shipped('diagnose');
  assert.deepEqual(p.writes, [], 'no write scope: phase.ts withholds Write and Edit');
  assert.equal(p.onDemand, true, 'the Loop steps over it');
  assert.equal(p.kind, 'session');
  assert.equal(p.cwd, 'conductor');
  assert.equal(schemaFor('diagnose'), DIAGNOSE_SCHEMA);
  for (const skill of p.skills ?? []) {
    const body = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(`^---\\nname: ${skill}\\n`));
  }
});

test('the schema and the skill name exactly the categories and fixes the code branches on', () => {
  const props = (DIAGNOSE_SCHEMA.properties as Record<string, { items?: { properties: Record<string, { enum?: string[] }> } }>);
  const item = props.findings!.items!.properties;
  assert.deepEqual(item.category!.enum, [...CATEGORIES]);
  assert.deepEqual(item.fix!.enum, [...FIX_BY]);
  const skill = readFileSync(join(ROOT, 'skills', 'failure-diagnosis', 'SKILL.md'), 'utf8');
  for (const c of CATEGORIES) assert.ok(skill.includes(`\`${c}\``), `the skill defines ${c}`);
});

test('the peek commands the prompt hands over really run, in a bare environment, and never print a frame whole', () => {
  // The session's environment is an allowlist and its only way into a transcript is this command.
  const big = 'x'.repeat(300_000);
  const run = makeRun({
    transcripts: {
      'verify-lap0.jsonl': [init(), ...bash('node scripts/app.cjs ensure', `{ "code": "E_PORT_DRIFT" }\n${big}`), success(3), lateExit()],
      // An earlier diagnosis of this run, talking about the same thing.
      'diagnose-lap0.jsonl': [init(), ...bash('peek grep', 'the earlier diagnosis said E_PORT_DRIFT was the cause'), success(2)],
    },
  });
  try {
    const peek = (...args: string[]): string => execFileSync(process.execPath, [
      join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'scripts', 'diagnose.ts'), 'peek', '--dir', run.dir, ...args,
    ], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeout: 60_000 });

    const grep = peek('grep', 'E_PORT_DRIFT');
    assert.match(grep, /^transcripts\/verify-lap0\.jsonl:3\tuser\t.*E_PORT_DRIFT/m, 'a hit is file:line, ready to cite');
    assert.ok(grep.length < 2000);

    const frames = peek('frames', 'transcripts/verify-lap0.jsonl', '1', '9');
    assert.deepEqual(frames.trim().split('\n').map((l) => l.split('\t')[0]), ['1', '2', '3', '4', '5']);
    assert.match(frames, /^4\tresult\t\[result success turns=3\]/m);
    assert.ok(frames.length < 3000, 'a 300 KB frame is one short line');

    const frame = peek('frame', 'transcripts/verify-lap0.jsonl', '3', '400');
    assert.ok(frame.length < 700);
    assert.match(frame, /\+\d+ chars/);
    // A negative length used to slice from the end and print the frame nearly whole.
    assert.ok(peek('frame', 'transcripts/verify-lap0.jsonl', '3', '-1').length < 700);
    assert.ok(peek('grep', '[\\s\\S]+').length < 20_000, 'a pattern that matches everything shows a window, not the frame');

    // What the run did, not what an earlier diagnosis said about it.
    assert.doesNotMatch(grep, /diagnose-lap0/);
    assert.match(peek('grep', 'E_PORT_DRIFT', 'transcripts/diagnose-lap0.jsonl'), /^transcripts\/diagnose-lap0\.jsonl:3\t/m, 'still readable when named');
  } finally {
    run.cleanup();
  }
});
