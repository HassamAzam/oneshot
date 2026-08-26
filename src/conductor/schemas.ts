/**
 * JSON Schemas for phase handoffs.
 *
 * These are passed to the Agent SDK as `outputFormat: {type:'json_schema'}`, so
 * conformance is enforced at the tool-call layer with the SDK's own retries —
 * a phase physically cannot end with prose where a structured result belongs.
 * That is why the handoff contract is a schema here rather than a paragraph in
 * a skill: a paragraph is advice, and advice gets dropped under load.
 *
 * Keep every schema `additionalProperties: false`. A model that invents a field
 * is a model that misunderstood the contract, and silently accepting it means
 * the next phase reads a field that will not be there next time.
 */

export type JsonSchema = Record<string, unknown>;

const str = (description: string) => ({ type: 'string', description });
const strArr = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

/** Fields every phase returns, so the runner can treat them uniformly. */
const COMMON = {
  summary: str('One or two sentences for the Slack card. No markdown.'),
  blocked: {
    type: ['string', 'null'],
    description:
      'Non-null ONLY when you could not finish and no retry would help: a missing input, ' +
      'an environment that is down, a decision only a human can make. State what would ' +
      'unblock it. Null otherwise.',
  },
} as const;

function phaseSchema(props: Record<string, unknown>, required: string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { ...COMMON, ...props },
    required: ['summary', 'blocked', ...required],
  };
}

export const RECALL_SCHEMA = phaseSchema({
  priorTickets: {
    type: 'array',
    description: 'Past runs that touched the same files or module. Empty is a valid answer.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        iid: { type: 'number' },
        title: str('Ticket title'),
        why: str('What makes it relevant to this ticket'),
        gotchas: strArr('Specific traps that run hit, if any'),
      },
      required: ['iid', 'title', 'why', 'gotchas'],
    },
  },
  brief: str('Prior-art brief injected into research and plan. Empty string if no prior art.'),
}, ['priorTickets', 'brief']);

export const RESEARCH_SCHEMA = phaseSchema({
  understanding: str('What the ticket actually asks for, in your own words.'),
  acceptanceCriteria: strArr('Explicit criteria, including any amended in ticket COMMENTS.'),
  codePath: {
    type: 'array',
    description: 'The trace through the code, in execution order.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: str('Repo-relative path'),
        line: { type: 'number', description: '1-indexed anchor line' },
        role: str('What this location does in the flow'),
      },
      required: ['file', 'line', 'role'],
    },
  },
  blastRadius: strArr('Other modules/features this change can affect. Consult CLAUDE.md linkages.'),
  unknowns: strArr('What you could NOT determine. State these rather than guessing.'),
  module: str('Primary module, e.g. Payroll, Leaves, Project Logs.'),
}, ['understanding', 'acceptanceCriteria', 'codePath', 'blastRadius', 'unknowns', 'module']);

export const PLAN_SCHEMA = phaseSchema({
  approach: str('The chosen approach and, in one line, why over the alternative.'),
  reuse: strArr('Existing helpers/components to extend instead of writing new ones.'),
  steps: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        n: { type: 'number' },
        what: str('The change'),
        files: strArr('Files to touch'),
        layer: { type: 'string', enum: ['backend', 'frontend', 'migration', 'test', 'config'] },
      },
      required: ['n', 'what', 'files', 'layer'],
    },
  },
  migrations: { type: 'boolean', description: 'True if any model/schema change is required.' },
  risks: strArr('What could go wrong, and the mitigation.'),
}, ['approach', 'reuse', 'steps', 'migrations', 'risks']);

export const TESTCASES_SCHEMA = phaseSchema({
  module: str('Module name for suite tagging'),
  lv: str("Block header id. Emit 'LV_TBD' — the real number needs the sheet."),
  cases: {
    type: 'array',
    description: '7-20 cases. This ONE list is executed by verify, ui-evidence and qa.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: str('TC-01, TC-02, …'),
        scenario: str("Starts with 'Verify that…'"),
        precondition: str('State that must exist first. Empty string if none.'),
        steps: strArr('Ordered steps, one per element.'),
        expected: str('The oracle. Required — without it a QA verdict means nothing.'),
        pass: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['happy', 'boundary', 'negative', 'state', 'side-effect',
              'cross-module', 'regression', 'hostile'],
          },
        },
        blast: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['id', 'scenario', 'precondition', 'steps', 'expected', 'pass', 'blast'],
    },
  },
  passesEmpty: strArr(
    'Passes you ran that legitimately produced nothing. Recording this is what stops ' +
    'a SKIPPED pass from looking identical to a clean one.',
  ),
}, ['module', 'lv', 'cases', 'passesEmpty']);

export const IMPLEMENT_SCHEMA = phaseSchema({
  commits: strArr('Short SHAs committed this lap.'),
  filesChanged: strArr('Repo-relative paths.'),
  migrationsAdded: strArr('Migration files created, if any.'),
  lintClean: { type: 'boolean', description: 'flake8 + pylint + eslint all pass.' },
  testsRun: str('What was run and the outcome. Empty string if none were run.'),
  addressedFindings: strArr('Finding ids from a previous review lap that this lap fixed.'),
}, ['commits', 'filesChanged', 'migrationsAdded', 'lintClean', 'testsRun', 'addressedFindings']);

export const FINDINGS_SCHEMA = phaseSchema({
  verdict: { type: 'string', enum: ['approve', 'changes-requested'] },
  findings: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: str('F-01, F-02, …'),
        severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'suggestion'] },
        file: str('Repo-relative path'),
        line: { type: 'number' },
        what: str('The defect, in one sentence'),
        why: str('Concrete failure: inputs/state -> wrong output'),
        fix: str('What to change'),
      },
      required: ['id', 'severity', 'file', 'line', 'what', 'why', 'fix'],
    },
  },
}, ['verdict', 'findings']);

const CASE_RESULT = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: str('Case id from testcases.json'),
      result: { type: 'string', enum: ['pass', 'fail', 'blocked', 'skipped'] },
      evidence: str('What you observed. For a fail, the actual vs expected.'),
      screenshot: str('Filename under artifacts/, or empty string.'),
    },
    required: ['id', 'result', 'evidence', 'screenshot'],
  },
} as const;

export const VERIFY_SCHEMA = phaseSchema({
  serverStarted: { type: 'boolean' },
  port: { type: 'number' },
  results: CASE_RESULT,
  regressions: strArr('Things that worked before this change and no longer do.'),
}, ['serverStarted', 'port', 'results', 'regressions']);

export const UI_EVIDENCE_SCHEMA = phaseSchema({
  screenshots: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: str('Filename under artifacts/'),
        caption: str('What it shows'),
        caseId: str('Related case id, or empty string'),
      },
      required: ['file', 'caption', 'caseId'],
    },
  },
}, ['screenshots']);

export const MR_SCHEMA = phaseSchema({
  mrIid: { type: 'number' },
  mrUrl: str('Full MR URL'),
  title: str('MR title'),
  targetBranch: str('Branch the MR targets'),
}, ['mrIid', 'mrUrl', 'title', 'targetBranch']);

/**
 * Deploy is the one phase whose own account of itself is never the source of
 * truth: the conductor re-derives the SHA and the health status from the box
 * afterwards. These fields exist so a disagreement between the two is loud
 * rather than silently overwritten — and so an in-session retry leaves a trace,
 * since the runner records one row per phase and would otherwise show a deploy
 * that took three builds as a clean single pass.
 */
export const DEPLOY_SCHEMA = phaseSchema({
  deployedSha: str(
    'The 40-hex SHA the demo box HEAD is on now. Read it from a command you ran — the script ' +
    'output or a fresh rev-parse — never from recollection. The conductor re-derives this ' +
    'independently and blocks the run if the two disagree.',
  ),
  healthOk: {
    type: 'boolean',
    description:
      'The site returned the expected status through the Host header on your final check. ' +
      'A bare-IP request returns 400 from ALLOWED_HOSTS and looks exactly like a broken app.',
  },
  attempts: {
    type: 'number',
    minimum: 1,
    maximum: 3,
    description:
      'How many times you launched the deploy script, INCLUDING the ones that failed. Three is ' +
      'the cap and the guard enforces it.',
  },
  flagsUsed: strArr("Dependency flags passed on the successful attempt: '--npm', '--pip', or neither."),
  flagsRationale: str(
    'Why those flags and not others, in one sentence, naming the files in THIS run\'s diff that ' +
    'justified them (package.json -> --npm, requirements/ -> --pip). If you passed none and the ' +
    'script reported a dependency change, say why that was right.',
  ),
  serviceState: str(
    'What supervisorctl showed at the end: which demo_erp units are running, and whether they ' +
    'held the same PIDs across the stability window. A crash-loop reads as RUNNING if you only ' +
    'look once.',
  ),
}, ['deployedSha', 'healthOk', 'attempts', 'flagsUsed', 'flagsRationale', 'serviceState']);

export const QA_SCHEMA = phaseSchema({
  deployedSha: str('SHA actually live on the demo server when you tested.'),
  results: CASE_RESULT,
  verdict: { type: 'string', enum: ['pass', 'fail'] },
}, ['deployedSha', 'results', 'verdict']);

export const DEMO_SCHEMA = phaseSchema({
  files: strArr('Demo artefacts produced, under artifacts/.'),
}, ['files']);

export const DOCUMENT_SCHEMA = phaseSchema({
  ticketNoteId: { type: ['number', 'null'], description: 'Id of the note posted on the ticket.' },
  mrNoteId: { type: ['number', 'null'], description: 'Id of the note posted on the MR.' },
  uploaded: strArr('Files attached to GitLab.'),
}, ['ticketNoteId', 'mrNoteId', 'uploaded']);

export const MEMORIZE_SCHEMA = phaseSchema({
  card: str('Path to the memory card written under state/memory/tickets/.'),
  tags: strArr('Search tags for future recall.'),
  filesTouched: strArr('For file-overlap scoring on the next similar ticket.'),
}, ['card', 'tags', 'filesTouched']);

export const SCHEMAS: Record<string, JsonSchema> = {
  recall: RECALL_SCHEMA,
  research: RESEARCH_SCHEMA,
  plan: PLAN_SCHEMA,
  testcases: TESTCASES_SCHEMA,
  implement: IMPLEMENT_SCHEMA,
  review: FINDINGS_SCHEMA,
  verify: VERIFY_SCHEMA,
  'ui-evidence': UI_EVIDENCE_SCHEMA,
  mr: MR_SCHEMA,
  deploy: DEPLOY_SCHEMA,
  qa: QA_SCHEMA,
  demo: DEMO_SCHEMA,
  document: DOCUMENT_SCHEMA,
  memorize: MEMORIZE_SCHEMA,
};

export function schemaFor(phase: string): JsonSchema | undefined {
  return SCHEMAS[phase];
}
