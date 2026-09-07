/**
 * The opt-in `Review` label's two SESSION-side pause points: plan approval
 * (between phase 2 `plan` and phase 3 `implement`) and test-case approval
 * (between phase 4 `testcases` and phase 5 `review`). The merge gate for phase
 * 9 is pure code and lives in codephases.ts instead, for the same reason
 * `merge` itself is code: no model should be involved in a gate that decides
 * whether the pipeline may proceed.
 *
 * The test-case gate sits BEFORE `review`, not after `qa`, and that position is
 * the whole point of it. Approving a case list while the branch is still
 * unreviewed and unmerged means an edge case a reviewer adds is tested by this
 * run — it flows into `review`, the MR and `qa`. The same approval taken after
 * `qa` would arrive once the code had already shipped, where feedback can only
 * become a follow-up ticket. A gate that cannot change the thing it guards is
 * decoration.
 *
 * Slack is the PRIMARY approval channel here, not GitLab. A gate posts its
 * request as a reply in the ticket's existing Slack thread (`journal.slackTs`)
 * and polls that same thread for a human's reply. GitLab hears about a gate
 * only once it resolves — an `addIssueNote` audit record posted by the
 * caller's `onApproved` hook — never as the place a decision is read from.
 * That is a deliberate reversal of this file's first version, which posted
 * the request as a ticket comment and read GitLab notes for the reply: the
 * human who asked for this wants to work the approval in Slack, where the
 * plan or the test cases are already visible in the same thread as the run's
 * own status card, and wants the ticket to carry only a record of what was
 * decided.
 *
 * This file is deliberately NOT a polling loop. A check is one quick Slack
 * read, and when nothing has happened yet it says so and the CALLER parks the
 * whole run (`RunJournal.status = 'parked'`) rather than sleeping here. That
 * is what makes "poll cadence follows the existing tick loop, no separate
 * polling process" literally true: the only thing that ever re-invokes this
 * check is the conductor's own `TICK_MS` scan re-claiming the ticket and
 * resuming, exactly like any other resumable run. It also means a parked
 * run holds no dispatch slot, no port and no exclusivity between checks —
 * every other ticket, Review-labelled or not, pipelines around it.
 *
 * Zero cap on feedback rounds is structural, not a large number standing in
 * for infinity: `ReviewGateState.feedback` is an array appended to and never
 * trimmed, and nothing here ever refuses a round.
 *
 * Reading a Slack reply back needs a scope this app did not previously need —
 * see `threadReplies()`'s own header in src/lib/slack.ts, and README's
 * "Optional human review gates" for the one-time Slack app configuration
 * change a human has to make.
 */
import { DRY_RUN, projectConfig, slackConfig } from '../lib/config.js';
import {
  readArtifact, readJournal, updateJournal, writeArtifact,
  type ReviewGateState, type RunJournal,
} from '../lib/artifacts.js';
import { slackEnabled, thread, threadReplies, type ThreadReply } from '../lib/slack.js';
import { log } from '../lib/log.js';
import type { TestCase } from '../phases/types.js';

export type Gate = 'plan' | 'testcases';
export type GateVerdict = 'approved' | 'feedback' | 'pending' | 'unavailable';

export interface GateResult {
  verdict: GateVerdict;
  /**
   * Every non-`approved` reply read this round. Set on 'feedback', and ALSO
   * on 'approved' when replies preceded the sign-off — a reviewer who lists
   * two edge cases and then types `approved` said both things, and dropping
   * the first half because the second one arrived is how a gate loses exactly
   * the content it exists to collect.
   */
  feedback?: string;
}

/** Whether this ticket opted into the review gates at all. Additive: absent label, no gates. */
export function reviewLabelPresent(labels: string[]): boolean {
  const label = projectConfig().labels.review;
  return Boolean(label) && labels.includes(label);
}

/**
 * Which of `highScrutinyPaths` this run's files touch.
 *
 * The `Review` label is applied by a person, so it is forgettable — and the
 * tickets worth pausing on are precisely the ones nobody thinks to label. A
 * fix to payroll or leaves is not less consequential because it arrived as an
 * ordinary bug report. So the gates key off what the run actually TOUCHES as
 * well as off the label.
 *
 * Substring matching against repo-relative paths, deliberately: `apps/payroll/`
 * should catch everything beneath it, and a pattern list is easier to audit
 * than a set of regexes nobody can read. Configured per project, and an empty
 * list turns the whole behaviour off.
 */
export function highScrutinyHits(files: string[]): string[] {
  const guarded = projectConfig().highScrutinyPaths ?? [];
  if (!guarded.length) return [];
  const hit = new Set<string>();
  for (const f of files) {
    for (const g of guarded) if (f.includes(g)) hit.add(g);
  }
  return [...hit].sort();
}

/** Every file this run has said it will touch, or has touched. */
export function declaredFiles(
  plan: Record<string, unknown> | null, implemented: Record<string, unknown> | null,
): string[] {
  const steps = Array.isArray(plan?.steps) ? (plan.steps as Array<{ files?: unknown }>) : [];
  const planned = steps.flatMap((s) => (Array.isArray(s.files) ? s.files.map(String) : []));
  const changed = Array.isArray(implemented?.filesChanged)
    ? (implemented.filesChanged as unknown[]).map(String) : [];
  return [...planned, ...changed];
}

export interface GateTrigger {
  on: boolean;
  /** Non-empty when the guarded paths, rather than the label, armed the gates. */
  hits: string[];
}

/**
 * Do the gates apply to this run? Label OR guarded paths — never label alone.
 *
 * Evaluated fresh at each gate rather than once per run, because the answer
 * changes as the run learns: at the plan gate only the plan's declared files
 * exist, and by the test-case gate `implement` has reported what it really
 * touched. A plan that swore off payroll and a diff that edited it anyway is
 * exactly the case worth catching, and only the later evaluation sees it.
 */
export function gatesApply(labels: string[], files: string[]): GateTrigger {
  const hits = highScrutinyHits(files);
  return { on: reviewLabelPresent(labels) || hits.length > 0, hits };
}

/** The one line a gate request needs about why it is asking. */
export function triggerLine(trigger: GateTrigger): string {
  if (!trigger.hits.length) return 'This ticket carries *Review*.';
  return 'This run touches guarded paths — *' + trigger.hits.join('*, *') + '* — so the review '
    + 'gates apply whether or not the ticket carries the `Review` label.';
}

function isApprovedReply(text: string): boolean {
  // Exact match, case-insensitive, trimmed — deliberately NOT a substring
  // test. "approved, but see my comment above" is feedback, not a sign-off:
  // the whole point of requiring the bare word is that a reviewer who wants
  // changes cannot accidentally also approve them.
  return text.trim().toLowerCase() === 'approved';
}

/**
 * Whether this reply's author may sign off.
 *
 * `slackConfig().allowlist` is already "Slack user ids permitted to issue
 * commands" (config/slack.json), and an approval is the highest-consequence
 * command in the system: it is the one that lets a machine proceed past the
 * point a human asked to stop it at. So the same list governs both. Left
 * empty — the shipped default — anyone in the channel may approve, which is
 * the behaviour a private channel holding only the reviewers already relies
 * on; filling it in narrows the gate without changing anything else.
 */
function mayApprove(reply: ThreadReply): boolean {
  const allowed = slackConfig().allowlist;
  if (!allowed.length) return true;
  return reply.user !== null && allowed.includes(reply.user);
}

function blankState(): ReviewGateState {
  return { requestTs: null, approved: false, feedback: [] };
}

function stateOf(j: RunJournal, gate: Gate): ReviewGateState {
  return (gate === 'plan' ? j.planApproval : j.testcasesApproval) ?? blankState();
}

function persist(iid: number, gate: Gate, state: ReviewGateState): RunJournal | null {
  return gate === 'plan'
    ? updateJournal(iid, { planApproval: state })
    : updateJournal(iid, { testcasesApproval: state });
}

export interface CheckGateOpts {
  iid: number;
  gate: Gate;
  /**
   * Posted as a Slack thread reply the moment this gate first arms, or
   * re-arms after a feedback round. Built fresh by the caller on every check
   * (it embeds the current plan, or the current test-case list), never
   * cached here.
   */
  requestBody: string;
  /**
   * Invoked once, exactly on the transition into 'approved' — the caller's
   * chance to leave GitLab its audit record (`addIssueNote`) now that the
   * decision itself has already been made in Slack.
   */
  onApproved?: () => Promise<void>;
  /**
   * Invoked with the round's non-`approved` replies, BEFORE `onApproved` —
   * so a caller that folds feedback into an artifact (the test-case gate appending
   * edge cases to testcases.json) has already done so by the time the audit
   * record of what was approved is built from that same artifact.
   */
  onFeedback?: (feedback: string) => Promise<void>;
}

/**
 * One check of one gate. Never sleeps, never loops — see the file header.
 *
 * DRY_RUN auto-approves: a dry run is "watch the pipeline drive a real ticket
 * without touching it," and a Slack reply is exactly the human interaction
 * DRY_RUN exists to suppress, so requiring a real one here would just wedge
 * the dry run forever waiting for something it can never ask for.
 */
export async function checkApprovalGate(opts: CheckGateOpts): Promise<GateResult> {
  const { iid, gate, requestBody, onApproved, onFeedback } = opts;

  if (DRY_RUN) {
    log.warn(`[dry-run] would pause at the '${gate}' review gate — auto-approving`, { iid });
    return { verdict: 'approved' };
  }

  // No Slack, no gate — and 'pending' would be a lie, because nothing about
  // waiting longer can produce a reply from a channel this process cannot
  // post to or read. A park is the one status that swaps no label and alerts
  // nobody, so parking on a question that can never be asked is a run that
  // waits forever in silence. Say so instead, and let the caller BLOCK: this
  // is a configuration mistake, and a configuration mistake needs the person
  // who can fix it.
  if (!slackEnabled()) return { verdict: 'unavailable' };

  const journal = readJournal(iid);
  if (!journal) return { verdict: 'pending' };

  // The gate asks IN the ticket's thread and reads replies back out of that
  // same thread, so without its ts there is nowhere to poll. Arming anyway
  // would post the request as a stray top-level message and latch requestTs
  // against a thread that is never read — permanently pending, with the
  // request sitting in the channel looking answered. runTicket re-posts the
  // card at the top of every run, so waiting is what actually heals this.
  const threadTs = journal.slackTs ?? null;
  if (threadTs === null) {
    log.warn(`${gate} gate has no Slack thread to ask in yet — retrying next tick`, { iid });
    return { verdict: 'pending' };
  }

  let state = stateOf(journal, gate);

  if (state.requestTs === null) {
    const ts = await thread(threadTs, requestBody);
    if (ts === null) {
      log.warn(`${gate} approval request could not be posted to Slack — will retry next tick`, { iid });
      return { verdict: 'pending' };
    }
    state = { ...state, requestTs: ts };
    persist(iid, gate, state);
    log.phase(`${gate} approval requested on #${iid}`, { ts });
    return { verdict: 'pending' };
  }

  const replies = await threadReplies(threadTs, state.requestTs);
  const approvedAt = replies.findIndex((r) => isApprovedReply(r.text) && mayApprove(r));
  for (const r of replies) {
    if (isApprovedReply(r.text) && !mayApprove(r)) {
      log.warn(`${gate} gate ignored an 'approved' from a user outside the Slack allowlist`, { iid, user: r.user });
    }
  }

  // Replies BEFORE the sign-off are the round's feedback; an `approved` is
  // never also feedback, whoever sent it.
  const feedback = (approvedAt === -1 ? replies : replies.slice(0, approvedAt))
    .filter((r) => !isApprovedReply(r.text))
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join('\n');

  if (feedback && onFeedback) await onFeedback(feedback);

  if (approvedAt !== -1) {
    state = {
      ...state,
      approved: true,
      feedback: feedback ? [...state.feedback, feedback] : state.feedback,
    };
    persist(iid, gate, state);
    if (onApproved) await onApproved();
    await thread(threadTs, `*#${iid} — ${gate} approved.*`);
    log.ok(`${gate} approved on #${iid}`);
    return { verdict: 'approved', feedback: feedback || undefined };
  }

  if (feedback) {
    // requestTs resets to null: the NEXT check re-arms with a fresh request
    // reply, so the reply that follows the revision is measured from here
    // rather than from the round that just ended.
    state = { requestTs: null, approved: false, feedback: [...state.feedback, feedback] };
    persist(iid, gate, state);
    log.phase(`${gate} feedback received on #${iid}`, { rounds: state.feedback.length });
    return { verdict: 'feedback', feedback };
  }

  return { verdict: 'pending' };
}

// -------------------------------------------------------------- plan gate

interface PlanStep { n: number; what: string; files: string[]; layer: string }

/** The plan artifact, read as the fields this renderer actually wants — same shape as `sField`/`aField` in codephases.ts. */
function planStr(plan: Record<string, unknown> | null, key: string): string | null {
  const v = plan?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function planSteps(plan: Record<string, unknown> | null): PlanStep[] {
  const v = plan?.steps;
  return Array.isArray(v) ? (v as PlanStep[]) : [];
}

function planRisks(plan: Record<string, unknown> | null): string[] {
  const v = plan?.risks;
  return Array.isArray(v) ? v.map(String) : [];
}

function renderPlanForSlack(plan: Record<string, unknown> | null): string {
  if (!plan) return '_(no plan recorded)_';
  const steps = planSteps(plan)
    .map((s) => `${s.n}. *[${s.layer}]* ${s.what}${s.files?.length ? ` — \`${s.files.join('`, `')}\`` : ''}`)
    .join('\n');
  const risks = planRisks(plan).map((r) => `• ${r}`).join('\n');
  return `*Approach*\n${planStr(plan, 'approach') ?? '(not recorded)'}\n\n` +
    `*Steps*\n${steps || '(none recorded)'}\n\n` +
    `*Risks*\n${risks || '(none identified)'}` +
    `${plan?.migrations === true ? '\n\n:warning: includes a database migration' : ''}`;
}

/** Posted to the ticket's Slack thread when the plan gate first arms, or re-arms after feedback. */
export function planApprovalRequestBody(plan: Record<string, unknown> | null, why: string): string {
  return `Oneshot pauses here — ${why}\n\n${renderPlanForSlack(plan)}\n\n` +
    'Reply with the single word *`approved`* to continue to `implement`. Any other reply is ' +
    'treated as feedback and `plan` is re-run with it — there is no limit on how many rounds ' +
    'this can take.';
}

/** The GitLab ticket's record of a plan approved in Slack — audit only, never the decision point. */
export function planApprovedRecordBody(): string {
  return 'Oneshot record: the plan above was approved in this ticket\'s Slack thread — ' +
    'proceeding to `implement`.';
}

// --------------------------------------------------------- testcases gate

function renderCasesForSlack(cases: TestCase[]): string {
  if (!cases.length) return '_(no test cases)_';
  return cases.map((c) => `• *${c.id}* [${c.blast}] ${c.scenario}\n   _expects:_ ${c.expected}`).join('\n');
}

/**
 * Posted to the ticket's Slack thread when the test-case gate first arms, or
 * re-arms after an edge case round.
 *
 * Deliberately carries no verdict: `qa` has not run yet at this point in the
 * pipeline, and inventing a summary for a phase that has not happened would be
 * worse than saying nothing. What is under review here is the LIST — what this
 * run intends to test — not a result.
 */
export function testcasesApprovalRequestBody(cases: TestCase[], why: string): string {
  return `Oneshot pauses here — ${why}\n\n` +
    `*Test cases to be verified* (${cases.length})\n${renderCasesForSlack(cases)}\n\n` +
    'Reply with the single word *`approved`* to continue to `review`. Any other reply is treated ' +
    'as edge case(s) to add to this list — each line becomes a new case, appended to ' +
    '`testcases.json`, and this gate asks again with the updated list. There is no limit on how ' +
    'many rounds this can take. Anything added here is tested by THIS run, before the MR is ' +
    'opened.';
}

/** The GitLab ticket's record of the final, approved test-case list — audit only. */
export function testcasesApprovedRecordBody(cases: TestCase[]): string {
  const lines = cases.map((c) => `- **${c.id}** [${c.blast}] ${c.scenario} — _expects:_ ${c.expected}`);
  return 'Oneshot record: the test-case list below was approved in this ticket\'s Slack thread — ' +
    'proceeding to `review`.\n\n' +
    `**Approved test cases** (${cases.length}):\n${lines.join('\n') || '_(none recorded)_'}`;
}

interface TestcasesArtifact {
  module?: string;
  lv?: string;
  cases?: TestCase[];
  passesEmpty?: string[];
}

/** Every appended edge case gets the same, deliberately unassuming tags — see `appendEdgeCases`. */
const EDGE_CASE_PASS_TAG = 'boundary';
const EDGE_CASE_BLAST: TestCase['blast'] = 'medium';

/**
 * The first free `TC-NN` number.
 *
 * Counting the list is not the same as reading it: a phase-4 list that skips
 * or renumbers an id at all — three cases numbered TC-01, TC-02, TC-04 —
 * makes `cases.length + 1` collide with an id already in the file, and two
 * cases sharing an id is a qa result that cannot be attributed to either.
 * Take the highest number actually present instead.
 */
function nextCaseNumber(cases: TestCase[]): number {
  const highest = cases.reduce((max, c) => {
    const m = /^TC-(\d+)$/.exec(c.id ?? '');
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return Math.max(highest, cases.length) + 1;
}

/**
 * Turn a qa-gate reply into one or more new `TestCase` entries and append
 * them to this run's `testcases.json` — the test-case gate's "anything but
 * `approved` is an edge case" rule, applied mechanically (this file never
 * runs a model).
 *
 * One case per non-empty line: that is the only structure a plain chat reply
 * reliably carries, since a reviewer listing three edge cases types them as
 * three lines, not as JSON. `pass` and `blast` are not something free text
 * safely implies, so every appended case is tagged uniformly rather than
 * guessed — close enough to be found and re-run later without asserting a
 * category nobody actually stated.
 *
 * This IS "whatever rendered document represents" the test cases: nothing
 * else stores them. `publish.ts`'s CSV is rendered from this same JSON on
 * demand, never cached separately, so a testcases.json kept current is a CSV
 * kept current the next time anything publishes it.
 *
 * Returns the updated case list (for the next round's request body), or null
 * if this run has no testcases.json to append to.
 */
export function appendEdgeCases(iid: number, feedback: string): TestCase[] | null {
  const data = readArtifact<TestcasesArtifact>(iid, 'testcases.json');
  if (!data) return null;

  const cases = data.cases ?? [];
  const lines = feedback.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = nextCaseNumber(cases);
  const added: TestCase[] = lines.map((line, idx) => {
    const n = first + idx;
    return {
      id: `TC-${String(n).padStart(2, '0')}`,
      scenario: /^verify that/i.test(line) ? line : `Verify that ${line}`,
      precondition: '',
      steps: [line],
      expected: `Matches the QA-reported edge case: ${line}`,
      pass: [EDGE_CASE_PASS_TAG],
      blast: EDGE_CASE_BLAST,
    };
  });

  const updated = [...cases, ...added];
  writeArtifact(iid, 'testcases.json', { ...data, cases: updated });
  return updated;
}
