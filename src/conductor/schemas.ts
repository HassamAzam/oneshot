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
import { ADDRESSED_FEEDBACK_PROP, MR_FEEDBACK_PROPS } from '../mrfeedback/schema.js';

export type JsonSchema = Record<string, unknown>;

const str = (description: string) => ({ type: 'string', description });
const strArr = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

/** Fields every phase returns, so the runner can treat them uniformly. */
const COMMON = {
  summary: str('One or two sentences for the Slack card. No markdown.'),
  blocked: {
    type: ['string', 'null'],
    description:
      'Set ONLY when you could not finish and no retry would help: a missing input, ' +
      'an environment that is down, a decision only a human can make. State what would ' +
      'unblock it. Omit it, or send null, when nothing is blocking you.',
  },
} as const;

/**
 * `blocked` is deliberately NOT required.
 *
 * Every other field here describes work the phase did, so demanding it costs
 * nothing. `blocked` is the opposite: the overwhelmingly common value is "no",
 * and making it required turns the happy path into a sentence the model has to
 * serialise correctly in order to say nothing at all. That is not hypothetical
 * — an implement phase once emitted `</parameter><parameter name="blocked">`
 * as literal text inside `summary`, so the field never materialised, and five
 * identical retries later a 28-minute lap whose commits were already on the
 * branch was recorded as a failure.
 *
 * Omission is safe because nothing downstream distinguishes it from null:
 * runSession() reads `typeof b === 'string' && b.trim() ? b : null`, so absent,
 * null and empty all mean the same thing at the only place that reads it. The
 * guarantee this drops — "a phase cannot forget to mention it is blocked" — was
 * never real either, since a phase could always have sent null anyway. A phase
 * that IS blocked has every incentive to say so; one that is not should not
 * have to.
 */
function phaseSchema(props: Record<string, unknown>, required: string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { ...COMMON, ...props },
    required: ['summary', ...required],
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
  uiPath: {
    type: 'object',
    additionalProperties: false,
    description:
      'How a person reaches this behaviour in the browser. testcases, verify, ui-evidence ' +
      'and qa all need this and NONE of them can get it from the diff when the change is a ' +
      'logic-layer fix behind a screen — that gap cost run 237 its whole turn budget.',
    properties: {
      reachable: {
        type: 'boolean',
        description:
          'False for a change with no UI surface at all (a management command, a Celery ' +
          'task, an API-only contract). False is a real answer and leaves the rest empty.',
      },
      route: str(
        'The URL path a case starts at, e.g. /project-logs/v2/person/:id. Empty if not reachable.',
      ),
      entryPoint: str(
        'The clicks from that route to the behaviour, in one line: which control opens ' +
        'which modal/tab. Empty if not reachable.',
      ),
      gate: str(
        'Any permission, feature flag or role that hides this from a default account, named ' +
        'as the constant. Empty string if nothing gates it.',
      ),
      vocabulary: strArr(
        'The concrete strings a step can be written against: testid constants, button ' +
        'labels, DISPLAY_STRINGS keys, error messages — each with the file it lives in. ' +
        'This is the field that stops a later phase from re-deriving the screen.',
      ),
    },
    required: ['reachable', 'route', 'entryPoint', 'gate', 'vocabulary'],
  },
  unknowns: strArr('What you could NOT determine. State these rather than guessing.'),
  module: str('Primary module, e.g. Payroll, Leaves, Project Logs.'),
  reproduction: {
    type: 'object',
    additionalProperties: false,
    description:
      'Whether the reported defect actually happens on the base branch, established by running ' +
      'it (skill: bug-reproduction). A verdict of not-reproduced STOPS the run and labels the ' +
      'ticket Not a Bug, so it must rest on steps you executed, never on reading code.',
    properties: {
      kind: {
        type: 'string',
        enum: ['bug', 'feature'],
        description:
          'bug: the ticket reports existing behaviour that is wrong. feature: it asks for ' +
          'something new or different. Only a bug can be reproduced.',
      },
      verdict: {
        type: 'string',
        enum: ['reproduced', 'not-reproduced', 'inconclusive', 'not-applicable'],
        description:
          'reproduced: you saw the reported behaviour. not-reproduced: app up, logged in with ' +
          'access to the screen, every reported step executed, and the CORRECT behaviour ' +
          'observed. inconclusive: anything that stopped you from getting that far (data, ' +
          'role, environment, browser, flake). not-applicable: a feature, no UI surface, or ' +
          'reproduction disabled.',
      },
      testedCommit: str('The commit the app ran on (git rev-parse HEAD in the worktree). Empty if the app never ran.'),
      account: str('The account/role the steps ran as. Empty if you never logged in.'),
      steps: strArr('The steps you actually executed, in order, each with what you did.'),
      expected: str('What the ticket says SHOULD happen.'),
      observed: str('What actually happened when you ran the steps — concrete values, not impressions.'),
      evidence: strArr('Bare filenames of screenshots written to the run artifacts dir, plus any measurement.'),
      reason: str('Why this verdict. For inconclusive or not-applicable, what stopped you.'),
    },
    required: ['kind', 'verdict', 'testedCommit', 'account', 'steps', 'expected', 'observed', 'evidence', 'reason'],
  },
}, ['understanding', 'acceptanceCriteria', 'codePath', 'blastRadius', 'uiPath', 'unknowns', 'module', 'reproduction']);

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
  risks: strArr('What could break, and the mitigation. Not a place for undecided scope — that is openQuestions.'),
  openQuestions: strArr(
    'Decisions only a person (requester, PM, dev) can make — a scope or product choice the ' +
    'ticket does not state. Each: the question, the default this plan assumes if nobody ' +
    'answers, and what changes if the answer differs. Empty when nothing is undecided.',
  ),
  outOfScope: strArr(
    'Related problems found and deliberately NOT fixed here. Each: what, why excluded, and ' +
    'where it belongs (e.g. a separate ticket).',
  ),
  acceptanceCoverage: {
    type: 'array',
    description: 'One entry per acceptance criterion from research, in the same order.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        criterion: str('The criterion, as research recorded it'),
        coveredBy: str('Step numbers and/or the check that demonstrates it, e.g. "steps 2-3; step 5 test"'),
        status: { type: 'string', enum: ['covered', 'partial', 'not-satisfiable'] },
        note: str('Why partial or not satisfiable, and what is done instead. Empty string when covered.'),
      },
      required: ['criterion', 'coveredBy', 'status', 'note'],
    },
  },
  feedbackResponse: {
    type: 'array',
    description:
      'One entry per distinct point in the reviewer feedback this revision answers. Empty when ' +
      'there was no feedback. Only what this artifact shows counts: a point you resolved in ' +
      'your reasoning but did not write into a step, question, out-of-scope entry or risk has ' +
      'not reached the approver.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        point: str('The reviewer\'s point, in a few words'),
        response: { type: 'string', enum: ['changed', 'declined', 'answered'] },
        where: str('Where this plan now carries it, e.g. "step 6", "open question 2", "out of scope". Empty only for declined.'),
        note: str('One line: what changed, or why declined'),
      },
      required: ['point', 'response', 'where', 'note'],
    },
  },
}, ['approach', 'reuse', 'steps', 'migrations', 'risks', 'openQuestions', 'outOfScope', 'acceptanceCoverage', 'feedbackResponse']);

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
  addressedFeedback: ADDRESSED_FEEDBACK_PROP,
}, ['commits', 'filesChanged', 'migrationsAdded', 'lintClean', 'testsRun', 'addressedFindings', 'addressedFeedback']);

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
  observations: {
    type: 'array',
    description:
      'Evidence for what a screenshot cannot show — a <title>, an aria-* or alt value, lang, ' +
      'a meta tag, focus order, a response header. One row per value, measured, never painted ' +
      'onto the page. Empty array when every change is visible on screen.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        what: str('The value measured and where, e.g. "document.title on /accounts/password_reset/"'),
        before: str('The value on the base branch, verbatim, or "not measured" with the reason'),
        after: str('The value on this branch, verbatim'),
        how: str('How it was read, e.g. "Playwright page.title()", "curl + grep <title>", "git show origin/dev:<path>"'),
        caseId: str('Related case id, or empty string'),
      },
      required: ['what', 'before', 'after', 'how', 'caseId'],
    },
  },
}, ['screenshots', 'observations']);

export const MR_SCHEMA = phaseSchema({
  mrIid: { type: 'number' },
  mrUrl: str('Full MR URL'),
  title: str('MR title'),
  targetBranch: str('Branch the MR targets'),
}, ['mrIid', 'mrUrl', 'title', 'targetBranch']);

/**
 * The remediation contract — the one schema whose most valuable answer is a
 * negative one.
 *
 * `fixed` is what the conductor acts on, so an optimistic one is expensive in a
 * way no other field here is: the run re-enters the pipeline, walks into the
 * same wall, and the real cause is now buried under a record saying it was
 * handled. `category` is the check on it. 'code' means the cause was a defect
 * in the ticket's own change, which this phase may not touch at all, so 'code'
 * with fixed:true is a contradiction — the prompt forbids it, and a reader who
 * sees it should treat the run as faulty rather than the environment as
 * repaired.
 *
 * `changes` exists for the same reason qa's `dataChanges` does: these repairs
 * land on infrastructure other people share, and an unrecorded one is
 * indistinguishable a week later from somebody breaking their own environment.
 */
export const REMEDIATE_SCHEMA = phaseSchema({
  diagnosis: str(
    'The causal account: what actually went wrong, the evidence you have for that, and why it ' +
    'surfaced as the reason the blocked phase reported. Not a restatement of that reason — the ' +
    'conductor already holds it.',
  ),
  category: {
    type: 'string',
    enum: ['environment', 'provisioning', 'credentials', 'infrastructure', 'code', 'unknown'],
    description:
      "Where the cause lives. 'environment' = this machine or this run's own state (a stale " +
      "lock, a wedged process, a leaked lease, a config value wrong for this box). " +
      "'provisioning' = something that was never set up: an account, a group, test data. " +
      "'credentials' = something that was set up and is wrong, expired or rejected. " +
      "'infrastructure' = a service or network beyond this machine: the VPN, GitLab, the demo " +
      "server. 'code' = a defect in the ticket's own change, which is NOT this phase's to fix. " +
      "'unknown' = you could not determine it, which is an honest answer and not a failure.",
  },
  fixed: {
    type: 'boolean',
    description:
      'True ONLY when you changed something and the cause is gone. Never true for ' +
      "category 'code': that cause belongs to `implement`, whose work is reviewed, and " +
      'claiming it here ships an unreviewed change through a pipeline that will report it as ' +
      'verified.',
  },
  changes: strArr(
    'Every change you made, one per entry, precise enough that someone could undo it without ' +
    'asking you: what you changed, where, from what to what. A group granted, a process ' +
    'killed, a lock cleared. Empty when you changed nothing — which is a complete answer.',
  ),
  retryFrom: str(
    'The phase the run should resume from: a name from config/phases.json, never this one. ' +
    "Use '' when nothing should be retried, because a retry would repeat the failure " +
    'identically. Everything between that phase and the block re-runs, so name the earliest ' +
    'phase whose output your fix invalidates and no earlier.',
  ),
  humanNeeded: str(
    "'' when no person is needed. Otherwise the exact action one must take, written for " +
    'someone who has none of this context: the file and the value, the credential and the ' +
    "account, or the service and the host. 'Investigate the login problem' is not an action.",
  ),
}, ['diagnosis', 'category', 'fixed', 'changes', 'retryFrom', 'humanNeeded']);

/** Triage of MR review threads — the on-demand `mr-feedback` phase. See src/mrfeedback. */
export const MR_FEEDBACK_SCHEMA = phaseSchema(MR_FEEDBACK_PROPS, ['items']);

/** The design-agent report, shaped like the one its Slack driver already asks for. */
export const DESIGN_SCHEMA = phaseSchema({
  files: strArr('Every PNG and the PDF, as paths RELATIVE to the artifacts directory, e.g. design/01-default.png.'),
  screens: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: { file: str('Relative PNG path'), name: str('Screen name'), shows: str('What it shows') },
      required: ['file', 'name', 'shows'],
    },
  },
  encoding: strArr('How each distinct meaning is visually encoded (never colour alone).'),
  groundedIn: strArr('Real component and theme file paths read before designing.'),
  assumptions: strArr('Decisions the ticket did not specify.'),
  openQuestions: strArr('Up to three things the approver should decide.'),
}, ['files', 'screens', 'encoding', 'groundedIn', 'assumptions', 'openQuestions']);

export const SCHEMAS: Record<string, JsonSchema> = {
  recall: RECALL_SCHEMA,
  research: RESEARCH_SCHEMA,
  plan: PLAN_SCHEMA,
  design: DESIGN_SCHEMA,
  testcases: TESTCASES_SCHEMA,
  implement: IMPLEMENT_SCHEMA,
  review: FINDINGS_SCHEMA,
  verify: VERIFY_SCHEMA,
  'ui-evidence': UI_EVIDENCE_SCHEMA,
  mr: MR_SCHEMA,
  remediate: REMEDIATE_SCHEMA,
  'mr-feedback': MR_FEEDBACK_SCHEMA,
};

export function schemaFor(phase: string): JsonSchema | undefined {
  return SCHEMAS[phase];
}
