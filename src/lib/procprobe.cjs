'use strict';
/**
 * procprobe.cjs — who is listening on a port, and where is a process running from.
 *
 * Three files used to ask these questions with their own `lsof` call and swallow every
 * spawn error: src/lib/worktrees.ts, scripts/app.cjs and the harness. On a machine with
 * no lsof — a minimal Linux server — that made every port read as FREE and every process
 * as cwd-less, so the conductor leased ports something was serving on and app discovery
 * dropped every running instance. A probe that cannot run is not an answer; this module
 * falls back through the methods a box is likely to have and throws E_NO_PROBE when none
 * of them work, rather than reporting "nothing there".
 *
 *   listening / pids   lsof  ->  `ss -ltnpH` (Linux)  ->  a TCP connect (listening only)
 *   cwd of a pid       /proc/<pid>/cwd (Linux)  ->  lsof
 *
 * CommonJS so harness.cjs and app.cjs can require it; the conductor imports it through
 * procprobe.d.cts. Every function takes an optional `opts.env` (PATH is what decides
 * which tools exist) and `opts.procRoot`, which is how the tests fake a box without lsof.
 *
 * Also home to the port-list parser (`8100-8109,8200`), because the conductor, app.cjs
 * and the harness must all read PORT_POOL the same way.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class ProbeError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint || null; }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

const NO_PROBE_HINT = 'install lsof (apt install lsof) or iproute2 (ss); on Linux /proc must be mounted';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: opts.timeout || 10000, env: opts.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missing = Boolean(r.error && r.error.code === 'ENOENT');
  return { missing, error: r.error || null, code: r.status, out: String(r.stdout || '') };
}

/**
 * Every listening TCP socket from `ss -ltnpH`. `pid` is null when ss could see the
 * socket but not its owner (another user's process, without root).
 */
function parseSs(out) {
  const rows = [];
  for (const line of String(out).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const local = f[0] === 'LISTEN' ? f[3] : f[2];
    const port = Number(String(local || '').split(':').pop());
    if (!Number.isInteger(port) || port <= 0) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (pids.length) for (const pid of new Set(pids)) rows.push({ pid, port });
    else rows.push({ pid: null, port });
  }
  return rows;
}

/** Every listening TCP socket from `lsof -nP -iTCP -sTCP:LISTEN`. */
function parseLsof(out) {
  const rows = [];
  for (const line of String(out).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    const name = f[f.length - 2] || '';
    const port = Number((name.split(':').pop() || '').replace(/\D/g, ''));
    const pid = Number(f[1]);
    if (Number.isInteger(pid) && Number.isInteger(port) && port) rows.push({ pid, port });
  }
  return rows;
}

/**
 * Every listening TCP port on this machine with its pid (null when unknown).
 * Throws E_NO_PROBE when neither lsof nor ss can run.
 */
function listeners(opts = {}) {
  const l = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], opts);
  if (!l.missing && !l.error) return parseLsof(l.out);
  const s = run('ss', ['-ltnpH'], opts);
  if (!s.missing && !s.error && s.code === 0) return parseSs(s.out);
  throw new ProbeError('E_NO_PROBE', 'cannot list listening ports: neither lsof nor ss could run', NO_PROBE_HINT);
}

/**
 * The pids listening on `port`; [] when nothing listens OR when the owner is invisible
 * (ss without root). Use isPortListening to ask whether the port is free.
 */
function pidsOnPort(port, opts = {}) {
  const l = run('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], opts);
  if (!l.missing && !l.error) {
    return l.out.trim() ? [...new Set(l.out.trim().split('\n').map(Number).filter(Number.isInteger))] : [];
  }
  const s = run('ss', ['-ltnpH'], opts);
  if (!s.missing && !s.error && s.code === 0) {
    return [...new Set(parseSs(s.out).filter((r) => r.port === Number(port) && r.pid).map((r) => r.pid))];
  }
  throw new ProbeError('E_NO_PROBE', `cannot tell which process listens on port ${port}: neither lsof nor ss could run`, NO_PROBE_HINT);
}

/** First pid on `port`, or null. */
function listenerPid(port, opts = {}) {
  return pidsOnPort(port, opts)[0] || null;
}

const CONNECT_SRC = `
const net = require('net');
const ports = process.argv.slice(1).map(Number);
const open = new Set();
const one = (host, port) => new Promise((res) => {
  const s = net.connect({ host, port });
  const done = (ok) => { if (ok) open.add(port); s.destroy(); res(); };
  s.setTimeout(1500, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});
Promise.all(ports.flatMap((p) => ['127.0.0.1', '::1'].map((h) => one(h, p))))
  .then(() => { process.stdout.write(JSON.stringify([...open])); });`;

/** Synchronous TCP connects to 127.0.0.1 and ::1, all ports in ONE child: the ports that accepted. */
function connectProbeMany(ports) {
  if (!ports.length) return new Set();
  const r = spawnSync(process.execPath, ['-e', CONNECT_SRC, ...ports.map(String)], { encoding: 'utf8', timeout: 10000 });
  try { return new Set(JSON.parse(String(r.stdout || '[]'))); } catch {
    throw new ProbeError('E_NO_PROBE', 'the TCP connect probe did not answer', String(r.stderr || '').slice(0, 200));
  }
}

function connectProbe(port) {
  return connectProbeMany([Number(port)]).has(Number(port));
}

/**
 * Which of `ports` something listens on — one listing plus one connect child for the
 * rest, so a ten-port pool costs two spawns, not forty.
 */
function portsListening(ports, opts = {}) {
  const want = ports.map(Number);
  const found = new Set();
  try {
    for (const l of listeners(opts)) if (want.includes(l.port)) found.add(l.port);
  } catch (err) {
    if (!err || err.code !== 'E_NO_PROBE') throw err;
  }
  for (const p of connectProbeMany(want.filter((p) => !found.has(p)))) found.add(p);
  return found;
}

/**
 * Is anything listening on `port`? lsof, then ss, then a TCP connect. Never fails open:
 * the connect probe always runs, so the only way to get `false` is that nothing answered.
 */
function isPortListening(port, opts = {}) {
  const l = run('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], opts);
  if (!l.missing && !l.error) {
    if (l.out.trim()) return true;
    return connectProbe(port);
  }
  const s = run('ss', ['-ltnpH'], opts);
  if (!s.missing && !s.error && s.code === 0) {
    if (parseSs(s.out).some((r) => r.port === Number(port))) return true;
    return connectProbe(port);
  }
  return connectProbe(port);
}

/**
 * The working directory of `pid`, or null when the process is gone or its cwd cannot be
 * read (permission). Throws E_NO_PROBE when no METHOD exists — no /proc and no lsof —
 * because "unknown for every pid" silently drops every process from discovery.
 */
function pidCwd(pid, opts = {}) {
  const procRoot = opts.procRoot === undefined ? '/proc' : opts.procRoot;
  if (procRoot && fs.existsSync(path.join(procRoot, 'self'))) {
    try { return fs.readlinkSync(path.join(procRoot, String(pid), 'cwd')); } catch { return null; }
  }
  const l = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], opts);
  if (!l.missing && !l.error) {
    const line = l.out.split('\n').find((x) => x.startsWith('n'));
    return line ? line.slice(1) : null;
  }
  throw new ProbeError('E_NO_PROBE', `cannot read the cwd of pid ${pid}: no /proc and no lsof`, NO_PROBE_HINT);
}

/* ------------------------------------------------------------------ port lists */

/**
 * `8000,8001,8002`, `8100-8109`, or a mix. Throws on anything malformed: a pool that
 * quietly lost an entry is a capacity bug nobody sees.
 */
function parsePortList(spec, what = 'port list') {
  const out = [];
  for (const raw of String(spec || '').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(part);
    if (!m) throw new ProbeError('E_PORTS', `${what}: '${part}' is not a port or a range like 8100-8109`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b > 65535 || b < a) throw new ProbeError('E_PORTS', `${what}: '${part}' is not a valid ascending port range`);
    for (let p = a; p <= b; p += 1) out.push(p);
  }
  const dup = out.find((p, i) => out.indexOf(p) !== i);
  if (dup !== undefined) throw new ProbeError('E_PORTS', `${what}: port ${dup} is listed twice`);
  return out;
}

/**
 * Refuse pools that share a port. `pools` is [{ name, ports }] — each Django pool should
 * be passed together with its webpack (+1000) twin, which is where overlaps hide: a
 * PORT_POOL of 8000-8010 and ONESHOT_APP_PORTS 9005 look disjoint until the +1000.
 */
function assertDisjoint(pools) {
  const owner = new Map();
  for (const { name, ports } of pools) {
    for (const p of ports) {
      const prev = owner.get(p);
      if (prev && prev !== name) {
        throw new ProbeError('E_PORTS', `port ${p} is in both ${prev} and ${name}`,
          'give each pool its own range (server layout: PORT_POOL=8100-8109 -> webpack 9100-9109, ONESHOT_APP_PORTS=8010-8012, local tests 8030/9030)');
      }
      owner.set(p, name);
    }
  }
}

module.exports = {
  ProbeError, listeners, pidsOnPort, listenerPid, isPortListening, portsListening, pidCwd,
  parsePortList, assertDisjoint, parseSs, parseLsof,
};
