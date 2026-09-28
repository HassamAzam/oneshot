#!/usr/bin/env node
'use strict';
/**
 * PostToolUse: flake8 + pylint + the inline-comment ban, on every .py write.
 *
 * WHY THIS IS A HOOK. These three rules were prose in the python-linting
 * skill, which made them advisory in practice: a phase that never ran the
 * linters still reported done, and nothing downstream disagreed until review
 * — or until a human read the MR. A rule whose only enforcement is the
 * model remembering to enforce it on itself is a rule with a pass rate, not a
 * standard. The skill keeps what needs judgement (which fix to choose, when a
 * disable is legitimate, how to shorten a test name); the mechanical part
 * lives here, where it runs whether or not anybody remembered it.
 *
 * Blocking rather than logging: a PostToolUse block feeds `reason` back to the
 * model as the tool's result, so the session fixes the file it just wrote,
 * while the edit is still the thing it is thinking about. That is the whole
 * value over catching it at review.
 *
 * SCOPE. Only files under ONESHOT_WORKTREE, and never migrations — the ERP
 * rc files exclude `migrations/`, but flake8 does not apply `exclude` to a
 * path passed explicitly, so the skip has to be made here rather than assumed
 * from config. Sessions without ONESHOT_PHASE exit before any of this.
 *
 * The comment ban judges only lines this write added: `new_string` for an
 * Edit, lines absent from HEAD for a Write. A phase that touches a file with
 * legacy comments must not be made to rewrite them — that is churn in the MR,
 * not the rule, which is about what gets written.
 *
 * Fail-open, like every guard here: a linter that cannot run must never wedge
 * a phase, and must never have its own failure reported as findings in the
 * file. That goes to state/hook-errors.log instead.
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
/**
 * Just under the conductor's 60s GUARD_TIMEOUT_MS for this hook, so the
 * linters are what gets killed and the kill is logged here, rather than the
 * whole hook dying with nothing said about which tool was slow.
 */
const TOOL_TIMEOUT_MS = 55_000;
const MAX_LINES = 25;

/**
 * Comments the ban does not cover.
 *
 * The first two are the skill's stated exceptions (a type-checker suppression
 * and a lint disable); whether either is JUSTIFIED is a judgement the skill
 * still owns and a hook cannot make. The shebang and coding line are file
 * mechanics, not prose, and `# pragma:` is coverage's own directive.
 */
const ALLOWED_COMMENTS = [
  /^#!/, /^#\s*-\*-\s*coding/, /^#\s*type:\s*ignore/, /^#\s*(pylint|noqa)\b/, /^#\s*pragma:/,
];

/** Comment scan via Python's own tokenizer — a regex cannot tell `#` in a string from a comment. */
const COMMENT_SCAN = `
import sys, tokenize
found = []
with open(sys.argv[1], "rb") as fh:
    try:
        for tok in tokenize.tokenize(fh.readline):
            if tok.type == tokenize.COMMENT:
                found.append((tok.start[0], tok.string.strip()))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        sys.exit(0)
for line, text in found:
    print("%d\\t%s" % (line, text))
`;

function venvBin(worktree, name) {
  const candidate = path.join(worktree, 'venv', 'bin', name);
  return fs.existsSync(candidate) ? candidate : name;
}

/**
 * Run one tool and say which of three things happened: `clean`, `findings`
 * (stdout only), or `failed` — the tool did not produce a verdict.
 *
 * The exit code is the signal, not the output: flake8 with `count = True`
 * prints `0` on a clean file. But a non-zero exit is not enough either, since
 * flake8 exits 1 both for findings and for its own ImportError, and pylint's
 * crash exit overlaps its fatal bit. Findings are reported on stdout; a crash,
 * a bad rc file or a usage error leaves stdout empty and says so on stderr.
 */
function run(cmd, args, cwd, usageExit) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: TOOL_TIMEOUT_MS, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (!err) return resolve({ status: 'clean', out });
        const failed = (why) => resolve({
          status: 'failed', why: `${cmd}: ${why}\n${String(stderr || '').trim()}`,
        });
        if (err.killed) return failed(`killed after ${TOOL_TIMEOUT_MS}ms`);
        if (typeof err.code !== 'number') return failed(err.code || err.signal || err.message);
        if (err.code === usageExit || !out) return failed(`exit ${err.code} with no findings on stdout`);
        return resolve({ status: 'findings', out });
      });
  });
}

/**
 * The trimmed text of every line this write introduced, or null for "all of
 * them". Compared by text rather than number: an Edit shifts every line below
 * it, and a comment is new exactly when its line was not there before.
 */
function addedLines(tool, input, target, worktree) {
  const lines = (text) => String(text || '').split('\n').map((l) => l.trimEnd());
  if (tool === 'Edit') {
    const before = new Set(lines(input.old_string));
    return new Set(lines(input.new_string).filter((l) => !before.has(l)));
  }
  const rel = path.relative(C.realish(worktree), C.realish(target));
  try {
    const head = execFileSync('git', ['-C', worktree, 'show', `HEAD:${rel}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const before = new Set(lines(head));
    return new Set(lines(fs.readFileSync(target, 'utf8')).filter((l) => !before.has(l)));
  } catch {
    return null;
  }
}

function trim(out) {
  const lines = out.split('\n').filter((l) => l.trim());
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return `${lines.slice(0, MAX_LINES).join('\n')}\n… and ${lines.length - MAX_LINES} more`;
}

async function main() {
  const data = C.readInput();
  if (!WRITE_TOOLS.has(data.tool_name || '')) return C.allow();

  // A write that failed leaves nothing worth linting.
  const response = data.tool_response || {};
  if (response.success === false) return C.allow();

  const input = data.tool_input || {};
  const target = input.file_path || input.notebook_path || input.path || '';
  if (!target.endsWith('.py')) return C.allow();

  const worktree = process.env.ONESHOT_WORKTREE || '';
  if (!worktree || !C.isInside(target, worktree)) return C.allow();
  if (/(^|\/)migrations\//.test(C.realish(target))) return C.allow();
  if (!fs.existsSync(target)) return C.allow();

  const python = venvBin(worktree, 'python3');
  const [flake, lint, comments] = await Promise.all([
    run(venvBin(worktree, 'flake8'), [target], worktree),
    // pylint's bit 32 is a usage error: the run never reached the file.
    run(venvBin(worktree, 'pylint'), ['--score=n', target], worktree, 32),
    run(python, ['-c', COMMENT_SCAN, target], worktree),
  ]);

  for (const r of [flake, lint, comments]) {
    if (r.status === 'failed') C.logFailure('py-lint', `${target}: ${r.why}`);
  }

  const problems = [];
  // `count = True` appends a bare total to flake8's findings; it is not one.
  const flakeOut = flake.status === 'findings'
    && flake.out.split('\n').filter((l) => !/^\d+$/.test(l.trim())).join('\n');
  if (flakeOut) problems.push(`flake8:\n${trim(flakeOut)}`);
  if (lint.status === 'findings') problems.push(`pylint:\n${trim(lint.out)}`);

  if (comments.status === 'clean' && comments.out) {
    const added = addedLines(data.tool_name, input, target, worktree);
    const fileLines = fs.readFileSync(target, 'utf8').split('\n');
    const banned = comments.out.split('\n')
      .map((line) => {
        const tab = line.indexOf('\t');
        return tab === -1 ? null : { line: line.slice(0, tab), text: line.slice(tab + 1) };
      })
      .filter((c) => c && !ALLOWED_COMMENTS.some((re) => re.test(c.text)))
      .filter((c) => !added || added.has((fileLines[Number(c.line) - 1] || '').trimEnd()));
    if (banned.length) {
      problems.push(
        `inline comments (this repo allows none — docstrings are the only prose in source):\n${
          trim(banned.map((c) => `${target}:${c.line}: ${c.text}`).join('\n'))}`,
      );
    }
  }

  if (!problems.length) return C.allow();

  C.event('py_lint_block', { target, count: problems.length });
  return C.postBlock(
    `${target} does not pass this repo's Python gate:\n\n${problems.join('\n\n')}\n\n` +
    'Fix these now, in this file, before moving on. Zero flake8 and pylint output is the bar.\n' +
    'For an inline comment, the fix is never to reword it: rename the variable so the code reads ' +
    'as the comment would have, extract a named helper, or move the sentence into the enclosing ' +
    "docstring. For a lint rule you believe is genuinely wrong here, read the `python-linting` " +
    'skill — a disable needs a human to affirm it, so report it rather than adding one.',
  );
}

main().catch((err) => {
  C.logFailure('py-lint', err);
  C.allow();
});
