import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDisjoint, isPortListening, listenerPid, listeners, parsePortList, parseSs, pidCwd, pidsOnPort, portsListening,
} from './procprobe.cjs';

/** A PATH holding only the named fake tools (plus `sh`, which the fakes need). */
function fakeBin(tools: Record<string, string>): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'procprobe-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync('/bin/sh', join(bin, 'sh'));
  for (const [name, body] of Object.entries(tools)) {
    const f = join(bin, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
  }
  return { env: { ...process.env, PATH: bin } as Record<string, string>, dir };
}

const listen = (): Promise<{ server: Server; port: number }> => new Promise((res) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const addr = server.address();
    res({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
  });
});

const SS_OUT = [
  'LISTEN 0      4096       127.0.0.1:8100       0.0.0.0:*    users:(("python",pid=4242,fd=5))',
  'LISTEN 0      511                *:9100             *:*    users:(("node",pid=4343,fd=21),("node",pid=4343,fd=22))',
  'LISTEN 0      128            [::1]:5432          [::]:*',
].join('\n');

test('ss output: ports, pids, and a socket whose owner is invisible', () => {
  assert.deepEqual(parseSs(SS_OUT), [{ pid: 4242, port: 8100 }, { pid: 4343, port: 9100 }, { pid: null, port: 5432 }]);
});

test('no lsof on PATH: listeners and pids come from ss', () => {
  const { env, dir } = fakeBin({ ss: `printf '%s\\n' ${SS_OUT.split('\n').map((l) => `'${l}'`).join(' ')}` });
  try {
    assert.deepEqual(listeners({ env }), [{ pid: 4242, port: 8100 }, { pid: 4343, port: 9100 }, { pid: null, port: 5432 }]);
    assert.deepEqual(pidsOnPort(8100, { env }), [4242]);
    assert.deepEqual(pidsOnPort(9100, { env }), [4343]);
    assert.deepEqual(pidsOnPort(5432, { env }), [], 'listening, owner invisible: no pid, not a guess');
    assert.equal(listenerPid(8101, { env }), null);
    assert.equal(isPortListening(5432, { env }), true, 'ss saw the socket even without its pid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('neither lsof nor ss: pid questions throw E_NO_PROBE instead of answering "free"', () => {
  const { env, dir } = fakeBin({});
  try {
    assert.throws(() => listeners({ env }), (e: { code?: string }) => e.code === 'E_NO_PROBE');
    assert.throws(() => pidsOnPort(8100, { env }), (e: { code?: string }) => e.code === 'E_NO_PROBE');
    assert.throws(() => pidCwd(process.pid, { env, procRoot: null }), (e: { code?: string }) => e.code === 'E_NO_PROBE');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('neither lsof nor ss: whether a port listens still has an answer, from a TCP connect', async () => {
  const { env, dir } = fakeBin({});
  const { server, port } = await listen();
  try {
    assert.equal(isPortListening(port, { env }), true);
    assert.deepEqual([...portsListening([port], { env })], [port]);
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(isPortListening(port, { env }), false);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('lsof present but empty: a connect still catches a listener lsof could not see', async () => {
  const { env, dir } = fakeBin({ lsof: 'exit 1' });
  const { server, port } = await listen();
  try {
    assert.equal(isPortListening(port, { env }), true);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pidCwd reads /proc/<pid>/cwd when there is a /proc', () => {
  const root = mkdtempSync(join(tmpdir(), 'procprobe-proc-'));
  try {
    mkdirSync(join(root, 'self'));
    mkdirSync(join(root, '77'));
    symlinkSync('/srv/wt/t1-r-x-abc', join(root, '77', 'cwd'));
    assert.equal(pidCwd(77, { procRoot: root, env: { PATH: '' } }), '/srv/wt/t1-r-x-abc');
    assert.equal(pidCwd(78, { procRoot: root, env: { PATH: '' } }), null, 'a gone pid is null, not an error');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the real probes find this process on a port it listens on', async () => {
  const { server, port } = await listen();
  try {
    assert.equal(isPortListening(port), true);
    assert.equal(listenerPid(port), process.pid);
    assert.equal(pidCwd(process.pid), process.cwd());
  } finally { server.close(); }
});

test('port lists: commas, ranges, both; anything malformed or repeated is refused', () => {
  assert.deepEqual(parsePortList('8000,8001,8002'), [8000, 8001, 8002]);
  assert.deepEqual(parsePortList('8100-8109'), [8100, 8101, 8102, 8103, 8104, 8105, 8106, 8107, 8108, 8109]);
  assert.deepEqual(parsePortList(' 8100 - 8101 , 8200 '), [8100, 8101, 8200]);
  assert.deepEqual(parsePortList(''), []);
  assert.throws(() => parsePortList('8100-8099'), /not a valid ascending port range/);
  assert.throws(() => parsePortList('80a0'), /is not a port or a range/);
  assert.throws(() => parsePortList('70000'), /not a valid/);
  assert.throws(() => parsePortList('8100-8102,8101', 'PORT_POOL'), /PORT_POOL: port 8101 is listed twice/);
});

test('pools that share a port are refused, naming both', () => {
  assert.doesNotThrow(() => assertDisjoint([{ name: 'a', ports: [1, 2] }, { name: 'b', ports: [3] }]));
  assert.throws(() => assertDisjoint([{ name: 'a', ports: [1, 2] }, { name: 'b', ports: [2] }]), /port 2 is in both a and b/);
});
