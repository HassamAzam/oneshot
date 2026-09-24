#!/usr/bin/env node
'use strict';
/**
 * PostToolUse: the two decidable rules for one-off scripts.
 *
 *   1. No Django bootstrap — the file is exec'd inside a live shell.
 *   2. A fabricated email uses @example.com and nothing else.
 *
 * WHY THIS IS A HOOK. Both are invisible until someone runs the thing. A
 * `django.setup()` or an `if __name__ == "__main__":` guard does not fail
 * loudly under `manage.py shell < script.py` — the guard simply never fires and
 * the script does nothing, which reads exactly like a script with nothing to
 * do. A fabricated address on a live domain is worse: it looks fine until a
 * seed run puts a real-looking mailbox in a table someone later mails.
 *
 * SCOPE is `scripts/` and `tmp_scripts/` only. `django.setup()` is correct in
 * hrdb/asgi.py and docs/conf.py, and management commands are explicitly not
 * this skill's subject — a wider net would flag all three.
 *
 * WHAT THE EMAIL CHECK WILL NOT DO. The skill is explicit that a script
 * provisioning a REAL user writes that person's real address, and that those
 * must never be rewritten to @example.com. So the check never fires on a
 * domain merely because it is real. It fires on two things it can be sure of:
 * a placeholder domain that is not example.com, and a local part that names
 * itself a test or a seed sitting on some other domain. An address with no
 * fabrication marker is left alone, which is the side to err on.
 *
 * Fail-open, like every guard here.
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SCRIPT_DIR = /(^|\/)(tmp_scripts|scripts)\/[^/]*\.py$/;

/**
 * The bootstrap rule applies to `tmp_scripts/` only.
 *
 * The skill contradicted itself here: its opening line claims the rules cover
 * "anything under scripts/", while the section below it says ad-hoc scripts go
 * in tmp_scripts/ and `scripts/` is for tracked utility code that ships. Both
 * files in the context repo's scripts/ are the second kind — an OAuth setup CLI
 * and a milestone checker, each a real standalone program with an argparse and
 * a __main__ guard that are correct for what they are. Blocking a phase from
 * touching those would be enforcing a rule the skill does not actually make.
 *
 * The email rule has no such ambiguity and applies to both directories.
 */
const SHELL_EXEC_DIR = /(^|\/)tmp_scripts\/[^/]*\.py$/;

const AST_SCAN = `
import ast, re, sys

try:
    tree = ast.parse(open(sys.argv[1], "rb").read())
except (SyntaxError, ValueError):
    sys.exit(0)

def emit(kind, line, detail):
    print("%s\\t%d\\t%s" % (kind, line, detail))

# --- bootstrap -----------------------------------------------------------
check_bootstrap = len(sys.argv) > 2 and sys.argv[2] == "1"
defines_main = False
calls_main = False

for node in ast.walk(tree) if check_bootstrap else []:
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
        for name in names:
            if name and name.split(".")[0] == "argparse":
                emit("BOOTSTRAP", node.lineno, "imports argparse - a script takes no CLI args")

    if isinstance(node, ast.If):
        test = node.test
        if (isinstance(test, ast.Compare) and isinstance(test.left, ast.Name)
                and test.left.id == "__name__"):
            emit("BOOTSTRAP", node.lineno, 'if __name__ == "__main__": - there is no __main__, the file is exec\\'d')

    if isinstance(node, ast.Attribute) and node.attr == "argv":
        if isinstance(node.value, ast.Name) and node.value.id == "sys":
            emit("BOOTSTRAP", node.lineno, "reads sys.argv - use uppercase scope constants instead")

    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        func = node.func
        if func.attr == "setup" and isinstance(func.value, ast.Name) and func.value.id == "django":
            emit("BOOTSTRAP", node.lineno, "django.setup() - the shell already did this")
        if func.attr == "insert" and isinstance(func.value, ast.Attribute) and func.value.attr == "path":
            if isinstance(func.value.value, ast.Name) and func.value.value.id == "sys":
                emit("BOOTSTRAP", node.lineno, "sys.path.insert() - the project root is already importable")
        if func.attr == "setdefault" and node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and first.value == "DJANGO_SETTINGS_MODULE":
                emit("BOOTSTRAP", node.lineno, "sets DJANGO_SETTINGS_MODULE - Django is already configured")

for node in tree.body if check_bootstrap else []:
    if isinstance(node, ast.FunctionDef) and node.name == "main":
        defines_main = True
        main_line = node.lineno
    if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name) and node.value.func.id == "main"):
        calls_main = True

if defines_main and calls_main:
    emit("BOOTSTRAP", main_line, "def main() plus a main() call - put the logic at module level")

# --- fabricated emails ---------------------------------------------------
PLACEHOLDER = re.compile(
    r"@(example\\.(invalid|org|net)|test(\\.[a-z]+)?|localhost|local|invalid|fake\\.[a-z]+|dummy\\.[a-z]+)\\b",
    re.I)
FABRICATED_LOCAL = re.compile(r"(test|seed|sentinel|dummy|fake|placeholder)[^@\\s]*@([a-z0-9.-]+)", re.I)

def literal(node):
    """A string constant, or an f-string flattened with {} standing in for the holes."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                out.append(part.value)
            else:
                out.append("{}")
        return "".join(out)
    return None

for node in ast.walk(tree):
    text = literal(node)
    if not text or "@" not in text:
        continue
    hit = PLACEHOLDER.search(text)
    if hit:
        emit("EMAIL", node.lineno, "%s uses a placeholder domain that is not example.com" % text.strip()[:70])
        continue
    fab = FABRICATED_LOCAL.search(text)
    if fab and not fab.group(2).lower().rstrip(".").endswith("example.com"):
        emit("EMAIL", node.lineno,
             "%s names itself a test/seed but sits on %s" % (text.strip()[:70], fab.group(2)))
`;

function runPython(file, bootstrap) {
  return new Promise((resolve) => {
    execFile('python3', ['-c', AST_SCAN, file, bootstrap ? '1' : ''], { timeout: 15_000 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(null);
      return resolve(String(stdout || '').trim());
    });
  });
}

function describe(scan) {
  const bootstrap = [];
  const emails = [];
  for (const line of (scan || '').split('\n')) {
    if (!line.trim()) continue;
    const [kind, lineno, detail] = line.split('\t');
    if (kind === 'BOOTSTRAP') bootstrap.push(`  line ${lineno}: ${detail}`);
    else if (kind === 'EMAIL') emails.push(`  line ${lineno}: ${detail}`);
  }

  const problems = [];
  if (bootstrap.length) {
    problems.push(
      `bootstrap boilerplate — this script is run as \`python manage.py shell < <file>\`, ` +
      `or pasted straight into a shell, so Django is already configured:\n${bootstrap.join('\n')}\n` +
      'Delete these. Put the logic at module level and the scope in uppercase constants at ' +
      'the top. None of this fails loudly when it is wrong: a __main__ guard simply never ' +
      'fires, and the script reads as having had nothing to do.',
    );
  }
  if (emails.length) {
    problems.push(
      `fabricated email on the wrong domain:\n${emails.join('\n')}\n` +
      '@example.com is reserved by RFC 2606 and will never deliver, and standardising on it ' +
      'is what makes every seeded row findable by one grep later.\n' +
      'If this address belongs to a REAL person the script must provision, that is the one ' +
      'case this rule does not cover — keep the real address and say so in the docstring.',
    );
  }
  return problems;
}

async function main() {
  const data = C.readInput();
  if (!WRITE_TOOLS.has(data.tool_name || '')) return C.allow();
  if ((data.tool_response || {}).success === false) return C.allow();

  const input = data.tool_input || {};
  const target = input.file_path || input.notebook_path || input.path || '';
  const worktree = process.env.ONESHOT_WORKTREE || '';

  if (!SCRIPT_DIR.test(target)) return C.allow();
  if (!worktree || !C.isInside(target, worktree)) return C.allow();
  if (!fs.existsSync(target)) return C.allow();

  const scan = await runPython(target, SHELL_EXEC_DIR.test(target));
  if (scan === null) return C.allow();

  const problems = describe(scan);
  if (!problems.length) return C.allow();

  C.event('script_standards_block', { target, count: problems.length });
  return C.postBlock(
    `${target} breaks this repo's script standards:\n\n${problems.join('\n\n')}\n\n` +
    'The `script-writing-standards` skill has the required shape and the reasoning.',
  );
}

main().catch((err) => {
  C.logFailure('script-standards', err);
  C.allow();
});
