/**
 * Which MCP servers a session starts with. Every Loop phase keeps the GitLab
 * server exactly as before; a caller that opts out (the automation phase, whose
 * ticket and diff the conductor reads and hands over in the prompt) starts with
 * none, so a server that comes up without its tools cannot leave it with
 * nothing to read.
 */
import '../lib/test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMcpServers } from './phase.js';

// Set rather than inherited: with no token the server is never configured at all.
process.env.GITLAB_TOKEN = 'test-token';

test('a session gets the GitLab MCP server unless the caller opts out', () => {
  const loop = sessionMcpServers({}) as { gitlab?: { type: string; env: Record<string, string> } };
  assert.equal(loop.gitlab?.type, 'stdio');
  assert.equal(loop.gitlab?.env.GITLAB_PERSONAL_ACCESS_TOKEN, 'test-token');
  assert.deepEqual(Object.keys(sessionMcpServers({ gitlabMcp: true })), ['gitlab']);
  assert.deepEqual(sessionMcpServers({ gitlabMcp: false }), {});
});
