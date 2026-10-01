#!/usr/bin/env node
'use strict';
/**
 * PostToolUse: the three decidable migration rules, on every migration write.
 *
 *   1. `_base_manager` inside RunPython — never `.objects`, never a custom
 *      manager.
 *   2. No schema operation and RunPython in the same file.
 *   3. max_migration.txt names the app's highest-numbered migration.
 *
 * WHY THIS IS A HOOK. Of everything django-migration-standards asks for, these
 * three are the ones a file answers on its own — and the ones whose cost is
 * paid long after the mistake. `.objects` on a historical model silently skips
 * every soft-deleted row, so the migration reports success and the data is
 * wrong; a stale max_migration.txt fails `manage.py check` with dlm.E004 for
 * whoever pulls next, not for the author.
 *
 * WHAT THIS IS NOT. context/scripts/migration_check_hook.py already guards
 * one-migration-per-task and models.py-without-a-migration, and it is wired in
 * context/settings.json — which claudedir deliberately does not link, so it has
 * never run for a phase. This does not replace it or reimplement it; it covers
 * three rules that script does not, in the place Oneshot's guards actually run
 * from. Merging the two is worth doing and is a bigger question than this hook.
 *
 * py-lint.cjs skips migrations, because both rc files exclude them. This is
 * what stands in their place for that directory.
 *
 * The AST work is done by Python rather than a regex: `.objects` inside a
 * string, an operation list built across several lines, and a RunPython passed
 * by reference are all things a regex gets wrong, and a wrong block here costs
 * more than the rule saves.
 *
 * Fail-open, like every guard here.
 */
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const NUMBERED = /^(\d{4})_.*\.py$/;

/**
 * Squashed migrations are exempt from the schema/data split.
 *
 * `squashmigrations` concatenates whatever the history contained, so a squash
 * mixing CreateModel with a RunPython is the tool working correctly, not an
 * author ignoring the rule — the rule governs what you write. 15 of this
 * repo's 23 squashes would otherwise be permanent findings.
 *
 * The filename is the marker because `replaces` does not survive: it is
 * stripped once the migrations it replaced are deleted, and not one squash in
 * this repo still declares it. Both are checked anyway — a fresh squash has
 * `replaces` and may not have been renamed yet.
 */
const SQUASHED_NAME = /_squashed_/;

/**
 * Operations that change the schema. RunSQL is deliberately absent: it can be
 * either, the skill does not name it, and guessing would block a file the
 * standard permits.
 */
const AST_SCAN = `
import ast, sys

SCHEMA_OPS = {
    "CreateModel", "DeleteModel", "AddField", "RemoveField", "AlterField",
    "RenameField", "RenameModel", "AlterModelOptions", "AlterModelTable",
    "AddIndex", "RemoveIndex", "AddConstraint", "RemoveConstraint",
    "AlterUniqueTogether", "AlterIndexTogether", "AlterOrderWithRespectTo",
}

try:
    tree = ast.parse(open(sys.argv[1], "rb").read())
except (SyntaxError, ValueError):
    sys.exit(0)

has_runpython = False
schema = []
managers = []

for node in ast.walk(tree):
    if isinstance(node, ast.Attribute):
        if node.attr == "RunPython":
            has_runpython = True
        elif node.attr in SCHEMA_OPS:
            schema.append((node.lineno, node.attr))
        elif node.attr == "objects" or node.attr.endswith("_objects"):
            managers.append((node.lineno, node.attr))

squashed = any(
    isinstance(node, ast.Assign)
    and any(getattr(t, "id", "") == "replaces" for t in node.targets)
    for node in ast.walk(tree)
)

if has_runpython and schema and not squashed:
    ops = sorted({op for _, op in schema})
    print("SPLIT\\t%d\\t%s" % (schema[0][0], ", ".join(ops)))

if has_runpython:
    for line, attr in managers:
        print("MANAGER\\t%d\\t%s" % (line, attr))
`;

function runPython(file) {
  return new Promise((resolve) => {
    execFile('python3', ['-c', AST_SCAN, file], { timeout: 15_000 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(null);
      return resolve(String(stdout || '').trim());
    });
  });
}

/**
 * max_migration.txt must name the highest-numbered migration in the directory.
 *
 * Checking against the directory rather than against the file just written is
 * what makes this correct when a task adds two migrations: the skill says the
 * pointer goes to the highest-numbered one only, so writing the earlier of the
 * two must not demand that it point at that file.
 */
function checkMaxMigration(target) {
  const dir = path.dirname(target);
  const pointer = path.join(dir, 'max_migration.txt');
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }

  const numbered = entries.filter((name) => NUMBERED.test(name)).sort();
  if (!numbered.length) return null;
  const highest = numbered[numbered.length - 1].replace(/\.py$/, '');

  if (!fs.existsSync(pointer)) {
    return `max_migration.txt is missing from ${dir}.\n` +
      `django-linear-migrations requires it — \`manage.py check\` fails with dlm.E004 ` +
      `without it. Create it containing exactly one line: ${highest}`;
  }

  let current;
  try { current = fs.readFileSync(pointer, 'utf8').trim(); } catch { return null; }
  if (current === highest) return null;

  return `max_migration.txt still says \`${current}\`, but the newest migration in ` +
    `this app is \`${highest}\`.\nUpdate it to one line: ${highest}\n` +
    '(If a task adds several migrations to one app, it points at the ' +
    'highest-numbered one only.)';
}

function describe(scan, target) {
  const problems = [];
  const managers = [];
  for (const line of (scan || '').split('\n')) {
    const [kind, lineno, detail] = line.split('\t');
    if (kind === 'SPLIT') {
      problems.push(
        `this file mixes a schema change and a data change: ${detail} alongside ` +
        `RunPython (first schema op at line ${lineno}).\n` +
        'Split it into two files — schema first, data second. A combined file ' +
        'makes rollbacks partial and can leave the table half-migrated.',
      );
    } else if (kind === 'MANAGER') {
      managers.push(`  line ${lineno}: .${detail}`);
    }
  }
  if (managers.length) {
    problems.push(
      `RunPython queries through a manager that historical models do not reliably ` +
      `expose:\n${managers.join('\n')}\n` +
      'Use `_base_manager` instead. `apps.get_model()` does not carry custom managers ' +
      "unless they set `use_in_migrations = True` (this repo never does), and the " +
      'default manager can filter — `active_objects` silently skips every soft-deleted ' +
      'row, so the migration reports success having missed them.\n' +
      `Assign the model as \`_<ModelName> = apps.get_model(...)\` and query ` +
      '`_<ModelName>._base_manager`.',
    );
  }
  const pointer = checkMaxMigration(target);
  if (pointer) problems.push(pointer);
  return problems;
}

async function main() {
  const data = C.readInput();
  if (!WRITE_TOOLS.has(data.tool_name || '')) return C.allow();
  if ((data.tool_response || {}).success === false) return C.allow();

  const input = data.tool_input || {};
  const target = input.file_path || input.notebook_path || input.path || '';
  const worktree = process.env.ONESHOT_WORKTREE || '';
  const base = path.basename(target);

  if (!/(^|\/)migrations\/[^/]+\.py$/.test(target)) return C.allow();
  if (base === '__init__.py') return C.allow();
  if (SQUASHED_NAME.test(base)) return C.allow();
  if (!worktree || !C.isInside(target, worktree)) return C.allow();
  if (!fs.existsSync(target)) return C.allow();

  const scan = await runPython(target);
  if (scan === null) return C.allow();

  const problems = describe(scan, target);
  if (!problems.length) return C.allow();

  C.event('migration_standards_block', { target, count: problems.length });
  return C.postBlock(
    `${target} breaks this repo's migration standards:\n\n${problems.join('\n\n')}\n\n` +
    'The `django-migration-standards` skill has the reasoning and the verification ' +
    'protocol to run after fixing.',
  );
}

main().catch((err) => {
  C.logFailure('migration-standards', err);
  C.allow();
});
