/**
 * Prove an MCP stdio server serves tools a session will actually be given.
 *
 * Shared by `npm run deps:verify` and the conductor's boot, because the failure
 * it exists for is invisible everywhere else: the SDK reports the server
 * `connected`, the session starts normally, and it simply holds none of the
 * server's tools.
 *
 * "Lists some tools" is not the bar, and for a while it was the bar. The Claude
 * CLI validates the WHOLE `tools/list` answer against one schema, and a single
 * tool that fails it discards the list. On the server every tool failed it:
 * package-lock.json had moved the hoisted `zod` to 4.x, `@zereight/mcp-gitlab`
 * converts its zod schemas with `zod-to-json-schema` 3.x, and that pair emits
 * `inputSchema: {}` for every tool. The old probe counted 69 tools and passed;
 * 42 sessions on #9174 logged `Failed to fetch tools … expected "object"` and
 * ran with no GitLab tool at all, the `mr` phase among them. So the verdict
 * here is the CLI's own: every tool acceptable, or none are usable.
 */
import { spawn } from 'node:child_process';

/** One `tools/list` entry, as far as this module reads it. */
interface ListedTool {
  name?: unknown;
  inputSchema?: { type?: unknown } | null;
}

export interface ToolListVerdict {
  /** True only when the list is non-empty and every tool would be accepted. */
  ok: boolean;
  listed: number;
  /** Names of the tools a session would be refused, first few only. */
  rejected: string[];
  /** One line a person can act on. */
  detail: string;
}

/**
 * What a Claude session makes of one `tools/list` answer.
 *
 * The CLI requires `inputSchema.type === "object"` on every tool (MCP's own
 * schema says the same), and rejects the list as a whole otherwise. Pure, so the
 * all-or-nothing rule is pinned by a test rather than rediscovered from a
 * session that came up empty-handed.
 */
export function toolListVerdict(tools: unknown): ToolListVerdict {
  const list = Array.isArray(tools) ? tools as ListedTool[] : [];
  if (list.length === 0) {
    return {
      ok: false, listed: 0, rejected: [],
      detail: 'the server listed no tools — a session would see it as connected and hold none of its tools',
    };
  }
  const bad = list.filter((t) => !t || typeof t !== 'object'
    || !t.inputSchema || typeof t.inputSchema !== 'object' || t.inputSchema.type !== 'object');
  if (bad.length === 0) return { ok: true, listed: list.length, rejected: [], detail: `${list.length} tools` };
  const rejected = bad.slice(0, 5).map((t) => String((t as ListedTool | null)?.name ?? '?'));
  return {
    ok: false, listed: list.length, rejected,
    detail: `${bad.length} of ${list.length} tools carry no \`inputSchema.type: "object"\` `
      + `(${rejected.join(', ')}${bad.length > rejected.length ? ', …' : ''}). The Claude CLI rejects the `
      + 'whole list over one such tool, so a session gets NONE of them. With every tool affected this is '
      + 'the zod 4 / zod-to-json-schema 3 mismatch: `npm ls zod` must show 3.x at the top level — '
      + 'run `npm ci` against the committed package-lock.json',
  };
}

export interface ProbeResult extends ToolListVerdict {
  /** Milliseconds from spawn to the tools/list answer; null when none arrived. */
  tookMs: number | null;
}

/**
 * Spawn an MCP stdio server the way a PHASE spawns it, and make it prove
 * itself by listing tools a session would accept.
 *
 * The env is passed WHOLE rather than merged over process.env, because that is
 * the SDK's semantics and the merge is what once made this check lie: a server
 * missing PATH dies with `env: node: No such file or directory` inside a phase
 * while passing here.
 *
 * It answers as soon as `tools/list` does and waits up to `ms` for it. The
 * window is generous on purpose: on the server, the first spawn after a boot
 * read its modules from a cold disk and took over thirty seconds to answer, and
 * a six-second window called a healthy server dead.
 */
export function probeStdioServer(
  cmd: string, args: string[], env: Record<string, string>, ms = 45_000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let stderr = '';
    let buffer = '';
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(r);
    };
    const failed = (detail: string): ProbeResult => ({ ok: false, listed: 0, rejected: [], detail, tookMs: null });

    const timer = setTimeout(() => {
      done(failed(`no tools/list answer within ${Math.round(ms / 1000)}s — a session would see the server `
        + `as connected and hold none of its tools. ${stderr.trim().slice(0, 160)}`));
    }, ms);

    child.stdout?.on('data', (d) => {
      buffer += String(d);
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as { id?: number; result?: { tools?: unknown }; error?: { message?: string } };
          if (m.id !== 2) continue;
          if (m.error) done(failed(`tools/list was refused: ${String(m.error.message ?? 'no message').slice(0, 160)}`));
          else done({ ...toolListVerdict(m.result?.tools), tookMs: Date.now() - startedAt });
        } catch { /* a non-JSON line on stdout is the server's own noise */ }
      }
    });
    child.stderr?.on('data', (d) => { if (stderr.length < 2000) stderr += String(d); });
    child.on('error', (err) => done(failed(`spawn failed: ${err.message}`)));
    // A server that dies before reading its stdin turns the writes below into an
    // EPIPE, raised as an 'error' EVENT on the stream — not thrown from write().
    // Unheard, it is an uncaught exception, and this runs inside the conductor.
    child.stdin?.on('error', () => { /* the exit handler reports */ });
    child.on('exit', (code) => done(failed(`exited early (code ${code}) ${stderr.trim().slice(0, 160)}`)));

    const send = (o: unknown): void => {
      try { child.stdin?.write(`${JSON.stringify(o)}\n`); } catch { /* the exit handler reports */ }
    };
    // Written up front and read whenever the server is ready: stdin buffers, so
    // nothing here has to guess how long startup takes.
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'oneshot-probe', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}
