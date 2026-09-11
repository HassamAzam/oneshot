/**
 * Run ONE phase: one fresh Agent SDK session, never resumed, never continued.
 *
 * That is the context discipline the whole design rests on. A phase receives
 * the ticket, the prior-art brief and the ARTIFACTS of earlier phases — never
 * their transcripts — so "clear the context between tickets" needs no
 * mechanism: there is no conversation to clear.
 *
 * Structured output is enforced by the SDK (`outputFormat: json_schema`), not
 * requested in a prompt. A phase physically cannot end with prose where the
 * next phase expects a field.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_ENV, DRY_RUN, ROOT, artifactDir, envOr, modelFor, runDir,
  type PhaseConfig,
} from '../lib/config.js';
import { MEMORY } from '../lib/config.js';
import { otelBaseEnv, otelSpawnEnv } from '../lib/otel.js';
import { phaseEnv, type PhaseIdentity } from '../lib/ids.js';
import { recordUsage, looksLikeUsageLimit, parkForQuota } from '../lib/quota.js';
import { transcriptPath, writeArtifact } from '../lib/artifacts.js';
import { logEvent } from '../lib/db.js';
import { log } from '../lib/log.js';
import { schemaFor } from './schemas.js';
import { hooksFor } from './hooks.js';

export interface PhaseInput {
  iid: number;
  runId: string;
  lap: number;
  cfg: PhaseConfig;
  prompt: string;
  systemPrompt: string;
  worktree?: string;
  port?: number;
  /**
   * The run's leased branch. Reaches the session as ONESHOT_BRANCH, which is
   * what arms git-guard's "push to this ref and nothing else" rule — the rule
   * is inert while the variable is unset.
   */
  branch?: string;
  /**
   * External cancellation. Phases in a parallel group share one signal, so a
   * group that has already lost control flow can stop paying for the siblings
   * still running beside it.
   */
  signal?: AbortSignal;
}

export interface PhaseOutput {
  ok: boolean;
  /** Schema-validated structured result, or null if the session never produced one. */
  data: Record<string, unknown> | null;
  blocked: string | null;
  summary: string;
  turns: number;
  weighted: number;
  sessionId: string;
  error?: string;
  /**
   * The failure was the machinery, not the work: cancelled, killed by a
   * signal, or out of wall clock. The runner re-attempts these in place
   * instead of spending a cycle lap on them. See PhaseRecord['status'].
   */
  infra?: boolean;
  rateLimited: boolean;
}

/** A session killed by a signal — never a verdict about the work. */
const SIGNAL_DEATH_RE = /terminated by signal|SIGKILL|SIGTERM|SIGSEGV/i;

/**
 * How often a long phase says it is still alive.
 *
 * A session phase is otherwise silent for up to its whole timeout — two hours
 * for `verify` — which leaves no way to tell "working" from "wedged" without
 * reading the raw transcript. One line a minute is enough to answer that at a
 * glance and far too little to drown the console.
 */
const PROGRESS_EVERY_MS = 60_000;

/** Write scopes handed to hooks/write-scope.cjs. Anything outside is denied. */
function writeScopes(cfg: PhaseConfig, iid: number, worktree?: string): string[] {
  const scopes: string[] = [];
  for (const w of cfg.writes ?? []) {
    if (w === 'run') scopes.push(runDir(iid));
    else if (w === 'artifacts') scopes.push(artifactDir(iid));
    else if (w === 'memory') scopes.push(MEMORY);
    else if (w === 'worktree' && worktree) scopes.push(worktree);
  }
  return scopes;
}

/**
 * Tool policy.
 *
 * Structure before hooks: a phase that must not mutate GitLab simply does not
 * receive the mutation tools, so no guard has to intercept a call that cannot
 * be made. DRY_RUN removes every write tool from every phase.
 *
 * "Read-only" means the phase declares NO write scopes — not that it lacks a
 * worktree. Phases whose only output is a file under the run, artifacts or
 * memory directory (ui-evidence, memorize, deploy, demo, qa) still need Write,
 * and keying the test to the worktree scope left them one way out: a Bash
 * heredoc, the single write path write-scope.cjs cannot see. The declared
 * scopes decide WHERE a phase may write; this decides WHETHER it may at all.
 *
 * The GitLab denial list is wide deliberately. A phase kept away from
 * create_merge_request but handed create_issue_note can still publish to a
 * customer's ticket, and push_files / create_or_update_file / create_branch
 * commit through the API — around both write-scope.cjs and git-guard.cjs.
 */
function toolPolicy(cfg: PhaseConfig): { disallowedTools: string[] } {
  const disallowed: string[] = [
    'mcp__gitlab__merge_merge_request',
    'mcp__gitlab__delete_branch',
    'mcp__gitlab__protect_branch',
    'mcp__gitlab__unprotect_branch',
    'mcp__gitlab__update_project',
    'mcp__gitlab__update_default_branch',
  ];

  const readOnly = (cfg.writes ?? []).length === 0;
  if (readOnly) disallowed.push('Write', 'Edit', 'NotebookEdit');

  const mayTouchGitlab = cfg.name === 'mr' || cfg.name === 'document';
  if (!mayTouchGitlab) {
    disallowed.push(
      'mcp__gitlab__create_merge_request',
      'mcp__gitlab__update_merge_request',
      'mcp__gitlab__update_issue',
      'mcp__gitlab__create_issue',
      'mcp__gitlab__create_issue_note',
      'mcp__gitlab__create_merge_request_note',
      'mcp__gitlab__create_merge_request_discussion_note',
      'mcp__gitlab__upload_markdown',
      'mcp__gitlab__push_files',
      'mcp__gitlab__create_or_update_file',
      'mcp__gitlab__create_branch',
    );
  }

  if (DRY_RUN) {
    disallowed.push('Write', 'Edit', 'NotebookEdit');
    disallowed.push(...[
      'create_merge_request', 'update_merge_request', 'create_issue', 'update_issue',
      'create_merge_request_note', 'create_issue_note', 'upload_markdown',
    ].map((t) => `mcp__gitlab__${t}`));
  }

  return { disallowedTools: [...new Set(disallowed)] };
}

/**
 * The GitLab MCP server, resolved to a LOCAL binary.
 *
 * Not `npx -y`: npx re-resolves against the npm registry on every spawn, and
 * this machine's npm traffic is blocked while the FortiClient VPN is up — the
 * same VPN that GitLab itself requires. The result was the worst possible
 * failure shape: the server never started, the session got no tools, and it
 * burned its entire wall-clock timeout at ZERO turns with no error.
 *
 * @zereight/mcp-gitlab is a real dependency now, so the binary is in
 * node_modules and starts offline in milliseconds.
 */
function mcpServers(): Record<string, unknown> {
  const local = join(ROOT, 'node_modules', '.bin', 'mcp-gitlab');
  const cmd = envOr('GITLAB_MCP_CMD', existsSync(local) ? local : 'npx');
  const defaultArgs = cmd === 'npx' ? '-y @zereight/mcp-gitlab' : '';
  const args = envOr('GITLAB_MCP_ARGS', defaultArgs).split(' ').filter(Boolean);
  const token = envOr('GITLAB_TOKEN');
  if (!token) return {};
  return {
    gitlab: {
      type: 'stdio',
      command: cmd,
      args,
      // BASE_ENV first, and it is load-bearing rather than tidy. This block
      // REPLACES the subprocess environment, and `node_modules/.bin/mcp-gitlab`
      // is a shim whose shebang is `#!/usr/bin/env node` — so with only the
      // GitLab variables here there is no PATH, `env` cannot find node, and the
      // server dies instantly with exit 127. The SDK still reports the server
      // as `connected`, and the session simply gets no mcp__gitlab__* tools at
      // all: the `mr` phase pushes its branch, finds nothing to create an MR
      // with, and blocks. Same family as the npx failure this file already
      // documents — a dependency that is configured is not a dependency that
      // runs. `npm run deps:verify` spawns it with a real environment, which is
      // why it passed while every phase went without.
      env: {
        ...BASE_ENV,
        GITLAB_PERSONAL_ACCESS_TOKEN: token,
        GITLAB_API_URL: envOr('ONESHOT_GITLAB_API', 'https://gitlab.arbisoft.com/api/v4'),
        USE_PIPELINE: 'true',
        USE_GITLAB_WIKI: 'false',
        USE_MILESTONE: 'false',
      },
    },
  };
}

export async function runPhase(input: PhaseInput): Promise<PhaseOutput> {
  const { cfg, iid, runId, lap } = input;
  const model = modelFor(cfg);
  const identity: PhaseIdentity = {
    runId, ticket: iid, phase: cfg.name, lap, tier: cfg.tier ?? 'standard', model,
  };

  const cwd = cfg.cwd === 'worktree' && input.worktree ? input.worktree : ROOT;
  const scopes = writeScopes(cfg, iid, input.worktree);
  const tee = transcriptPath(iid, cfg.name, lap);

  const env: Record<string, string> = {
    ...BASE_ENV,
    ...otelBaseEnv(),
    ...otelSpawnEnv(identity),
    ...phaseEnv(identity, {
      worktree: input.worktree, writeScopes: scopes, port: input.port, branch: input.branch,
    }),
    // The guards read the flag from the environment rather than trusting the
    // tool policy alone: DRY_RUN takes the write tools away, but Bash remains,
    // and `git push` is a mutation the tool list cannot describe.
    ...(DRY_RUN ? { ONESHOT_DRY_RUN: '1' } : {}),
    // Playwright lives in THIS repo's node_modules. Worktree phases resolve
    // node modules through a symlink into the seed repo, which does not carry
    // it, and conductor phases run at ROOT where a bare `node -e` still needs
    // the path. NODE_PATH is Node's documented fallback for exactly this.
    NODE_PATH: join(ROOT, 'node_modules'),
  };

  // Two ways a phase ends early, and they are not the same failure. The timer
  // is this phase overrunning its own budget; the caller's signal is the
  // conductor withdrawing the phase for reasons that have nothing to do with
  // what the session was doing. Reporting the second as a timeout would send
  // whoever reads the journal after the wrong thing entirely.
  const ac = new AbortController();
  let timedOut = false;
  // A wedged session ignores ac.abort(): if the CLI stops yielding stream
  // frames (a hung MCP call, a child that never returns), the consume loop
  // below never advances and the phase promise never settles — so the
  // conductor deadlocks forever awaiting a phase that cannot die (observed
  // live: run #18 verify sat wedged 4h past its own 120m timeout). After ANY
  // abort we therefore arm a short grace timer that force-settles the phase
  // even when the stream refuses to unwind. The abandoned subprocess is reaped
  // separately; the invariant this restores is that the conductor always gets
  // its phase back, on the deadline, no matter what the CLI is stuck on.
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let forceSettle: (err: Error) => void = () => {};
  const hardDeadline = new Promise<never>((_, reject) => { forceSettle = reject; });
  const armForce = (): void => {
    if (!forceTimer) {
      forceTimer = setTimeout(() => forceSettle(new Error('the session did not unwind within the abort grace window')), 30_000);
    }
  };
  const killer = setTimeout(() => { timedOut = true; ac.abort(); armForce(); }, cfg.timeoutMin * 60_000);
  const cancel = (): void => { ac.abort(); armForce(); };
  if (input.signal) {
    if (input.signal.aborted) { ac.abort(); armForce(); }
    else input.signal.addEventListener('abort', cancel, { once: true });
  }

  const out: PhaseOutput = {
    ok: false, data: null, blocked: null, summary: '',
    turns: 0, weighted: 0, sessionId: '', rateLimited: false,
  };
  // Bounded: only frames that could name a subscription limit.
  const limitSignals: string[] = [];
  /** Stream messages seen — the only honest way to tell a wedged spawn from a slow phase. */
  let sawActivity = 0;
  let settled = false;
  let turnsSoFar = 0;
  const phaseStartedAt = Date.now();
  let lastProgressAt = phaseStartedAt;

  try {
    const schema = schemaFor(cfg.name);
    const q = query({
      prompt: input.prompt,
      options: {
        model,
        maxTurns: cfg.maxTurns ?? 40,
        cwd,
        // Coding phases get the full Claude Code harness on top of ours; the
        // rest get a plain (cheaper) system prompt.
        systemPrompt: cfg.coding
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: input.systemPrompt }
          : input.systemPrompt,
        // 'project' ONLY — it loads CLAUDE.md and the symlinked .claude/skills
        // in the worktree, which is all a phase needs. 'user' is deliberately
        // absent: it drags in the operator's whole personal config, and on this
        // machine that includes a `npx ccusage` statusLine that hangs behind the
        // VPN and wedged every phase before its first turn. Guards come from the
        // `hooks` option below instead, so they travel with the repo.
        settingSources: ['project'],
        hooks: hooksFor(env) as never,
        mcpServers: mcpServers() as never,
        ...toolPolicy(cfg),
        permissionMode: 'bypassPermissions',
        // Required alongside bypassPermissions in SDK 0.1.77. The hook layer,
        // not the permission prompt, is the real gate here.
        allowDangerouslySkipPermissions: true,
        ...(schema ? { outputFormat: { type: 'json_schema' as const, schema } } : {}),
        env,
        abortController: ac,
        stderr: (d: string) => {
          try { appendFileSync(tee, `${JSON.stringify({ type: 'cli-stderr', text: d })}\n`); } catch { /* best effort */ }
        },
      },
    });

    // Manual iteration, not `for await`, so each pull can be raced against the
    // hard deadline: a wedged CLI leaves `next()` pending forever, and only a
    // race lets the phase settle on the timer instead of hanging with it.
    const iterator = q[Symbol.asyncIterator]();
    for (;;) {
      const nextFrame = iterator.next();
      nextFrame.catch(() => { /* swallow if the deadline wins and we abandon it */ });
      const step = await Promise.race([nextFrame, hardDeadline]);
      if (step.done === true) break;
      const msg = step.value;
      sawActivity += 1;
      if (msg.type === 'assistant') turnsSoFar += 1;
      try {
        appendFileSync(tee, `${JSON.stringify(msg)}\n`);
      } catch { /* the tee is best-effort; never fail a phase over logging */ }

      // Heartbeat. `turns` arrives only in the result frame, so a session that
      // is still working reports nothing about itself until it finishes —
      // counting assistant frames is the only turn number available while it
      // matters. Both numbers are shown against their caps because "which
      // budget am I about to run out of" is the actual question being asked.
      const sinceProgress = Date.now() - lastProgressAt;
      if (sinceProgress >= PROGRESS_EVERY_MS) {
        lastProgressAt = Date.now();
        const mins = Math.round((Date.now() - phaseStartedAt) / 60_000);
        log.info(`${cfg.name} working`, {
          turns: `${turnsSoFar}/${cfg.maxTurns ?? '-'}`,
          elapsed: `${mins}m/${cfg.timeoutMin}m`,
          messages: sawActivity,
        });
      }

      if (msg.type === 'result') {
        // The FIRST result frame settles the phase, and only the first.
        //
        // The SDK can emit several. Observed live: a 'success' frame carrying
        // the real turn count and usage, followed by an
        // 'error_during_execution' frame carrying zero turns and no usage.
        // Read as the outcome, the trailing frame turned a passing phase into
        // a failed one, overwrote the recorded spend with zero, and pushed its
        // own error text into limitSignals — where one rate-limit-shaped
        // string parks the entire conductor via parkForQuota on an account
        // that was never limited. Later frames stay in the tee and in the log,
        // and touch nothing that decides anything.
        if (settled) {
          log.warn(`${cfg.name}: extra result frame ignored`, { subtype: msg.subtype });
          continue;
        }
        settled = true;

        out.turns = msg.num_turns;
        out.sessionId = msg.session_id;

        const u = msg.usage as Record<string, number> | undefined;
        if (u) {
          out.weighted = recordUsage({
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cache_creation: u.cache_creation_input_tokens ?? 0,
            cache_read: u.cache_read_input_tokens ?? 0,
          }, { runId, phase: cfg.name, model });
        }

        if (msg.subtype === 'success') {
          const structured = msg.structured_output as Record<string, unknown> | undefined;
          if (structured && typeof structured === 'object') {
            out.data = structured;
            out.summary = String(structured.summary ?? '');
            const b = structured.blocked;
            out.blocked = typeof b === 'string' && b.trim() ? b : null;
            out.ok = out.blocked === null;
          } else if (!schema) {
            out.summary = msg.result.slice(0, 400);
            out.ok = true;
          } else {
            out.error = 'session produced no structured output despite a schema';
            limitSignals.push(msg.result ?? '');
          }
        } else {
          out.error = `${msg.subtype}: ${(msg.errors ?? []).join('; ').slice(0, 300)}`;
          limitSignals.push(...(msg.errors ?? []));
        }
      }
    }
  } catch (err) {
    const m = (err as Error).message ?? String(err);
    if (timedOut) {
      // `turns` is only populated by a result frame, so a session killed
      // mid-work reports zero of them however long it actually worked. Read
      // the stream instead: nothing at all means the spawn wedged, whereas
      // assistant traffic means a session that was working and simply never
      // finished. Conflating the two sends whoever reads this at a healthy MCP
      // server while the real answer is a budget that was too small.
      out.error = !sawActivity
        ? `timed out after ${cfg.timeoutMin}m without a single message — the session never `
          + 'started. Almost always a wedged MCP server spawn: run `npm run deps:verify`.'
        : `timed out after ${cfg.timeoutMin}m while still working (${sawActivity} stream `
          + 'messages, no final result). The phase needs a larger budget or less to do; any '
          + 'partial artifact it wrote on the way is the only salvageable evidence.';
      out.infra = true;
      limitSignals.push(m);
    } else if (ac.signal.aborted) {
      // A cancellation the conductor asked for reports nothing about the
      // account, so its text is kept away from the usage-limit detector.
      out.error = 'cancelled by the conductor';
      out.infra = true;
    } else {
      out.error = m;
      // A signal death is the machinery, not a verdict. Note this is matched on
      // the message rather than an exit code on purpose: the SDK reports
      // "exited with code 1" on sessions that SUCCEEDED (see the trailing
      // result frame above), so an exit code proves nothing either way.
      if (SIGNAL_DEATH_RE.test(m)) out.infra = true;
      limitSignals.push(m);
    }
  } finally {
    clearTimeout(killer);
    if (forceTimer) clearTimeout(forceTimer);
    input.signal?.removeEventListener('abort', cancel);
  }

  const signalText = limitSignals.join('\n');
  if (looksLikeUsageLimit(signalText)) {
    parkForQuota(signalText);
    out.rateLimited = true;
    out.ok = false;
  }

  if (out.data) writeArtifact(iid, cfg.artifact ?? `${cfg.name}.json`, out.data);

  logEvent('phase_done', {
    phase: cfg.name, lap, ok: out.ok, turns: out.turns,
    weighted: out.weighted, blocked: out.blocked, error: out.error,
  }, { runId, phase: cfg.name });

  const verdict = out.ok ? 'ok' : (out.blocked ? 'BLOCKED' : 'failed');
  log.phase(`${cfg.name} lap${lap} ${verdict}`, {
    model, turns: out.turns, weighted: out.weighted,
    ...(out.error ? { error: out.error.slice(0, 120) } : {}),
  });

  return out;
}
