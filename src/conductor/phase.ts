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
  rateLimited: boolean;
}

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

  const readOnly = !(cfg.writes ?? []).includes('worktree');
  if (readOnly) disallowed.push('Write', 'Edit', 'NotebookEdit');

  const mayTouchGitlab = cfg.name === 'mr' || cfg.name === 'document';
  if (!mayTouchGitlab) {
    disallowed.push(
      'mcp__gitlab__create_merge_request',
      'mcp__gitlab__update_merge_request',
      'mcp__gitlab__update_issue',
      'mcp__gitlab__create_issue',
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
      env: {
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
    ...phaseEnv(identity, { worktree: input.worktree, writeScopes: scopes, port: input.port }),
  };

  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), cfg.timeoutMin * 60_000);

  const out: PhaseOutput = {
    ok: false, data: null, blocked: null, summary: '',
    turns: 0, weighted: 0, sessionId: '', rateLimited: false,
  };
  // Bounded: only frames that could name a subscription limit.
  const limitSignals: string[] = [];

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

    for await (const msg of q) {
      try {
        appendFileSync(tee, `${JSON.stringify(msg)}\n`);
      } catch { /* the tee is best-effort; never fail a phase over logging */ }

      if (msg.type === 'result') {
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
    out.error = ac.signal.aborted
      ? (out.turns === 0
        ? `timed out after ${cfg.timeoutMin}m at ZERO turns — the session never started. `
          + 'Almost always a wedged MCP server spawn: run `npm run deps:verify`.'
        : `timed out after ${cfg.timeoutMin}m`)
      : m;
    limitSignals.push(m);
  } finally {
    clearTimeout(killer);
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
