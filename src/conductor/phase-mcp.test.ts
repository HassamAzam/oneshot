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
