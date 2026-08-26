#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: the only door to the demo server.
 *
 * Phase 10 used to be code, which is why no hook was needed to stop a model
 * deploying: it held no tool that could. Making it a session moved that
 * constraint from structure into policy, and this file is the policy. It is the
 * load-bearing guard of the whole design (docs/HOOKS.md 4.2) — with no human in
 * the path, it is the only thing between a confused phase and a live box on a
 * VPN-gated subnet.
 *
 * It differs from every other guard here in one respect, deliberately:
 * `_common.cjs` guards are FAIL-OPEN, because a guard that crashes closed would
 * wedge every session on this machine. This one FAILS CLOSED. Unreadable
 * config, an unreadable run journal, an unterminated quote, a command shape it
 * cannot parse, or any thrown exception all end in a deny. A deploy guard that
 * is silently not running is indistinguishable from no guard at all, and the
 * blast radius of the two is identical.
 *
 * The shape of the policy:
 *
 *   - Every phase EXCEPT deploy is refused ssh/scp/rsync/sftp outright. This is
 *     the first remote-execution guard in the repo; before it, any phase with
 *     Bash could reach any host this laptop can route to.
 *   - The deploy phase may run the two vendored scripts by absolute path, and
 *     may reach the hosts in config/deploy.json's allowlist — nothing else.
 *   - Remote commands are checked against an ALLOWLIST of verbs. A deny-list is
 *     the wrong construction for a surface where the unknown case must lose.
 *     The destructive deny-list is layered on top only so the refusal names the
 *     specific thing that was wrong, which is what stops a model retrying it
 *     verbatim.
 *   - The legal ref comes from the run journal, never from the prompt or the
 *     model's message. Otherwise a prompt-injected ticket body names a ref and
 *     the guard validates the attacker's input against itself.
 *   - Three script invocations per run, counted from the hook event log. The
 *     attempt cap is structural, not a sentence in a prompt.
 *
 * The parser is quote-aware rather than borrowing git-guard's split-on-
 * separators helper. git-guard can afford a coarse split because every segment
 * it cares about is a local git command; here the interesting payload is a
 * quoted remote command string, and splitting `ssh host 'cd x && git reset'` on
 * `&&` would hand the second half to the LOCAL git rules and mislabel both.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const WSAI = path.join(C.ONESHOT, 'scripts', 'deploy-wsai.sh');
const WATCH = path.join(C.ONESHOT, 'scripts', 'deploy-watch.sh');
const SCRIPT_NAMES = new Set([path.basename(WSAI), path.basename(WATCH)]);
const REMOTE_BINS = new Set(['ssh', 'scp', 'rsync', 'sftp']);
const MAX_ATTEMPTS = 3;
const EVENT_TAIL_BYTES = 512 * 1024;
const UNRESOLVED = '<unresolved>';

/**
 * Deny, and say so in the audit log even if the reason is that the audit log
 * itself is the thing that broke.
 */
function hardDeny(reason) {
  try { C.event('denied_deploy_failclosed', { reason }); } catch { /* the deny still lands */ }
  C.deny(
    `Denied (deploy-guard, fail-closed): ${reason} This guard refuses rather than ` +
    'waves through when it cannot do its job. Report it in `blocked` — an operator ' +
    'fixes the guard, you do not work around it.',
  );
}

// ------------------------------------------------------------------- lexing

/**
 * Split a command into top-level segments of quote-aware tokens.
 *
 * Quoted runs stay one token and keep a `quoted` marker, so an ssh payload
 * survives intact and can be re-lexed as its own little program.
 */
function lex(cmd) {
  const segments = [];
  let seg = [];
  let tok = '';
  let started = false;
  let quoted = false;
  let quote = null;

  const endTok = () => {
    if (started) seg.push({ value: tok, quoted });
    tok = ''; started = false; quoted = false;
  };
  const endSeg = () => { endTok(); if (seg.length) segments.push(seg); seg = []; };

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      tok += ch; started = true; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; quoted = true; continue; }
    if (ch === '\\') {
      const next = cmd[i + 1];
      if (next) { tok += next; started = true; i += 1; }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endTok(); continue; }
    if (ch === '\n' || ch === ';' || ch === '&' || ch === '|') {
      endSeg();
      if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) i += 1;
      continue;
    }
    tok += ch; started = true;
  }
  endSeg();
  return { segments, unterminated: quote !== null };
}

/**
 * Expand the variables a phase legitimately uses in a path, from the guard's
 * own environment — which is the phase environment, because the conductor
 * spawns guards with it. The hook sees the command BEFORE the shell runs, so
 * `"$ONESHOT_HOME/scripts/deploy-wsai.sh"` arrives unexpanded and a literal
 * comparison would miss the one invocation the prompt actually asks for.
 * Anything unresolvable is marked, and any path check that meets the marker
 * denies rather than guesses.
 */
function expandVars(raw) {
  return C.expandTilde(String(raw || '').replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, a, b) => {
      const v = process.env[a || b];
      return v === undefined ? UNRESOLVED : v;
    },
  ));
}

function values(seg) { return seg.map((t) => t.value); }

/** Redirect targets, so they are never mistaken for a positional argument. */
function redirects(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i += 1) {
    if (seg[i].quoted) continue;
    const m = /^(\d*|&)>>?(.*)$/.exec(seg[i].value);
    if (!m) continue;
    const inline = m[2];
    const target = inline || (seg[i + 1] ? seg[i + 1].value : '');
    out.push({ index: i, consumesNext: !inline, target });
  }
  return out;
}

function positional(seg) {
  const skip = new Set();
  for (const r of redirects(seg)) {
    skip.add(r.index);
    if (r.consumesNext) skip.add(r.index + 1);
  }
  return seg.filter((_t, i) => !skip.has(i));
}

// ------------------------------------------------------------------- config

let cachedCfg;
function deployCfg() {
  if (cachedCfg === undefined) cachedCfg = C.loadConfig('deploy.json');
  const cfg = cachedCfg;
  if (!cfg || !Array.isArray(cfg.allowedHosts) || !cfg.allowedHosts.length) {
    hardDeny(
      'config/deploy.json is unreadable or carries no allowedHosts, so there is no ' +
      'allowlist to check this command against.',
    );
  }
  return cfg;
}

/**
 * The refs this run may deploy, derived from the run journal.
 *
 * config/deploy.json's literal "<ticket-branch>" placeholder is expanded here.
 * A protected branch other than the configured base is dropped even if it is
 * listed: the demo box exists to show one ticket's work, and 'master' on it is
 * never something this pipeline decided.
 */
function legalRefs() {
  const cfg = deployCfg();
  const iid = C.ticket();
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(
      path.join(C.STATE, 'runs', String(iid), 'run.json'), 'utf8',
    ));
  } catch {
    hardDeny(`the run journal for ticket ${iid || '(unknown)'} could not be read, so there is ` +
             'no way to tell which branch this run is allowed to deploy.');
  }
  const project = C.loadConfig('project.json') || { branches: {} };
  const branches = project.branches || {};
  const base = branches.base || 'dev';
  const protectedRefs = new Set(branches.protected || []);

  const refs = new Set();
  if (journal.branch) refs.add(journal.branch);
  for (const r of (cfg.allowedRefs || [])) {
    if (r === '<ticket-branch>') { if (journal.branch) refs.add(journal.branch); } else refs.add(r);
  }
  for (const r of [...refs]) if (protectedRefs.has(r) && r !== base) refs.delete(r);
  if (!refs.size) hardDeny('the run journal names no branch and config/deploy.json lists no usable ref.');
  return refs;
}

// ------------------------------------------------------------- attempt cap

/**
 * Count this run's prior script invocations from the hook event log.
 *
 * The log is the only record that survives a dead session, which is what makes
 * the cap hold across retries. A bounded tail read keeps the hook
 * dependency-free and cheap enough to sit in front of a build.
 */
function priorAttempts() {
  const run = C.runId();
  if (!run) return 0;
  const file = path.join(C.STATE, 'hook-events.jsonl');
  let raw = '';
  try {
    if (!fs.existsSync(file)) return 0;
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - EVENT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    raw = buf.toString('utf8');
  } catch {
    hardDeny('the hook event log could not be read, so this run\'s deploy attempt count is unknown.');
  }
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('deploy_script_allowed')) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'deploy_script_allowed' && e.run_id === run) n += 1;
    } catch { /* the first line of a tail read is expected to be truncated */ }
  }
  return n;
}

/**
 * The demo box takes one deploy at a time — the script ships a branch TIP, so
 * two concurrent deploys put two tickets on the box and neither QA verdict
 * means anything afterwards. A lock older than the script's own deadline is
 * ignored, the same staleness idiom PAUSE-NETWORK uses, so a killed conductor
 * cannot wedge deploys forever.
 */
function checkDeployLock() {
  const cfg = deployCfg();
  const file = path.join(C.STATE, 'DEPLOY-LOCK');
  if (!fs.existsSync(file)) return;
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    hardDeny('state/DEPLOY-LOCK exists but is unreadable, so it is impossible to tell whether ' +
             'another run is on the box right now.');
  }
  const age = Date.now() - Number(lock.since || 0);
  if (lock.runId && lock.runId !== C.runId() && age < (cfg.timeoutMin || 50) * 60000) {
    C.event('denied_deploy_lock', { holder: lock.runId, iid: lock.iid });
    C.deny(
      `Denied: run ${lock.runId} (ticket ${lock.iid}) holds the deploy lock, taken ` +
      `${Math.round(age / 60000)} minutes ago. The demo server takes one deploy at a time. ` +
      'Set `blocked` saying the box was occupied; the conductor releases the lock when that ' +
      'run finishes and a human decides whether to re-queue this one.',
    );
  }
}

function checkPaused() {
  const paused = C.pauseFile();
  if (!paused) return;
  C.event('denied_deploy_paused', { file: paused.file });
  C.deny(
    `Denied: Oneshot is paused (state/${paused.file}) and deploying is the one operation ` +
    'that must still refuse when the brake is on. Stop now and write what you completed.',
  );
}

// ----------------------------------------------------------- remote policy

const REMOTE_ALLOW = new Set([
  'cd', 'pwd', 'echo', 'cat', 'tail', 'head', 'grep', 'egrep', 'zgrep', 'wc', 'ls', 'stat',
  'find', 'du', 'df', 'ps', 'pgrep', 'uptime', 'free', 'date', 'whoami', 'hostname', 'sed',
  'awk', 'cut', 'sort', 'uniq', 'test', 'true', 'readlink', 'realpath', 'journalctl',
  'curl', 'git', 'python3', 'supervisorctl', 'systemctl',
]);

const GIT_READ = new Set([
  'rev-parse', 'log', 'status', 'diff', 'show', 'fetch', 'branch', 'describe',
  'cat-file', 'merge-base', 'ls-files', 'remote',
]);

const SUPERVISOR_READ = new Set(['status', 'pid', 'avail', 'version']);
const SYSTEMCTL_READ = new Set(['status', 'is-active', 'is-enabled', 'show', 'list-units']);
const MANAGE_READ = new Set(['showmigrations', 'check', 'diffsettings']);

/**
 * Layered on top of the allowlist purely so the refusal is specific. The
 * allowlist already catches every one of these; a model that reads
 * "'rm' is not in the allowlist" learns less than one that reads why.
 */
const REMOTE_DESTRUCTIVE = [
  [/\brm\s+-[a-zA-Z]*[rf]/, 'deletes files on the demo box'],
  [/\bshred\b|\bmkfs|\btruncate\b/, 'destroys data on the demo box'],
  [/\bdd\b[^|]*\bof=\/dev\//, 'writes to a raw device'],
  [/\buserdel\b|\bgroupdel\b|\bvisudo\b/, 'changes accounts on a shared machine'],
  [/\bchmod\s+-R\s+777|\bchown\s+-R\b/, 'rewrites ownership or permissions wholesale'],
  [/\bdropdb\b|\bpsql\b[^|]*\bdrop\s/i, 'drops a database'],
  [/\bmanage\.py\s+(flush|sqlflush|loaddata|migrate)\b/, 'mutates the demo database by hand — the build script owns migrate'],
  [/\bgit\s+(clean|reset\s+--hard|checkout|pull|push|merge|rebase|gc|filter-branch)\b/, 'rewrites the deployed working tree'],
  [/\bkill\s+-9\b|\bpkill\b|\bkillall\b/, 'kills processes — the wedged-I/O remedy in the script header describes a human\'s action, not yours'],
  [/\bcrontab\b|\bat\s+now\b|\bnohup\b|\bsetsid\b/, 'leaves something running past the end of this phase'],
  [/\bfind\b[^|]*\s-(delete|exec)\b/, 'runs an action against every file it matches'],
  [/\bsed\s+-i\b|\btee\b/, 'edits a file in place on the demo box'],
  [/>\s*\/etc\//, 'writes to system configuration'],
  [/\bapt(-get)?\s+(remove|purge)\b|\bnpm\s+(uninstall|prune)\b|\bpip3?\s+uninstall\b/, 'removes installed packages'],
];

function denyRemote(kind, detail, reason) {
  C.event(kind, detail);
  C.deny(`Denied: ${reason}`);
}

function urlHost(raw) {
  try { return new URL(raw).hostname; } catch { return ''; }
}

/**
 * curl is on the allowlist because the health re-check is the whole point of
 * the phase. It is also the obvious way to move a log off the box, so the URL
 * host is allowlisted and uploads are refused outright.
 */
function checkCurl(seg, where) {
  const cfg = deployCfg();
  const vals = values(seg);
  const allowed = new Set([...cfg.allowedHosts, '127.0.0.1', 'localhost', '::1']);
  const demo = urlHost(cfg.demoUrl || '');
  if (demo) allowed.add(demo);

  for (let i = 0; i < vals.length; i += 1) {
    const v = vals[i];
    if (v === '-T' || v === '--upload-file') {
      denyRemote('denied_remote_upload', { where, cmd: vals.join(' ') },
        'curl --upload-file sends a file off the machine. The deploy phase pulls logs; it ' +
        'never pushes anything anywhere. Save what you read under artifacts/ instead.');
    }
    if (v === '-O' || v === '--remote-name') {
      denyRemote('denied_remote_curl_out', { where, cmd: vals.join(' ') },
        'curl -O writes a file named by the URL, into whatever the working directory happens ' +
        'to be. Name the destination with -o so it can be checked.');
    }
    if (v === '-o' || v === '--output') {
      const target = expandVars(vals[i + 1] || '');
      if (target !== '/dev/null' && !target.startsWith('/tmp/')) {
        denyRemote('denied_remote_curl_out', { where, target },
          `curl writing to '${target}' is outside /tmp. Use -o /dev/null for a status probe, ` +
          'or a /tmp path if you genuinely need the body.');
      }
    }
    if (!/^https?:\/\//.test(v)) continue;
    const host = urlHost(v);
    if (!allowed.has(host)) {
      denyRemote('denied_curl_host', { where, host },
        `'${host || v}' is not the demo server. The only hosts this phase may reach are: ` +
        `${[...allowed].join(', ')}. Anything else is out of scope for a deploy.`);
    }
  }
}

/** The subcommand, skipping global options and `-C <path>`'s value. */
function gitSub(vals) {
  for (let i = 1; i < vals.length; i += 1) {
    const v = vals[i];
    if (v === '-C' || v === '-c' || v === '--git-dir' || v === '--work-tree') { i += 1; continue; }
    if (v.startsWith('-')) continue;
    return v;
  }
  return '';
}

function checkRemoteGit(vals, where) {
  const sub = gitSub(vals);
  if (!GIT_READ.has(sub)) {
    denyRemote('denied_remote_git', { where, sub, cmd: vals.join(' ') },
      `\`git ${sub || '(none)'}\` writes to the deployed tree at /home/erp_user/demo/erp_app. ` +
      'Only reads are legal here — rev-parse, log, status, diff, show, fetch, describe, ' +
      'merge-base. If the box is on the wrong SHA that is a deploy problem, not a git problem.');
  }
  if (sub === 'branch' && vals.some((v) => v === '-D' || v === '-d' || v === '-m' || v === '--delete')) {
    denyRemote('denied_remote_git', { where, cmd: vals.join(' ') },
      '`git branch` is a read here. Deleting or renaming a branch on the demo box is not.');
  }
  if (sub === 'remote' && vals.length > 2 && !vals.includes('-v') && !vals.includes('show')) {
    denyRemote('denied_remote_git', { where, cmd: vals.join(' ') },
      '`git remote` may only be listed (`-v` / `show`). Repointing the box\'s remote defeats ' +
      'every other check in this guard.');
  }
}

function checkSupervisorctl(vals, where) {
  const verb = vals.slice(1).find((v) => !v.startsWith('-'));
  if (SUPERVISOR_READ.has(verb)) return;
  if (verb !== 'restart') {
    denyRemote('denied_supervisorctl', { where, verb },
      `\`supervisorctl ${verb || '(none)'}\` is not a recovery action — it is a way to take the ` +
      'demo down. The legal verbs are `status` and a single `restart` of a demo_erp unit.');
  }
  const units = vals.slice(vals.indexOf('restart') + 1).filter((v) => !v.startsWith('-'));
  if (!units.length || units.some((u) => !/^demo_erp/.test(u))) {
    denyRemote('denied_supervisorctl', { where, units },
      'a `supervisorctl restart` here may name only demo_erp units, one at a time — not `all`, ' +
      'not nginx, not postgres. That box runs things this ticket has no claim on.');
  }
}

function checkPython3(vals, where) {
  const rest = vals.slice(1);
  if (rest[0] === '-c') {
    const code = rest.slice(1).join(' ');
    if (/os\.system|subprocess|popen|__import__|open\s*\(/i.test(code)) {
      denyRemote('denied_remote_python', { where, code },
        'python3 -c may not shell out, spawn a process, or open files. If you need a command, ' +
        'write the command.');
    }
    return;
  }
  const script = rest.find((v) => !v.startsWith('-'));
  if (!/manage\.py$/.test(script || '')) {
    denyRemote('denied_remote_python', { where, cmd: vals.join(' ') },
      'the only python3 the deploy phase may run on the box is `manage.py showmigrations|check|' +
      'diffsettings`, or a `-c` expression that does not shell out.');
  }
  const sub = rest.slice(rest.indexOf(script) + 1).find((v) => !v.startsWith('-'));
  if (!MANAGE_READ.has(sub)) {
    denyRemote('denied_remote_python', { where, sub },
      `\`manage.py ${sub || '(none)'}\` mutates the demo database. The build script owns migrate; ` +
      'running one by hand is how the box ends up half-migrated. Read-only subcommands are ' +
      'showmigrations, check and diffsettings.');
  }
}

/** Strip sudo (and `sudo -u <user>`) so the real verb is what gets checked. */
function peelSudo(vals) {
  let i = 0;
  while (vals[i] === 'sudo') {
    i += 1;
    while (vals[i] && vals[i].startsWith('-')) {
      const takesValue = vals[i] === '-u' || vals[i] === '-g' || vals[i] === '-p';
      i += takesValue ? 2 : 1;
    }
  }
  return vals.slice(i);
}

/**
 * The remote command string, checked as its own little program.
 *
 * An allowlist of heads is the only construction that fails closed here: a
 * deny-list on a shell surface is a list of the attacks someone thought of.
 */
function checkRemoteCommand(cmdString, where) {
  if (!cmdString.trim()) return;
  for (const [re, why] of REMOTE_DESTRUCTIVE) {
    if (re.test(cmdString)) {
      denyRemote('denied_remote_destructive', { where, cmd: cmdString },
        `that command ${why}. Nothing on the demo box is removed, reset, restarted wholesale ` +
        'or reinstalled by a phase. Read the evidence, then say in `blocked` what a human ' +
        'needs to do.');
    }
  }

  const { segments, unterminated } = lex(cmdString);
  if (unterminated) hardDeny('the remote command has an unterminated quote and cannot be parsed.');

  for (const seg of segments) {
    const vals = peelSudo(values(positional(seg)));
    const head = path.basename(vals[0] || '');
    if (!head) {
      denyRemote('denied_remote_verb', { where, cmd: cmdString },
        'a bare `sudo` with no command is not something this guard can reason about.');
    }
    if (!REMOTE_ALLOW.has(head)) {
      denyRemote('denied_remote_verb', { where, head, cmd: cmdString },
        `'${head}' is not a legal remote verb for this phase. The allowlist is inspection plus ` +
        'one recovery action: ' + [...REMOTE_ALLOW].join(', ') + '. Everything else is denied, ' +
        'and retrying it verbatim costs a turn you may need for diagnosis.');
    }
    if (head === 'git') checkRemoteGit(vals, where);
    if (head === 'supervisorctl') checkSupervisorctl(vals, where);
    if (head === 'systemctl') {
      const verb = vals.slice(1).find((v) => !v.startsWith('-'));
      if (!SYSTEMCTL_READ.has(verb)) {
        denyRemote('denied_systemctl', { where, verb },
          `\`systemctl ${verb || '(none)'}\` changes service state outside supervisor's control. ` +
          'Only status, is-active, is-enabled, show and list-units are legal.');
      }
    }
    if (head === 'python3') checkPython3(vals, where);
    if (head === 'curl') checkCurl(seg, where);

    for (const r of redirects(seg)) {
      const target = expandVars(r.target);
      if (target && target !== '/dev/null' && !target.startsWith('/tmp/')) {
        denyRemote('denied_remote_redirect', { where, target },
          `a redirect to '${target}' writes to the demo box. Read the log over ssh and save ` +
          'the copy you need under artifacts/ on this side instead.');
      }
    }
  }
}

// ------------------------------------------------------------ ssh / scp / rsync

const SSH_VALUE_FLAGS = new Set([
  '-o', '-i', '-F', '-l', '-p', '-P', '-b', '-c', '-D', '-E', '-e', '-I', '-J', '-L',
  '-m', '-O', '-Q', '-R', '-S', '-W', '-w', '-B',
]);

const SSH_BANNED = {
  '-J': 'ProxyJump reaches a second host through the first, which defeats the host allowlist entirely.',
  '-L': 'a port forward turns the demo box into a route to machines this phase may not touch.',
  '-R': 'a reverse forward exposes this laptop to that subnet.',
  '-D': 'a SOCKS proxy makes the allowlist meaningless.',
  '-w': 'a tunnel device is not something a deploy needs.',
  '-F': 'an alternate ssh config can redefine the host you think you are reaching.',
};

function checkSshOptions(vals, where) {
  for (let i = 0; i < vals.length; i += 1) {
    const v = vals[i];
    if (SSH_BANNED[v]) {
      denyRemote('denied_ssh_option', { where, option: v },
        `\`${v}\` is refused: ${SSH_BANNED[v]} Connect to the demo server directly, with no ` +
        'forwarding options.');
    }
    if (v === '-o') {
      const opt = String(vals[i + 1] || '');
      if (/^ProxyJump|^ProxyCommand/i.test(opt)) {
        denyRemote('denied_ssh_option', { where, option: opt },
          `\`-o ${opt}\` reaches another host through this one. The allowlist exists precisely ` +
          'to stop that.');
      }
      if (/StrictHostKeyChecking\s*=\s*(no|off)/i.test(opt) || /UserKnownHostsFile\s*=\s*\/dev\/null/i.test(opt)) {
        denyRemote('denied_ssh_option', { where, option: opt },
          `\`-o ${opt}\` accepts whatever answers on that address. On a VPN-gated subnet that ` +
          'is exactly the check worth keeping. If the host key genuinely changed, a human ' +
          'decides that.');
      }
    }
    if (v === '-i') {
      const key = expandVars(vals[i + 1] || '');
      if (!C.isInside(key, path.join(C.HOME, '.ssh'))) {
        denyRemote('denied_ssh_option', { where, key },
          `\`-i ${key}\` uses a key from outside ~/.ssh. Use the operator's own key, which is ` +
          'the only credential this pipeline is authorised to present.');
      }
    }
  }
}

/** Everything after the option block and the destination is the remote command. */
function sshParts(vals) {
  let i = 1;
  while (i < vals.length) {
    const v = vals[i];
    if (!v.startsWith('-')) break;
    i += SSH_VALUE_FLAGS.has(v) ? 2 : 1;
  }
  return { dest: vals[i] || '', rest: vals.slice(i + 1) };
}

function hostOf(spec) {
  let s = String(spec || '');
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1);
  const colon = s.indexOf(':');
  if (colon !== -1) s = s.slice(0, colon);
  return s.replace(/^\[|\]$/g, '');
}

function assertAllowedHost(host, where) {
  const cfg = deployCfg();
  if (!host || !cfg.allowedHosts.includes(host)) {
    denyRemote('denied_deploy_host', { where, host },
      `'${host || '(unparseable)'}' is not the demo server. config/deploy.json allows only ` +
      `${cfg.allowedHosts.join(', ')}. Every other machine on this network — the dev/stage box, ` +
      'the pipeline box — is out of scope for a demo deploy.');
  }
}

function checkSsh(seg) {
  const vals = values(positional(seg));
  checkSshOptions(vals, 'ssh');
  const { dest, rest } = sshParts(vals);
  assertAllowedHost(hostOf(dest), 'ssh');
  checkRemoteCommand(rest.join(' '), 'ssh');
}

/**
 * scp and rsync may pull, never push. The deploy script itself never uploads
 * anything — the box pulls from its own remote with its own deploy key — so a
 * local source with a remote destination is always someone improvising.
 */
function checkCopy(seg, bin) {
  const vals = values(positional(seg));
  checkSshOptions(vals, bin);
  const args = vals.slice(1).filter((v) => !v.startsWith('-'));
  if (args.length < 2) {
    denyRemote('denied_copy_shape', { bin, cmd: vals.join(' ') },
      `this \`${bin}\` has no clear source and destination, so the guard cannot tell which ` +
      'direction the bytes move. Write it out in full.');
  }
  const dest = args[args.length - 1];
  const sources = args.slice(0, -1);
  for (const a of args) if (a.includes(':')) assertAllowedHost(hostOf(a), bin);
  if (dest.includes(':') && sources.some((s) => !s.includes(':'))) {
    denyRemote('denied_copy_upload', { bin, dest },
      `${bin} to '${dest}' uploads onto the demo box. The deploy phase pulls logs; code reaches ` +
      'that box only by the build script pulling its own remote. Nothing is ever pushed by hand.');
  }
}

// --------------------------------------------------------- the local surface

const LOCAL_GIT_DENY =
  'Denied: the deploy phase does not touch git. The merge already happened and the branch is ' +
  'where it needs to be. If the box is on the wrong SHA that is a deploy problem — say so in ' +
  '`blocked`, with the SHA you actually observed.';

function checkLocalGit(seg) {
  const vals = values(positional(seg));
  const head = path.basename(vals[0] || '');
  if (head === 'gh' || head === 'glab') {
    C.event('denied_deploy_forge_cli', { cmd: vals.join(' ') });
    C.deny(
      `Denied: the '${head}' CLI opens, merges and releases. None of that belongs in a deploy. ` +
      'The merge phase already ran.',
    );
  }
  if (head !== 'git') return;
  const sub = gitSub(vals);
  const writes = new Set([
    'push', 'commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'am', 'tag',
    'checkout', 'switch', 'remote', 'clean', 'apply', 'revert', 'stash',
  ]);
  if (writes.has(sub)) {
    C.event('denied_deploy_git', { sub, cmd: vals.join(' ') });
    C.deny(LOCAL_GIT_DENY);
  }
}

/**
 * write-scope never sees Bash, so `echo x > /anywhere` has always been outside
 * the scope machinery. Closed here for the deploy phase, where the artifacts
 * under state/runs/<iid>/ are the only forensic record that outlives the run:
 * /tmp on the demo server is not durable and no later phase can ssh.
 */
function checkLocalRedirects(seg) {
  const scopes = (process.env.ONESHOT_WRITE_SCOPES || '').split(':').map((s) => s.trim()).filter(Boolean);
  for (const r of redirects(seg)) {
    const target = expandVars(r.target);
    if (!target || target.startsWith('/dev/') || target.startsWith('&')) continue;
    if (!scopes.length) {
      hardDeny('this phase was given no write scopes, so a redirect has nothing to be checked against.');
    }
    if (target.includes(UNRESOLVED)) {
      denyRemote('denied_redirect_unresolved', { target: r.target },
        `the redirect target '${r.target}' contains a variable this guard cannot resolve, so ` +
        'it cannot be checked. Write the path out.');
    }
    if (!scopes.some((s) => C.isInside(target, s))) {
      C.event('denied_redirect_scope', { target, scopes });
      C.deny(
        `Denied: '${target}' is outside this phase's write scopes:\n` +
        scopes.map((s) => `  - ${s}`).join('\n') +
        '\nSave logs under the run\'s artifacts/ directory — that is the only copy the later ' +
        'phases can read.',
      );
    }
  }
}

// ------------------------------------------------------- the vendored scripts

const WSAI_FLAGS = new Set(['--yes', '-y', '--npm', '--pip']);
const WATCH_SUBS = new Set(['start', 'poll', 'status']);
const WATCH_FLAGS = new Set(['--npm', '--pip']);
const WATCH_VALUE_FLAGS = new Set(['--ref', '--run', '--attempt', '--slice']);

/**
 * Identify a reference to a vendored script by NAME or by real path.
 *
 * Both directions matter. Name-only matching is defeated by a symlink at
 * /tmp/deploy-wsai.sh; realpath-only matching is defeated by a copy, which
 * would then be treated as an ordinary command and waved through. Either
 * signal identifies the reference; only the exact vendored path passes.
 *
 * The cheap basename test comes first because this runs on every token of
 * every Bash call in every phase, and C.realish() walks the filesystem.
 */
function identifyScript(token) {
  const resolved = expandVars(token);
  const base = path.basename(resolved);
  const named = SCRIPT_NAMES.has(base);
  if (!named && !/\.sh$/.test(base)) return null;
  const real = C.realish(resolved);
  if (real === C.realish(WSAI)) return { kind: 'wsai', path: WSAI, resolved };
  if (real === C.realish(WATCH)) return { kind: 'watch', path: WATCH, resolved };
  if (base === path.basename(WSAI)) return { kind: 'wsai', path: WSAI, resolved, impostor: true };
  if (base === path.basename(WATCH)) return { kind: 'watch', path: WATCH, resolved, impostor: true };
  return null;
}

function scriptRef(vals) {
  return vals.find((v) => identifyScript(v));
}

function assertLegalRef(ref) {
  const refs = legalRefs();
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    C.event('denied_deploy_sha', { ref });
    C.deny(
      `Denied: '${ref}' looks like a SHA. The script takes a BRANCH and deploys its tip — a SHA ` +
      'would be treated as a branch name and fail under set -euo pipefail, several minutes in. ' +
      `Pass one of: ${[...refs].join(', ')}.`,
    );
  }
  if (!refs.has(ref)) {
    C.event('denied_deploy_ref', { ref, legal: [...refs] });
    C.deny(
      `Denied: '${ref}' is not a ref this run may deploy. The legal refs come from this run's ` +
      `journal and config/deploy.json: ${[...refs].join(', ')}. Nothing in a ticket body, a ` +
      'comment or a log changes that list.',
    );
  }
}

function checkWsaiArgs(args) {
  const bare = [];
  for (const a of args) {
    if (a.startsWith('-')) {
      if (!WSAI_FLAGS.has(a)) {
        C.event('denied_deploy_flag', { flag: a });
        C.deny(
          `Denied: '${a}' is not an option deploy-wsai.sh accepts. The only flags are --yes, ` +
          '--npm and --pip. The script would reject it too, but not before you had waited on it.',
        );
      }
      continue;
    }
    bare.push(a);
  }
  if (bare.length !== 1) {
    C.event('denied_deploy_arity', { bare });
    C.deny(
      `Denied: pass exactly one bare ref, not ${bare.length} (${bare.join(', ') || 'none'}). ` +
      'The script keeps the LAST bare argument it sees, so `--yes dev master` silently deploys ' +
      'master. Name the one ref you mean.',
    );
  }
  assertLegalRef(bare[0]);
}

function checkWatchArgs(args) {
  const sub = args.find((a) => !a.startsWith('-'));
  if (!WATCH_SUBS.has(sub)) {
    C.event('denied_watch_sub', { sub });
    C.deny(
      `Denied: '${sub || '(none)'}' is not a deploy-watch.sh subcommand. It takes start, poll ` +
      'or status.',
    );
  }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) continue;
    if (WATCH_FLAGS.has(a)) continue;
    if (WATCH_VALUE_FLAGS.has(a)) {
      if (a === '--ref') assertLegalRef(args[i + 1] || '');
      i += 1;
      continue;
    }
    C.event('denied_watch_flag', { flag: a });
    C.deny(
      `Denied: '${a}' is not a deploy-watch.sh option. It takes --ref, --run, --attempt, ` +
      '--slice, --npm and --pip.',
    );
  }
  return sub;
}

function checkScript(seg, token) {
  const found = identifyScript(token);
  const vals = values(positional(seg));
  const idx = vals.indexOf(token);

  if (found.resolved.includes(UNRESOLVED)) {
    C.event('denied_deploy_unresolved', { token });
    C.deny(
      `Denied: '${token}' contains a variable that is not set in this phase's environment, so ` +
      `the guard cannot tell what would run. Use \`bash ${found.path} …\`.`,
    );
  }
  if (!path.isAbsolute(found.resolved)) {
    C.event('denied_deploy_relative', { token });
    C.deny(
      `Denied: '${token}' is a relative path, and what it means depends on where you are ` +
      'standing — which this guard cannot see and you are not allowed to change (`cd` is ' +
      `denied). Invoke it as \`bash ${found.path} …\`.`,
    );
  }
  if (found.impostor || C.realish(found.resolved) !== C.realish(found.path)) {
    C.event('denied_deploy_impostor', { token, resolved: found.resolved });
    C.deny(
      `Denied: '${token}' is not the vendored ${path.basename(found.path)}. A copy or a symlink ` +
      'somewhere else is not the script this guard reviewed. Invoke it by its real absolute ' +
      `path: ${found.path}`,
    );
  }
  if (idx > 1 || (idx === 1 && vals[0] !== 'bash' && vals[0] !== 'sh')) {
    C.event('denied_deploy_interpreter', { cmd: vals.join(' ') });
    C.deny(
      `Denied: run the script as \`bash ${found.path} …\` and nothing else. No sudo, no env, no ` +
      'wrapper — each of those changes what actually executes, and the guard reviewed the ' +
      'script, not the wrapper.',
    );
  }

  checkPaused();
  const args = vals.slice(idx + 1);
  let launching = true;
  if (found.kind === 'wsai') {
    checkWsaiArgs(args);
  } else {
    launching = checkWatchArgs(args) === 'start';
  }
  if (!launching) return;

  checkDeployLock();
  const prior = priorAttempts();
  if (prior >= MAX_ATTEMPTS) {
    C.event('denied_deploy_attempts', { prior });
    C.deny(
      `Denied: this run has already launched the deploy script ${prior} times, and three is the ` +
      'cap. A fourth build will not discover something the first three did not. Stop, and set ' +
      '`blocked` with what the last attempt actually showed in the log.',
    );
  }
  C.event('deploy_script_allowed', { script: path.basename(found.path), attempt: prior + 1 });
}

// ---------------------------------------------------------------- the body

const UNPARSEABLE = /\$\(|`|\beval\b|\bxargs\b|<<|\bbase64\s+-d\b|\bsource\b|(^|\s)\.\s/;
const REMOTE_SURFACE = /\b(ssh|scp|rsync|sftp)\b|deploy-wsai\.sh|deploy-watch\.sh/;

function crossPhaseDeny(head, cmd) {
  C.event('denied_deploy_cross_phase', { phase: C.phase(), head, cmd });
  C.deny(
    `Denied: only the 'deploy' phase touches the demo server, and this is the '${C.phase()}' ` +
    'phase. Deploying is phase 10 and the conductor schedules it. Nothing you are doing needs ' +
    'a remote shell — if it seems to, say that in your summary rather than reaching for one.',
  );
}

try {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    hardDeny(`the tool payload could not be read from stdin (${err.message}).`);
  }
  let data;
  try {
    data = JSON.parse(raw || '');
  } catch {
    hardDeny('the tool payload on stdin is not valid JSON, so the command cannot be inspected.');
  }

  const cmd = ((data && data.tool_input) || {}).command || '';
  if (cmd) {
    const deploying = C.phase() === 'deploy';
    const { segments, unterminated } = lex(cmd);
    if (unterminated && REMOTE_SURFACE.test(cmd)) {
      hardDeny('this command has an unterminated quote, so what would reach the server is a guess.');
    }

    if (REMOTE_SURFACE.test(cmd) && UNPARSEABLE.test(cmd)) {
      C.event('denied_deploy_unparseable', { cmd });
      C.deny(
        'Denied: this command mixes command substitution, an eval/xargs wrapper or a heredoc ' +
        'with a remote operation, and the guard cannot determine what would actually run on ' +
        'the server. Write the literal command. If you need a value first, get it in its own ' +
        'separate call and read the result.',
      );
    }

    for (const seg of segments) {
      const vals = values(positional(seg));
      if (!vals.length) continue;
      const head = path.basename(vals[0] || '');

      if ((head === 'bash' || head === 'sh') && vals.includes('-c') &&
          REMOTE_SURFACE.test(vals.join(' '))) {
        C.event('denied_deploy_shell_wrapper', { cmd });
        C.deny(
          'Denied: a remote operation hidden inside `bash -c \'…\'` is exactly how a guard gets ' +
          'defeated, so the shape is refused whatever the payload says. Run the command directly.',
        );
      }

      const scriptToken = scriptRef(vals);
      if (scriptToken && !deploying) crossPhaseDeny(head, cmd);
      if (REMOTE_BINS.has(head) && !deploying) crossPhaseDeny(head, cmd);
      if (!deploying) continue;

      if (scriptToken) checkScript(seg, scriptToken);
      if (head === 'ssh') checkSsh(seg);
      if (head === 'scp' || head === 'rsync') checkCopy(seg, head);
      if (head === 'sftp') {
        C.event('denied_sftp', { cmd });
        C.deny(
          'Denied: sftp opens an interactive transfer session, which this guard cannot inspect ' +
          'and this phase does not need. Read what you need over ssh and save it under ' +
          'artifacts/; use scp only to pull a specific file down.',
        );
      }
      if (head === 'curl' || head === 'wget') checkCurl(seg, 'local');
      checkLocalGit(seg);
      checkLocalRedirects(seg);
    }
  }
} catch (err) {
  C.logFailure('deploy-guard', err);
  hardDeny(`the guard itself threw (${(err && err.message) || err}).`);
}

C.allow();
