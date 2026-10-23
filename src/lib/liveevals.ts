/**
 * Live, gold-free evals run on every real ticket, beside the offline gold evals.
 *
 * eval:causes and eval:edges score only the hand-labelled gold tickets. These
 * two checks need no gold, so they run each time verify or testcases finishes
 * and append one line per phase run to state/live-evals/<date>.jsonl:
 *
 *   verify     the gold-free blame modes (blamed-elsewhere, own-case-dismissed,
 *              orphaned-fail) — code only, no model call
 *   testcases  does each acceptance criterion in the ticket have a case that
 *              would catch it failing — one judge call
 *
 * state/ is per machine and gitignored, so the log stays local. A failure here
 * never touches the run: every entry point swallows its own errors.
 *
 *   npm run eval:live   compare the log by Oneshot commit, by week, and per flag outcome
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BASE_ENV, ROOT, STATE } from './config.js';
import { log } from './log.js';
import { blameFailureModes, blameOf, type TestcasesArtifact, type VerifyArtifact } from './verifyblame.js';
import type { Ticket } from '../phases/types.js';

export const LIVE_DIR = join(STATE, 'live-evals');
const IPV4_SHIM = join(ROOT, 'scripts', 'ipv4-dns.cjs');
const JUDGE_TIER = 'standard';
const JUDGE_MAX_TURNS = 3;

export interface LiveFlag { mode: string; caseId: string }
export interface LiveCriterion { criterion: string; coveredBy: string; reason: string }

export interface LiveRecord {
  at: string;
  oneshot: string;
  iid: number;
  phase: 'verify' | 'testcases';
  lap: number;
  /** verify: every failing case id, and the gold-free flags raised on them. */
  failing?: string[];
  passing?: string[];
  flags?: LiveFlag[];
  /** testcases: the judge's verdict per acceptance criterion. */
  criteria?: LiveCriterion[];
  covered?: number;
  judgeError?: string;
}

interface Case { id: string; scenario?: string; precondition?: string; steps?: string[]; expected?: string }

const CRITERIA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          criterion: { type: 'string', description: 'One acceptance criterion, in a short sentence.' },
          coveredBy: { type: 'string', description: 'The id of the case that would catch this criterion failing, or "none".' },
          reason: { type: 'string', description: 'One line: what in that case catches it, or what every case lacks.' },
        },
        required: ['criterion', 'coveredBy', 'reason'],
      },
    },
  },
  required: ['criteria'],
};

function oneshotCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function judgeModel(): string | null {
  try {
    const models = JSON.parse(readFileSync(join(ROOT, 'config', 'models.json'), 'utf8')) as { tiers: Record<string, string> };
    return models.tiers[JUDGE_TIER] ?? null;
  } catch {
    return null;
  }
}

function append(rec: Omit<LiveRecord, 'at' | 'oneshot'>): void {
  const full: LiveRecord = { at: new Date().toISOString(), oneshot: oneshotCommit(), ...rec };
  mkdirSync(LIVE_DIR, { recursive: true });
  appendFileSync(join(LIVE_DIR, `${full.at.slice(0, 10)}.jsonl`), `${JSON.stringify(full)}\n`);
}

/** The gold-free verify record: which cases failed, which passed, and the blame modes raised. */
export function verifyRecord(iid: number, lap: number, verify: VerifyArtifact | null, testcases: TestcasesArtifact | null): Omit<LiveRecord, 'at' | 'oneshot'> {
  const blame = blameOf(verify, testcases);
  const flags = blameFailureModes(blame, '').map((f) => ({ mode: f.mode, caseId: f.where.trim() }));
  const passing = (verify?.results ?? []).filter((r) => r.result === 'pass').map((r) => r.id ?? '?');
  return { iid, phase: 'verify', lap, failing: blame.failing, passing, flags };
}

function criteriaPrompt(ticket: Ticket, cases: Case[]): string {
  const caseText = cases.map((c) => [
    `${c.id}: ${c.scenario ?? ''}`,
    `  precondition: ${c.precondition || '-'}`,
    `  steps: ${(c.steps ?? []).join(' / ')}`,
    `  expected: ${c.expected ?? ''}`,
  ].join('\n')).join('\n\n');
  return [
    'You grade a QA test list against the ticket it was written for. First list the ticket\'s',
    'acceptance criteria: what it explicitly asks to be true when done (or, for a bug, the broken',
    'behaviour that must now work). Then, for each criterion, name the ONE test case whose',
    'precondition, steps and expected result would fail if the software got that criterion wrong.',
    'Answer "none" when no case would: a case that only visits the same screen does not cover it.',
    'Judge only from the text given.',
    '',
    `TICKET: ${ticket.title}`,
    ticket.description ?? '',
    '',
    'TEST CASES',
    caseText,
  ].join('\n');
}

async function judgeCriteria(ticket: Ticket, cases: Case[], model: string): Promise<LiveCriterion[]> {
  const q = query({
    prompt: criteriaPrompt(ticket, cases),
    options: {
      model,
      env: { ...BASE_ENV },
      tools: [],
      maxTurns: JUDGE_MAX_TURNS,
      settingSources: [],
      systemPrompt: 'You are a strict QA reviewer. Reply only through the structured output.',
      outputFormat: { type: 'json_schema', schema: CRITERIA_SCHEMA },
      ...(existsSync(IPV4_SHIM) ? { executableArgs: ['--require', IPV4_SHIM] } : {}),
    },
  });
  for await (const msg of q) {
    if (msg.type !== 'result') continue;
    if (msg.subtype !== 'success') throw new Error(`judge ended with ${msg.subtype}`);
    return (msg.structured_output as { criteria: LiveCriterion[] }).criteria;
  }
  throw new Error('judge returned no result');
}

/** The testcases record: the judge's per-criterion coverage, or the reason it could not run. */
export async function testcasesRecord(iid: number, lap: number, ticket: Ticket, cases: Case[]): Promise<Omit<LiveRecord, 'at' | 'oneshot'>> {
  const base = { iid, phase: 'testcases' as const, lap };
  const model = judgeModel();
  if (!model) return { ...base, judgeError: `config/models.json has no '${JUDGE_TIER}' tier` };
  if (!ticket.description?.trim()) return { ...base, judgeError: 'ticket has no description to read criteria from' };
  if (!cases.length) return { ...base, criteria: [], covered: 0 };
  try {
    const criteria = await judgeCriteria(ticket, cases, model);
    const ids = new Set(cases.map((c) => c.id));
    const covered = criteria.filter((c) => c.coveredBy !== 'none' && ids.has(c.coveredBy)).length;
    return { ...base, criteria, covered };
  } catch (err) {
    return { ...base, judgeError: (err as Error).message };
  }
}

/** Log the live verify checks. Never throws. */
export function recordLiveVerify(iid: number, lap: number, verify: VerifyArtifact | null, testcases: TestcasesArtifact | null): void {
  try {
    append(verifyRecord(iid, lap, verify, testcases));
  } catch (err) {
    log.warn(`live eval (verify) not recorded: ${(err as Error).message}`, { iid });
  }
}

/** Run the criteria judge in the background and log it. Never throws, never blocks the run. */
export function recordLiveTestcases(iid: number, lap: number, ticket: Ticket, cases: Case[]): void {
  void testcasesRecord(iid, lap, ticket, cases)
    .then(append)
    .catch((err: Error) => log.warn(`live eval (testcases) not recorded: ${err.message}`, { iid }));
}
