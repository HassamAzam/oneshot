/**
 * Which MCP servers a session starts with. Every Loop phase keeps the GitLab
 * server exactly as before; a caller that opts out (the local-tests scope
 * session, whose ticket the conductor reads and hands over in the prompt)
 * starts with none, so it holds no GitLab write a prompt could talk it into.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMcpServers } from './phase.js';

// Set rather than inherited: with no token the server is never configured at all.
// The empty string, never `delete`: config.js runs dotenv at load, which fills in
// any key that is missing, and envOr reads '' as unset.
process.env.GITLAB_TOKEN = 'test-token';
process.env.ONESHOT_GITLAB_TOKEN = '';

test('a session gets the GitLab MCP server unless the caller opts out', () => {
  const loop = sessionMcpServers({}) as { gitlab?: { type: string; env: Record<string, string> } };
  assert.equal(loop.gitlab?.type, 'stdio');
  assert.equal(loop.gitlab?.env.GITLAB_PERSONAL_ACCESS_TOKEN, 'test-token');
  assert.deepEqual(Object.keys(sessionMcpServers({ gitlabMcp: true })), ['gitlab']);
  assert.deepEqual(sessionMcpServers({ gitlabMcp: false }), {});
});

test('where the desk names its own token, a session\'s GitLab tools act as that account', () => {
  // The server runs as a bot through ONESHOT_GITLAB_TOKEN. src/lib/token.ts already
  // prefers it for the conductor's own calls; a session reading GITLAB_TOKEN instead
  // could post as a different account than the conductor merges as.
  process.env.ONESHOT_GITLAB_TOKEN = 'bot-token';
  try {
    const loop = sessionMcpServers({}) as { gitlab?: { env: Record<string, string> } };
    assert.equal(loop.gitlab?.env.GITLAB_PERSONAL_ACCESS_TOKEN, 'bot-token');
  } finally {
    process.env.ONESHOT_GITLAB_TOKEN = '';
  }
});

// ---------------------------------------------------------------- tool policy
//
// The GitLab server lists every tool it has to every session, and the policy is
// a list of names to take away. A name it does not know is a tool the session
// keeps. Until the tools/list fix no session on the server held ANY of them, so
// the gap had never been open there: twelve writes — labels, pipelines, issue
// links, delete_issue — were on nobody's list.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolPolicy } from './phase.js';
import { DRY_RUN, ROOT, phaseByName } from '../lib/config.js';

const SERVER_BUILD = join(ROOT, 'node_modules', '@zereight', 'mcp-gitlab', 'build', 'index.js');
const WRITES = /^(create|update|delete|retry|cancel|fork|push|merge|upload|publish|bulk_publish|edit|play|approve|unapprove|resolve|protect|unprotect)_/;

/** Every tool name the installed server defines that changes something on GitLab. */
function serverWrites(): string[] {
  const src = readFileSync(SERVER_BUILD, 'utf8');
  return [...new Set([...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]!))].filter((n) => WRITES.test(n));
}

test('a session that is not `mr` is left with no GitLab tool that writes', (t) => {
  if (!existsSync(SERVER_BUILD)) { t.skip('the GitLab MCP server is not installed here'); return; }
  const writes = serverWrites();
  assert.ok(writes.length > 20, `expected to find the server's write tools, found ${writes.length}`);
  for (const phase of ['review', 'review-fix', 'implement', 'verify', 'ui-evidence']) {
    const cfg = phaseByName(phase);
    assert.ok(cfg, `${phase} is a configured phase`);
    const denied = new Set(toolPolicy(cfg).disallowedTools);
    const open = writes.filter((n) => !denied.has(`mcp__gitlab__${n}`));
    assert.deepEqual(open, [], `${phase} can still call: ${open.join(', ')}`);
  }
});

test('no session can write a local file through the GitLab server, or open and resolve threads', () => {
  // download_attachment is not a GitLab write, so the test above cannot see it:
  // it writes a file on this machine where no hook looks. And threads on the
  // merge request belong to the review loop and to people.
  for (const phase of ['review', 'review-fix', 'verify', 'mr']) {
    const denied = new Set(toolPolicy(phaseByName(phase)!).disallowedTools);
    for (const tool of ['download_attachment', 'create_merge_request_thread', 'create_merge_request_note',
      'update_merge_request_note', 'publish_draft_note']) {
      assert.ok(denied.has(`mcp__gitlab__${tool}`), `${phase} must not hold ${tool}`);
    }
  }
});

test('`mr` keeps the writes it is for, and only those', (t) => {
  if (!existsSync(SERVER_BUILD)) { t.skip('the GitLab MCP server is not installed here'); return; }
  // A dry run takes more away from every phase; this pins the real policy.
  if (DRY_RUN) { t.skip('DRY_RUN is set on this desk'); return; }
  const denied = new Set(toolPolicy(phaseByName('mr')!).disallowedTools);
  const open = serverWrites().filter((n) => !denied.has(`mcp__gitlab__${n}`)).sort();
  // Spelled out on purpose: a server upgrade that adds a write tool fails here,
  // and someone decides whether `mr` should hold it before any session does.
  assert.deepEqual(open, [
    'create_branch', 'create_issue', 'create_issue_note', 'create_merge_request', 'create_note',
    'create_or_update_file', 'push_files', 'update_issue', 'update_issue_note', 'update_merge_request',
    'upload_markdown',
  ]);
  for (const never of ['delete_label', 'update_label', 'create_pipeline', 'delete_issue', 'merge_merge_request']) {
    assert.ok(denied.has(`mcp__gitlab__${never}`), `mr must not hold ${never}`);
  }
});
