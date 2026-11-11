/**
 * A tool list a session would discard is not a working MCP server.
 *
 * The Claude CLI validates the whole `tools/list` answer at once, so one tool
 * without `inputSchema.type: "object"` costs a session every tool. On the server
 * a zod 4 / zod-to-json-schema 3 mismatch gave all 69 GitLab tools an empty
 * `inputSchema`; the dependency probe counted 69 and passed, and #9174's `mr`
 * phase found itself with no GitLab tools. These pin the verdict to the CLI's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeStdioServer, toolListVerdict } from './mcpprobe.js';

const good = (name: string): unknown => ({ name, inputSchema: { type: 'object', properties: {} } });

test('every tool carrying an object input schema is a usable list', () => {
  const v = toolListVerdict([good('get_issue'), good('update_merge_request')]);
  assert.equal(v.ok, true);
  assert.equal(v.listed, 2);
  assert.deepEqual(v.rejected, []);
});

test('an empty list is not usable, because a session then holds no tools', () => {
  assert.equal(toolListVerdict([]).ok, false);
  assert.equal(toolListVerdict(undefined).ok, false);
});

test('one tool the CLI would reject makes the whole list unusable', () => {
  const v = toolListVerdict([good('get_issue'), { name: 'push_files', inputSchema: {} }]);
  assert.equal(v.ok, false);
  assert.equal(v.listed, 2);
  assert.deepEqual(v.rejected, ['push_files']);
  assert.match(v.detail, /1 of 2 tools/);
  assert.match(v.detail, /NONE of them/);
});

test('the server\'s actual failure — every schema empty — names the dependency to fix', () => {
  const v = toolListVerdict(Array.from({ length: 69 }, (_, i) => ({ name: `t${i}`, inputSchema: {} })));
  assert.equal(v.ok, false);
  assert.equal(v.rejected.length, 5); // the first few are enough to act on
  assert.match(v.detail, /69 of 69 tools/);
  assert.match(v.detail, /npm ls zod/);
});

test('a missing or non-object schema is rejected the same way', () => {
  for (const tool of [{ name: 'a' }, { name: 'b', inputSchema: null }, { name: 'c', inputSchema: { type: 'string' } }, null]) {
    assert.equal(toolListVerdict([tool]).ok, false);
  }
});

/** A stdio MCP server small enough to read: answers initialize, then tools/list with `tools`. */
function fakeServer(tools: string, delayMs = 0): string[] {
  return ['-e', `
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {} } } }) + '\\n');
        if (m.id === 2) setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: ${tools} } }) + '\\n'), ${delayMs});
      }
    });
  `];
}
const ENV = { PATH: process.env.PATH ?? '' };

test('a server that lists acceptable tools passes, as soon as it answers', async () => {
  const r = await probeStdioServer(process.execPath, fakeServer('[{"name":"x","inputSchema":{"type":"object"}}]'), ENV, 20_000);
  assert.equal(r.ok, true);
  assert.equal(r.listed, 1);
  assert.equal(typeof r.tookMs, 'number');
});

test('a server whose tools a session would discard fails the probe it used to pass', async () => {
  const r = await probeStdioServer(process.execPath, fakeServer('[{"name":"x","inputSchema":{}},{"name":"y","inputSchema":{}}]'), ENV, 20_000);
  assert.equal(r.ok, false);
  assert.equal(r.listed, 2);
  assert.deepEqual(r.rejected, ['x', 'y']);
});

test('a slow start is waited for rather than called dead', async () => {
  // The first spawn after a boot took over thirty seconds on the server; the
  // six-second window this replaces reported a healthy server as serving nothing.
  const r = await probeStdioServer(process.execPath, fakeServer('[{"name":"x","inputSchema":{"type":"object"}}]', 1500), ENV, 20_000);
  assert.equal(r.ok, true);
  assert.ok((r.tookMs ?? 0) >= 1400);
});

test('a server that never answers is a failure within the window, not a hang', async () => {
  const r = await probeStdioServer(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], ENV, 600);
  assert.equal(r.ok, false);
  assert.match(r.detail, /no tools\/list answer/);
});

test('a command that exits at once says so', async () => {
  const r = await probeStdioServer(process.execPath, ['-e', 'process.exit(3)'], ENV, 5_000);
  assert.equal(r.ok, false);
  assert.match(r.detail, /exited early \(code 3\)/);
});
