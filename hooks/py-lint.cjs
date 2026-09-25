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
 * Fail-open, like every guard here: a linter that cannot run must never wedge
 * a phase. The failure goes to state/hook-errors.log instead.
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const TOOL_TIMEOUT_MS = 25_000;
const MAX_LINES = 25;

/**
 * Comments the ban does not cover.
 *
 * The first two are the skill's stated exceptions (a type-checker suppression
 * and a lint disable); whether either is JUSTIFIED is a judgement the skill
 * still owns and a hook cannot make. The last two are file mechanics, not
 * prose.
 */
const ALLOWED_COMMENTS = [/^#!/, /^#\s*-\*-\s*coding/, /^#\s*type:\s*ignore/, /^#\s*(pylint|noqa)\b/];

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

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: TOOL_TIMEOUT_MS, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        // Both linters exit non-zero merely by finding something, so the exit
        // code says nothing on its own; the output is the signal. A spawn
        // failure (ENOENT) has no stdout and must not read as "clean".
        if (err && err.code === 'ENOENT') return resolve({ ok: false, out: '' });
        return resolve({ ok: true, out: `${stdout || ''}${stderr || ''}`.trim() });
      });
  });
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
    run(venvBin(worktree, 'pylint'), ['--score=n', target], worktree),
    run(python, ['-c', COMMENT_SCAN, target], worktree),
  ]);

  const problems = [];
  if (flake.ok && flake.out) problems.push(`flake8:\n${trim(flake.out)}`);
  if (lint.ok && lint.out) problems.push(`pylint:\n${trim(lint.out)}`);

  if (comments.ok && comments.out) {
    const banned = comments.out.split('\n')
      .map((line) => {
        const tab = line.indexOf('\t');
        return tab === -1 ? null : { line: line.slice(0, tab), text: line.slice(tab + 1) };
      })
      .filter((c) => c && !ALLOWED_COMMENTS.some((re) => re.test(c.text)));
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
