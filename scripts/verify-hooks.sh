#!/usr/bin/env bash
#
# Offline hook test suite. Feeds each guard a synthetic PreToolUse payload and
# asserts it denies what it must deny and allows what it must allow.
#
# Runs with no network, no GitLab, no Claude session — which is the point: the
# guards are the last line of defence in a fully autonomous pipeline, so they
# have to be testable without one.
#
#   bash scripts/verify-hooks.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${ONESHOT_NODE:-node}"
PASS=0
FAIL=0
SKIP=0

# Every hook self-gates on ONESHOT_PHASE; without it they exit 0 immediately.
export ONESHOT_PHASE="implement"
export ONESHOT_HOME="$ROOT"
export ONESHOT_RUN_ID="verify-$$"
export ONESHOT_TICKET="0"
export ONESHOT_BRANCH="oneshot/ticket-0-verify"
export ONESHOT_WORKTREE="/tmp/oneshot-verify-wt"
export ONESHOT_WRITE_SCOPES="/tmp/oneshot-verify-wt:$ROOT/state/runs/0"
# Expand a leading ~ ourselves. .env carries `CONTEXT_REPO=~/Documents/erp`, and a
# tilde arriving through the environment is a literal character, not $HOME — which
# silently turned the symlink-escape test into a SKIP when doctor ran this suite.
CONTEXT_REPO="${CONTEXT_REPO:-$HOME/Documents/erp}"
export CONTEXT_REPO="${CONTEXT_REPO/#\~/$HOME}"

mkdir -p "$ONESHOT_WORKTREE"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

# skip <label> <why> — a case that cannot be judged here is neither a pass nor a fail.
skip() { yellow "  SKIP  $1 ($2)"; SKIP=$((SKIP+1)); }

# run <hook> <json>  -> prints hook stdout
run() { printf '%s' "$2" | "$NODE" "$ROOT/hooks/$1" 2>/dev/null; }

# expect_deny <label> <hook> <json>
expect_deny() {
    local out; out="$(run "$2" "$3")"
    if printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then
        green "  PASS  deny: $1"; PASS=$((PASS+1))
    else
        red   "  FAIL  should have DENIED: $1"; FAIL=$((FAIL+1))
    fi
}

# expect_allow <label> <hook> <json>
expect_allow() {
    local out; out="$(run "$2" "$3")"
    if [ -z "$out" ] || ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then
        green "  PASS  allow: $1"; PASS=$((PASS+1))
    else
        red   "  FAIL  should have ALLOWED: $1"; FAIL=$((FAIL+1))
    fi
}

bash_payload() {
    printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')"
}
write_payload() {
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1"
}

echo
echo "git-guard"
expect_deny  "force push"              git-guard.cjs "$(bash_payload 'git push --force origin oneshot/ticket-0-verify')"
expect_deny  "force-with-lease"        git-guard.cjs "$(bash_payload 'git push --force-with-lease origin oneshot/ticket-0-verify')"
expect_deny  "push to dev"             git-guard.cjs "$(bash_payload 'git push origin dev')"
expect_deny  "push to master"          git-guard.cjs "$(bash_payload 'git push origin master')"
expect_deny  "push to main (can_push=true on the server)" \
                                       git-guard.cjs "$(bash_payload 'git push origin main')"
expect_deny  "push to a foreign branch" git-guard.cjs "$(bash_payload 'git push origin someone-elses-branch')"
expect_deny  "delete protected branch" git-guard.cjs "$(bash_payload 'git branch -D dev')"
expect_deny  "remote set-url"          git-guard.cjs "$(bash_payload 'git remote set-url origin git@evil:x.git')"
expect_deny  "reset --hard origin/dev" git-guard.cjs "$(bash_payload 'git reset --hard origin/dev')"
expect_deny  "gh CLI"                  git-guard.cjs "$(bash_payload 'gh pr merge 12 --squash')"
expect_deny  "glab CLI"                git-guard.cjs "$(bash_payload 'glab mr merge 12')"
expect_deny  "cd into the context repo" git-guard.cjs "$(bash_payload 'cd ~/Documents/erp && git commit -am wip')"
expect_deny  "git -C into the context repo" \
                                       git-guard.cjs "$(bash_payload 'git -C /Users/'"$USER"'/Documents/erp status')"
expect_deny  "chained push to dev after a legal command" \
                                       git-guard.cjs "$(bash_payload 'git add -A && git push origin dev')"
expect_allow "push to the leased branch" \
                                       git-guard.cjs "$(bash_payload 'git push origin oneshot/ticket-0-verify')"
expect_allow "bare push from the worktree" \
                                       git-guard.cjs "$(bash_payload 'git push')"
expect_allow "commit --no-verify (husky is broken locally)" \
                                       git-guard.cjs "$(bash_payload 'git commit --no-verify -m "feat: x"')"
expect_allow "ordinary status"         git-guard.cjs "$(bash_payload 'git status --short')"
expect_allow "npm test"                git-guard.cjs "$(bash_payload 'npm test -- --watchAll=false')"

# A repo script run by absolute path is allowed; standing IN the Oneshot root is
# not. Pinning both sides stops someone "fixing" checkCwd to allow the root and
# quietly reopening a path into a live repo.
expect_allow "a repo script by absolute path" \
                                       git-guard.cjs "$(bash_payload "bash $ROOT/scripts/preflight.ts --check")"
expect_deny  "cd into the Oneshot root" \
                                       git-guard.cjs "$(bash_payload "cd $ROOT && ./scripts/preflight.ts")"

export ONESHOT_DRY_RUN=1
expect_deny  "push under DRY_RUN"      git-guard.cjs "$(bash_payload 'git push origin oneshot/ticket-0-verify')"
unset ONESHOT_DRY_RUN

# A conductor-cwd phase (recall, remediate) holds no worktree, so
# whatever repo it is standing in belongs to someone else.
SAVED_WORKTREE="$ONESHOT_WORKTREE"
unset ONESHOT_WORKTREE
expect_deny  "commit from a conductor phase" \
                                       git-guard.cjs "$(bash_payload 'git commit -am wip')"
expect_deny  "checkout -B from a conductor phase" \
                                       git-guard.cjs "$(bash_payload 'git checkout -B someone-elses-branch')"
expect_allow "log from a conductor phase" \
                                       git-guard.cjs "$(bash_payload 'git log --oneline -5')"
export ONESHOT_WORKTREE="$SAVED_WORKTREE"

# A phase that stands in the worktree without write access to it (ui-evidence,
# review, mr, …) may read it and push, never change it. A ui-evidence session once
# reverted the fix on disk with `git checkout <parent> -- <paths>` for a screenshot.
SAVED_PHASE="$ONESHOT_PHASE"; SAVED_SCOPES="$ONESHOT_WRITE_SCOPES"
export ONESHOT_PHASE="ui-evidence"
export ONESHOT_WRITE_SCOPES="$ROOT/state/runs/0:$ROOT/state/runs/0/artifacts"
expect_deny  "checkout <ref> -- <paths> from a read-only worktree phase" \
                                       git-guard.cjs "$(bash_payload 'git checkout e843ab8 -- templates/registration/base.html')"
expect_deny  "stash from a read-only worktree phase" \
                                       git-guard.cjs "$(bash_payload 'git stash')"
expect_deny  "restore from a read-only worktree phase" \
                                       git-guard.cjs "$(bash_payload 'git restore --source=origin/dev templates/')"
expect_deny  "commit from a read-only worktree phase" \
                                       git-guard.cjs "$(bash_payload 'git commit -am wip')"
expect_allow "show a base-branch file from a read-only worktree phase" \
                                       git-guard.cjs "$(bash_payload 'git show origin/dev:templates/registration/base.html')"
expect_allow "diff against base from a read-only worktree phase" \
                                       git-guard.cjs "$(bash_payload 'git diff origin/dev...HEAD --stat')"
export ONESHOT_PHASE="mr"
expect_allow "push the leased branch from mr (read-only worktree)" \
                                       git-guard.cjs "$(bash_payload 'git push -u origin oneshot/ticket-0-verify')"
export ONESHOT_PHASE="$SAVED_PHASE"; export ONESHOT_WRITE_SCOPES="$SAVED_SCOPES"
expect_allow "checkout from implement, which may write the worktree" \
                                       git-guard.cjs "$(bash_payload 'git checkout -- frontend/src/x.js')"

echo
echo "write-scope"
expect_deny  "hooks/ (its own guards)" write-scope.cjs "$(write_payload "$ROOT/hooks/git-guard.cjs")"
expect_deny  "config/"                 write-scope.cjs "$(write_payload "$ROOT/config/project.json")"
expect_deny  "src/"                    write-scope.cjs "$(write_payload "$ROOT/src/index.ts")"
expect_deny  "~/.claude/settings.json" write-scope.cjs "$(write_payload "$HOME/.claude/settings.json")"
expect_deny  "context repo directly"   write-scope.cjs "$(write_payload "$CONTEXT_REPO/apps/leaves/models.py")"
expect_deny  "vendored context/ skills" write-scope.cjs "$(write_payload "$ROOT/context/skills/erp-code-review/SKILL.md")"
expect_deny  "outside every scope"     write-scope.cjs "$(write_payload "/tmp/somewhere-else/x.py")"
expect_allow "inside the worktree"     write-scope.cjs "$(write_payload "$ONESHOT_WORKTREE/apps/leaves/models.py")"
expect_allow "inside the run dir"      write-scope.cjs "$(write_payload "$ROOT/state/runs/0/plan.json")"

# Empty scopes means the conductor's expansion produced nothing. That is a
# configuration fault, and a configuration fault must not silently upgrade a
# phase to unrestricted writes.
SAVED_SCOPES="$ONESHOT_WRITE_SCOPES"
export ONESHOT_WRITE_SCOPES=""
expect_deny  "phase with no scopes at all" \
                                       write-scope.cjs "$(write_payload "$ONESHOT_WORKTREE/apps/leaves/models.py")"
export ONESHOT_WRITE_SCOPES="$SAVED_SCOPES"

# The symlink case: composition links each skill from a worktree's .claude into
# this repo's vendored context/, so a prefix-only check would accept a write
# through that link and let a phase rewrite its own governing skills.
if command -v ln >/dev/null 2>&1; then
    rm -rf "$ONESHOT_WORKTREE/.claude"
    if [ -d "$ROOT/context/skills" ]; then
        mkdir -p "$ONESHOT_WORKTREE/.claude/skills"
        ln -s "$ROOT/context/skills/erp-code-review" \
            "$ONESHOT_WORKTREE/.claude/skills/erp-code-review" 2>/dev/null
        expect_deny "symlinked skill into vendored context/ (realpath escape)" \
            write-scope.cjs "$(write_payload "$ONESHOT_WORKTREE/.claude/skills/erp-code-review/SKILL.md")"
    else
        # A silent skip here is worse than a failure: this is the test for the
        # one escape that lets a phase rewrite its own governing skills.
        red "  FAIL  vendored-context symlink test could not run — $ROOT/context/skills not present"
        FAIL=$((FAIL+1))
    fi
fi

echo
echo "pause-check"
mkdir -p "$ROOT/state"
touch "$ROOT/state/PAUSE"
expect_deny  "Bash while paused"       pause-check.cjs "$(bash_payload 'npm test')"
expect_deny  "Write while paused"      pause-check.cjs "$(write_payload "$ONESHOT_WORKTREE/x.py")"
expect_allow "Read while paused"       pause-check.cjs '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}'
rm -f "$ROOT/state/PAUSE"
expect_allow "Bash when not paused"    pause-check.cjs "$(bash_payload 'npm test')"

echo
echo "mr-gate"
mr_payload() {
    printf '{"tool_name":"%s","tool_input":%s}' "$1" "$2"
}

expect_deny  "conventional-commit prefix in title" mr-gate.cjs \
    "$(mr_payload mcp__gitlab__create_merge_request '{"title":"chore: remove unused celery task","description":"[closes https://gitlab.example.com/g/p/-/issues/1]"}')"
expect_deny  "create with no closes line"          mr-gate.cjs \
    "$(mr_payload mcp__gitlab__create_merge_request '{"title":"Remove Unused Celery Task","description":"Does a thing."}')"
expect_allow "plain title plus closes line"        mr-gate.cjs \
    "$(mr_payload mcp__gitlab__create_merge_request '{"title":"Remove Unused Celery Task","description":"Does a thing.\n\n[closes https://gitlab.example.com/g/p/-/issues/1]"}')"
expect_allow "update that touches neither field"   mr-gate.cjs \
    "$(mr_payload mcp__gitlab__update_merge_request '{"labels":"ready"}')"
expect_deny  "update sending a closes-less body"   mr-gate.cjs \
    "$(mr_payload mcp__gitlab__update_merge_request '{"description":"Rewritten body."}')"

echo
echo "secret-guard"
expect_deny  "Read of this repo's .env"        secret-guard.cjs \
    "$(printf '{"tool_name":"Read","tool_input":{"file_path":"%s/.env"}}' "$ROOT")"
expect_deny  "cat of this repo's .env"         secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"cat .env"}}' "$ROOT")"
expect_deny  "grep TOKEN by absolute path"     secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"grep TOKEN %s/.env"}}' "$ROOT")"
expect_allow "the work repo's own .env"        secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"cat .env"}}' "$ONESHOT_WORKTREE")"
expect_allow "grepping the source for a name"  secret-guard.cjs \
    '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"grep -rn GITLAB_TOKEN src/"}}'
expect_allow "reading an ordinary file"        secret-guard.cjs \
    '{"tool_name":"Read","tool_input":{"file_path":"/tmp/notes.md"}}'
# The shell expands these; the guard has to as well. HOME is pointed at the
# repo's parent so a ~ path can name it wherever this checkout lives.
expect_deny  "cat \$ONESHOT_HOME/.env"          secret-guard.cjs \
    '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"cat $ONESHOT_HOME/.env"}}'
expect_deny  "cat \${ONESHOT_HOME}/.env"        secret-guard.cjs \
    '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"cat \"${ONESHOT_HOME}/.env\""}}'
HOME="$(dirname "$ROOT")" expect_deny "cat by a ~ path" secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"cat ~/%s/.env"}}' "$(basename "$ROOT")")"
HOME="$(dirname "$ROOT")" expect_deny "grep by a \$HOME path" secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"grep TOKEN $HOME/%s/.env"}}' "$(basename "$ROOT")")"
expect_deny  "Grep tool on this repo's .env"    secret-guard.cjs \
    "$(printf '{"tool_name":"Grep","tool_input":{"pattern":"TOKEN","path":"%s/.env","output_mode":"content"}}' "$ROOT")"
# A redirect write is as much a hazard as sed -i: one > blanks GITLAB_TOKEN.
expect_deny  "> truncating this repo's .env"   secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"printf %%s GITLAB_TOKEN=x > %s/.env"}}' "$ROOT")"
expect_deny  ">> appending to this repo's .env" secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo GITLAB_TOKEN=x >> .env"}}' "$ROOT")"
expect_deny  "tee into this repo's .env"       secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo A=1 | tee -a .env"}}' "$ROOT")"
# .env.example is the tracked list of variables, and it holds no secrets.
expect_allow "cat .env.example by bare name"   secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"cat .env.example"}}' "$ROOT")"
expect_allow "cat .env.example by absolute path" secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"cat %s/.env.example"}}' "$ROOT")"
expect_allow "cat .env.local and .env.sample"  secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"cat .env.local .env.sample"}}' "$ROOT")"
expect_allow "redirect out of .env.example"    secret-guard.cjs \
    "$(printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":"grep -c = < .env.example > /tmp/n"}}' "$ROOT")"

# PostToolUse hooks answer with {"decision":"block"}
# rather than a permissionDecision — the allow/deny helpers cannot read it.
expect_block() {
    local out; out="$(run "$2" "$3")"
    if printf '%s' "$out" | grep -q '"decision":"block"'; then
        green "  PASS  block: $1"; PASS=$((PASS+1))
    else
        red   "  FAIL  should have BLOCKED: $1"; FAIL=$((FAIL+1))
    fi
}

expect_clean() {
    local out; out="$(run "$2" "$3")"
    if [ -z "$out" ] || ! printf '%s' "$out" | grep -q '"decision":"block"'; then
        green "  PASS  clean: $1"; PASS=$((PASS+1))
    else
        red   "  FAIL  should have PASSED: $1"; FAIL=$((FAIL+1))
    fi
}

py_payload() {
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"tool_response":{"success":true}}' "$1"
}
scr_payload() { py_payload "$@"; }

mig_payload() {
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"tool_response":{"success":true}}' "$1"
}

echo
echo "migration-standards"
MIG="$ONESHOT_WORKTREE/apps/demo/migrations"
mkdir -p "$MIG"

cat > "$MIG/0001_good_data.py" <<'MIGEOF'
"""Backfill the demo flag."""

from django.db import migrations


def backfill(apps, schema_editor):
    _Thing = apps.get_model("demo", "Thing")
    for row in _Thing._base_manager.all():
        row.save()


class Migration(migrations.Migration):
    dependencies = []
    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
MIGEOF

cat > "$MIG/0002_wrong_manager.py" <<'MIGEOF'
"""Backfill through the wrong manager."""

from django.db import migrations


def backfill(apps, schema_editor):
    _Thing = apps.get_model("demo", "Thing")
    for row in _Thing.active_objects.all():
        row.save()


class Migration(migrations.Migration):
    dependencies = []
    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
MIGEOF

cat > "$MIG/0003_mixed.py" <<'MIGEOF'
"""Schema and data in one file."""

import django.db.models
from django.db import migrations, models


def backfill(apps, schema_editor):
    _Thing = apps.get_model("demo", "Thing")
    _Thing._base_manager.all().update(flag=True)


class Migration(migrations.Migration):
    dependencies = []
    operations = [
        migrations.AddField("thing", "flag", models.BooleanField(default=False)),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
MIGEOF

cat > "$MIG/0004_initial_schema_squashed_0003_mixed.py" <<'MIGEOF'
"""A squash concatenates whatever history held."""

from django.db import migrations, models


def backfill(apps, schema_editor):
    _Thing = apps.get_model("demo", "Thing")
    _Thing._base_manager.all().update(flag=True)


class Migration(migrations.Migration):
    dependencies = []
    operations = [
        migrations.AddField("thing", "flag", models.BooleanField(default=False)),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
MIGEOF

cat > "$MIG/0005_schema_only.py" <<'MIGEOF'
# Generated by Django 4.2 on 2026-09-24 10:00

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = []
    operations = [
        migrations.AddField("thing", "label", models.CharField(max_length=10)),
    ]
MIGEOF

# The pointer names the highest-numbered file, so every case above is judged on
# its own content rather than on a stale max_migration.txt.
printf '0005_schema_only\n' > "$MIG/max_migration.txt"

expect_clean "_base_manager in RunPython"   migration-standards.cjs "$(mig_payload "$MIG/0001_good_data.py")"
expect_block "active_objects in RunPython"  migration-standards.cjs "$(mig_payload "$MIG/0002_wrong_manager.py")"
expect_block "schema and RunPython mixed"   migration-standards.cjs "$(mig_payload "$MIG/0003_mixed.py")"
expect_clean "squash may mix the two"       migration-standards.cjs "$(mig_payload "$MIG/0004_initial_schema_squashed_0003_mixed.py")"
expect_clean "schema-only migration"        migration-standards.cjs "$(mig_payload "$MIG/0005_schema_only.py")"

printf '0004_stale\n' > "$MIG/max_migration.txt"
expect_block "stale max_migration.txt"      migration-standards.cjs "$(mig_payload "$MIG/0005_schema_only.py")"
rm -f "$MIG/max_migration.txt"
expect_block "missing max_migration.txt"    migration-standards.cjs "$(mig_payload "$MIG/0005_schema_only.py")"

expect_clean "non-migration python file"    migration-standards.cjs "$(mig_payload "$ONESHOT_WORKTREE/apps/demo/models.py")"

echo
echo "script-standards"
mkdir -p "$ONESHOT_WORKTREE/tmp_scripts" "$ONESHOT_WORKTREE/scripts"

cat > "$ONESHOT_WORKTREE/tmp_scripts/good.py" <<'SCREOF'
"""Seed a handful of demo people. Run: python manage.py shell < tmp_scripts/good.py"""

from apps.core.models import Person

# ===== Scope =====================================
HOW_MANY = 3

for index in range(HOW_MANY):
    Person.objects.create(email="test-seed-%d@example.com" % index)
SCREOF

cat > "$ONESHOT_WORKTREE/tmp_scripts/bootstrapped.py" <<'SCREOF'
"""A script that sets Django up for itself."""

import argparse
import os
import sys

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "hrdb.settings")
sys.path.insert(0, ".")
django.setup()


def main():
    print(sys.argv)


if __name__ == "__main__":
    main()
SCREOF

cat > "$ONESHOT_WORKTREE/tmp_scripts/bad_email.py" <<'SCREOF'
"""Seed people on a domain that is not example.com."""

from apps.core.models import Person

Person.objects.create(email="test-seed-1@example.invalid")
Person.objects.create(email=f"seed-{2}@arbisoft.com")
SCREOF

cat > "$ONESHOT_WORKTREE/tmp_scripts/real_user.py" <<'SCREOF'
"""Provision the missing User row for a real employee, address supplied by the operator."""

from apps.core.models import Person

# ===== Scope =====================================
REAL_EMAIL = "ayesha.khan@arbisoft.com"

Person.objects.create(email=REAL_EMAIL)
SCREOF

# "test" mid-word is not a fabrication marker: the check reads the start of the local part.
cat > "$ONESHOT_WORKTREE/tmp_scripts/mid_word.py" <<'SCREOF'
"""Point the digest at the real mailboxes, addresses supplied by the operator."""

from apps.core.models import Person

Person.objects.create(email="latest@arbisoft.com")
Person.objects.create(email="contest.team@arbisoft.com")
SCREOF

# The same file in scripts/: tracked utility code, where a CLI shape is correct.
cp "$ONESHOT_WORKTREE/tmp_scripts/bootstrapped.py" "$ONESHOT_WORKTREE/scripts/cli_tool.py"
cp "$ONESHOT_WORKTREE/tmp_scripts/bad_email.py" "$ONESHOT_WORKTREE/scripts/seeder.py"

expect_clean "shell-shaped script"          script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/tmp_scripts/good.py")"
expect_block "bootstrap in tmp_scripts"     script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/tmp_scripts/bootstrapped.py")"
expect_block "fabricated email off-domain"  script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/tmp_scripts/bad_email.py")"
expect_clean "a real person's real address" script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/tmp_scripts/real_user.py")"
expect_clean "test mid-word in local part"  script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/tmp_scripts/mid_word.py")"
expect_clean "CLI shape in tracked scripts" script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/scripts/cli_tool.py")"
expect_block "fabricated email in scripts"  script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/scripts/seeder.py")"
expect_clean "app code is not a script"     script-standards.cjs "$(scr_payload "$ONESHOT_WORKTREE/apps/core/models.py")"

echo
echo "py-lint"
mkdir -p "$ONESHOT_WORKTREE/apps/demo/migrations"

cat > "$ONESHOT_WORKTREE/apps/demo/clean.py" <<'PYEOF'
"""A module that satisfies both linters."""


def add_totals(first_total, second_total):
    """Return the sum of two totals."""
    return first_total + second_total
PYEOF

cat > "$ONESHOT_WORKTREE/apps/demo/commented.py" <<'PYEOF'
"""A module whose only sin is an inline comment."""


def add_totals(first_total, second_total):
    """Return the sum of two totals."""
    # add them up
    return first_total + second_total
PYEOF

cat > "$ONESHOT_WORKTREE/apps/demo/allowed_comment.py" <<'PYEOF'
"""A module whose only comment is an affirmed disable."""


def add_totals(first_total, second_total):  # pylint: disable=invalid-name
    """Return the sum of two totals."""
    return first_total + second_total
PYEOF

cp "$ONESHOT_WORKTREE/apps/demo/commented.py" "$ONESHOT_WORKTREE/apps/demo/migrations/0001_initial.py"

expect_block "inline comment"            py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/commented.py")"
# Without both linters on PATH these two pass without either one running,
# which would count a hook that never linted anything as a pass.
if command -v flake8 >/dev/null && command -v pylint >/dev/null; then
    expect_clean "clean file"              py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/clean.py")"
    expect_clean "affirmed pylint disable" py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/allowed_comment.py")"
else
    skip "clean file" "flake8/pylint not on PATH"
    skip "affirmed pylint disable" "flake8/pylint not on PATH"
fi
expect_clean "migration is exempt"       py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/migrations/0001_initial.py")"
expect_clean "non-python file"           py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/notes.md")"
expect_clean "python outside worktree"   py-lint.cjs "$(py_payload "/tmp/oneshot-verify-outside.py")"
expect_clean "failed write is not linted" py-lint.cjs "$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"tool_response":{"success":false}}' "$ONESHOT_WORKTREE/apps/demo/commented.py")"

# From here the linters are shims in the worktree's venv/bin, which the hook
# prefers over PATH: each case needs an exact exit code and output, not a
# real linter's opinion of the file.
SHIMS="$ONESHOT_WORKTREE/venv/bin"
mkdir -p "$SHIMS"
# shim <linter> <body>
shim() { printf '#!/bin/sh\n%s\n' "$2" > "$SHIMS/$1"; chmod +x "$SHIMS/$1"; }
shim pylint 'exit 0'

shim flake8 'echo 0; exit 0'
expect_clean "flake8 count=True prints 0 on a clean file" py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/clean.py")"
shim flake8 'echo "$1:1:1: E999 finding"; echo 1; exit 1'
expect_block "flake8 finding (exit 1, stdout)" py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/clean.py")"
shim flake8 "echo \"ImportError: cannot import name 'flake8_docstrings'\" >&2; exit 1"
expect_clean "flake8 crash is not a finding" py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/clean.py")"
shim flake8 'exit 0'
shim pylint 'echo "usage: bad option" >&2; exit 32'
expect_clean "pylint usage error is not a finding" py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/clean.py")"
shim pylint 'exit 0'

cat > "$ONESHOT_WORKTREE/apps/demo/pragma.py" <<'PYEOF'
"""A module whose only comment is a coverage pragma."""


def add_totals(first_total, second_total):  # pragma: no cover
    """Return the sum of two totals."""
    return first_total + second_total
PYEOF
expect_clean "coverage pragma"           py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/pragma.py")"

# edit_payload <file> <old_string> <new_string>
edit_payload() {
    printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","old_string":%s,"new_string":%s},"tool_response":{"success":true}}' \
        "$1" "$(printf '%s' "$2" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" \
        "$(printf '%s' "$3" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')"
}
expect_clean "Edit leaves a legacy comment alone" py-lint.cjs \
    "$(edit_payload "$ONESHOT_WORKTREE/apps/demo/commented.py" '    return second_total + first_total' '    return first_total + second_total')"
expect_block "Edit that adds a comment" py-lint.cjs \
    "$(edit_payload "$ONESHOT_WORKTREE/apps/demo/commented.py" '    return first_total + second_total' "$(printf '    # add them up\n    return first_total + second_total')")"

# A Write is judged against HEAD, so a comment already committed is not new.
git -C "$ONESHOT_WORKTREE" init -q
git -C "$ONESHOT_WORKTREE" add apps/demo/commented.py
git -C "$ONESHOT_WORKTREE" -c user.name=verify -c user.email=verify@localhost commit -qm legacy
expect_clean "Write keeps a committed comment" py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/commented.py")"
printf '    # and a new one\n' >> "$ONESHOT_WORKTREE/apps/demo/commented.py"
expect_block "Write that adds a comment" py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/commented.py")"

echo
echo "js-standards"
FE="$ONESHOT_WORKTREE/frontend/src"
mkdir -p "$FE/common/utils" "$FE/components/demo"

cat > "$FE/components/demo/Bad.js" <<'JSEOF'
import axios from "axios";

export const Row = () => <div style={{ marginLeft: 0 }}>hi</div>;
JSEOF

cat > "$FE/components/demo/Dynamic.js" <<'JSEOF'
import S from "./styles/demoStyles";

export const Row = ({ statusColor, isActive }) => (
    <div style={{ color: statusColor }}>
        <span sx={{ ...S.tab, ...isActive ? S.tabActive : {} }} />
    </div>
);
JSEOF

cat > "$FE/components/demo/Commented.js" <<'JSEOF'
const note = "we do not import axios here";

export const Row = () => <div>{note}</div>;
JSEOF

cat > "$FE/components/demo/Schema.js" <<'JSEOF'
import * as yup from "yup";

export const schema = yup.object({ name: yup.string() });
JSEOF

cat > "$FE/components/demo/Progress.js" <<'JSEOF'
export const Bar = ({ progress }) => <div style={{ width: `${progress}%` }} />;
JSEOF

cp "$FE/components/demo/Schema.js" "$FE/components/demo/formValidations.js"
cat > "$FE/common/utils/serverCalls.js" <<'JSEOF'
import axios from "axios";

export const apiGet = url => axios.get(url);
JSEOF

js_payload() {
    printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"tool_response":{"success":true}}' "$1"
}

expect_block "axios outside the allowlist"  js-standards.cjs "$(js_payload "$FE/components/demo/Bad.js")"
expect_block "yup outside formValidations"  js-standards.cjs "$(js_payload "$FE/components/demo/Schema.js")"
expect_clean "axios in serverCalls.js"      js-standards.cjs "$(js_payload "$FE/common/utils/serverCalls.js")"
expect_clean "yup in formValidations.js"    js-standards.cjs "$(js_payload "$FE/components/demo/formValidations.js")"
expect_clean "dynamic style and spread sx"  js-standards.cjs "$(js_payload "$FE/components/demo/Dynamic.js")"
expect_clean "axios named only in a string" js-standards.cjs "$(js_payload "$FE/components/demo/Commented.js")"
expect_clean "template-literal style value" js-standards.cjs "$(js_payload "$FE/components/demo/Progress.js")"

# Outside frontend/ the React rules do not apply: a root webpack.config.js may
# require axios for the dev-server proxy.
printf 'const axios = require("axios");\n' > "$ONESHOT_WORKTREE/webpack.config.js"
expect_clean "axios outside frontend/"      js-standards.cjs "$(js_payload "$ONESHOT_WORKTREE/webpack.config.js")"

# Only the lines a write added are judged, so a legacy file stays editable.
# A real repo, because a Write is diffed against HEAD.
cat > "$FE/components/demo/Legacy.js" <<'JSEOF'
export const Row = ({ n }) => (
    <div>
        <span style={{ marginLeft: 4 }} />
        <b>{n}</b>
    </div>
);
JSEOF
git -C "$ONESHOT_WORKTREE" init -q
git -C "$ONESHOT_WORKTREE" add frontend/src/components/demo/Legacy.js
git -C "$ONESHOT_WORKTREE" -c user.name=verify -c user.email=verify@localhost commit -qm legacy

edit_payload() {
    "$NODE" -e 'process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.argv[1],old_string:process.argv[2],new_string:process.argv[3]},tool_response:{success:true}}))' "$@"
}

sed -i.bak 's/<b>{n}<\/b>/<b>{n + 1}<\/b>/' "$FE/components/demo/Legacy.js"
expect_clean "Edit near a legacy inline style" \
                                            js-standards.cjs "$(edit_payload "$FE/components/demo/Legacy.js" '<b>{n}</b>' '<b>{n + 1}</b>')"
expect_clean "Write that keeps a legacy inline style" \
                                            js-standards.cjs "$(js_payload "$FE/components/demo/Legacy.js")"
sed -i.bak 's/<b>{n + 1}<\/b>/<b style={{ fontWeight: 700 }}>{n + 1}<\/b>/' "$FE/components/demo/Legacy.js"
expect_block "Edit that adds an inline style" \
                                            js-standards.cjs "$(edit_payload "$FE/components/demo/Legacy.js" '<b>{n + 1}</b>' '<b style={{ fontWeight: 700 }}>{n + 1}</b>')"
expect_block "Write that adds an inline style" \
                                            js-standards.cjs "$(js_payload "$FE/components/demo/Legacy.js")"

rm -f "$FE"/components/demo/*.bak

# ------------------------------------------------------------ automation-ready
#
# The one FAIL-CLOSED guard: every way it can fail to judge a ticket has to
# block. It is the only guard that talks to GitLab, so it gets a fixture GitLab
# on a free local port and never sees the real one. Label names come from the
# real config/project.json, because ONESHOT_HOME is this checkout.
echo
echo "automation-ready"

AR_TOKEN="verify-token-$$"
AR_PAYLOAD='{"hook_event_name":"UserPromptSubmit","session_id":"verify","transcript_path":"","cwd":"/tmp","prompt":"write the cases"}'
AR_PORT_FILE="$(mktemp "${TMPDIR:-/tmp}/oneshot-verify-gitlab.XXXXXX")"
"$NODE" -e '
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const [portFile, token] = process.argv.slice(1);
const project = require(path.join(process.env.ONESHOT_HOME, "config", "project.json"));
const { trigger: T, deployed: D } = project.automation.labels;
const L = project.labels.entry;   // the Loop: the master switch, required beside the trigger
const add = (name, at) => ({ action: "add", created_at: at, label: { name } });
const mr = (iid, state, source, target) => ({
  iid, project_id: 7, state, source_branch: source, target_branch: target,
  merged_at: state === "merged" ? "2026-01-02T10:00:00Z" : null,
  title: "fixture " + iid, web_url: "http://127.0.0.1/mr/" + iid,
});
const tickets = {
  1: { issue: { iid: 1, project_id: 7, state: "closed", labels: [L, T], updated_at: "2026-01-03T00:00:00Z" },
       events: [add(T, "2026-01-03T00:00:00Z")],
       mrs: [mr(11, "merged", "fix/x", "dev"), mr(12, "merged", "stage", "dev")] },
  2: { issue: { iid: 2, project_id: 7, state: "opened", labels: [L, T, D], updated_at: "2026-01-05T00:00:00Z" },
       events: [add(T, "2026-01-03T00:00:00Z"), add(D, "2026-01-04T00:00:00Z")],
       mrs: [mr(21, "opened", "fix/y", "dev")] },
  // Ticket 1 without the Loop: ready by both rules, switched off.
  5: { issue: { iid: 5, project_id: 7, state: "closed", labels: [T], updated_at: "2026-01-03T00:00:00Z" },
       events: [add(T, "2026-01-03T00:00:00Z")],
       mrs: [mr(51, "merged", "fix/z", "dev")] },
  // Ticket 2 without the Loop: every reason at once.
  6: { issue: { iid: 6, project_id: 7, state: "opened", labels: [T, D], updated_at: "2026-01-05T00:00:00Z" },
       events: [add(T, "2026-01-03T00:00:00Z"), add(D, "2026-01-04T00:00:00Z")],
       mrs: [mr(61, "opened", "fix/w", "dev")] },
};
const server = http.createServer((req, res) => {
  const send = (status, body, headers) => {
    res.writeHead(status, { "Content-Type": "application/json", ...(headers || {}) });
    res.end(JSON.stringify(body));
  };
  const m = /^\/api\/v4\/projects\/acme%2Ferp\/issues\/(\d+)(\/resource_label_events|\/related_merge_requests)?(\?|$)/
    .exec(req.url);
  if (!m) return send(404, { message: "404 Not Found" });
  const iid = Number(m[1]);
  if (iid === 3) return send(500, { message: "500 Internal Server Error" });
  if (iid === 4 || req.headers["private-token"] !== token) return send(401, { message: "401 Unauthorized" });
  const t = tickets[iid];
  if (!t) return send(404, { message: "404 Not Found" });
  if (m[2] === "/resource_label_events") return send(200, t.events, { "X-Total-Pages": "1" });
  if (m[2] === "/related_merge_requests") return send(200, t.mrs);
  return send(200, t.issue);
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
// A fixture orphaned by an interrupted run must not outlive it for long.
setTimeout(() => process.exit(0), 120000);
' "$AR_PORT_FILE" "$AR_TOKEN" &
AR_PID=$!
for _ in $(seq 1 50); do [ -s "$AR_PORT_FILE" ] && break; sleep 0.1; done
AR_PORT="$(cat "$AR_PORT_FILE" 2>/dev/null || true)"

# expect_ready <label> <hook> <json> — the readiness guard let the prompt through, WITH a verdict.
expect_ready() {
    local out; out="$(run "$2" "$3")"
    if printf '%s' "$out" | grep -q '"verdict":"ready"' && ! printf '%s' "$out" | grep -q '"decision":"block"'; then
        green "  PASS  ready: $1"; PASS=$((PASS+1))
    else
        red   "  FAIL  should have been READY: $1"; FAIL=$((FAIL+1))
    fi
}

# ar_shape <label> <stdout> [text ...] — what every readiness answer must also be.
# A block is decision:block ALONE: with `continue` or `stopReason` beside it the
# CLI keeps the prompt and reports a turn, and the conductor can no longer tell
# the block from a short session. The token is never printed or logged. Each
# <text> must appear. Counts only a failure, so the section still reports one
# line per case.
ar_shape() {
    local label="$1" out="$2" bad="" want; shift 2
    printf '%s' "$out" | grep -q '"continue"' && bad="$bad a-continue-key"
    printf '%s' "$out" | grep -q '"stopReason"' && bad="$bad a-stopReason-key"
    printf '%s' "$out" | grep -qF -- "$AR_TOKEN" && bad="$bad the-token-on-stdout"
    cat "$ROOT/state/hook-events.jsonl" "$ROOT/state/hook-errors.log" 2>/dev/null \
        | grep -qF -- "$AR_TOKEN" && bad="$bad the-token-in-a-log"
    for want in "$@"; do printf '%s' "$out" | grep -qF -- "$want" || bad="$bad missing:$want"; done
    if [ -n "$bad" ]; then red "  FAIL  $label:$bad"; FAIL=$((FAIL+1)); fi
}

# ar_lacks <label> <stdout> <text ...> — none of <text> may appear. Counts only a failure.
ar_lacks() {
    local label="$1" out="$2" bad="" unwanted; shift 2
    for unwanted in "$@"; do printf '%s' "$out" | grep -qF -- "$unwanted" && bad="$bad unexpected:$unwanted"; done
    if [ -n "$bad" ]; then red "  FAIL  $label:$bad"; FAIL=$((FAIL+1)); fi
}

# The fixture's address and the token stay set for the section; each case names
# its phase and ticket in front of the helper, which exports them to the hook.
export ONESHOT_AUTOMATION_API="http://127.0.0.1:${AR_PORT:-9}/api/v4"
export ONESHOT_AUTOMATION_PROJECT="acme/erp"
export ONESHOT_AUTOMATION_TOKEN="$AR_TOKEN"
AR_PHASE="automation-testcases"

ONESHOT_PHASE=implement ONESHOT_TICKET=1 \
    expect_clean "outside the automation phase it says nothing" automation-ready.cjs "$AR_PAYLOAD"
ar_shape "outside the automation phase it says nothing" \
    "$(ONESHOT_PHASE=implement ONESHOT_TICKET=1 run automation-ready.cjs "$AR_PAYLOAD")"

if [ -n "$AR_PORT" ]; then
    L="closed ticket with a merged fix MR"
    ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=1 expect_ready "$L" automation-ready.cjs "$AR_PAYLOAD"
    ar_shape "$L" "$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=1 run automation-ready.cjs "$AR_PAYLOAD")" \
        '"hookEventName":"UserPromptSubmit"' 'merged !11 (fix/x → dev).'

    L="open ticket, deployed after the trigger, MR still open"
    ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=2 expect_block "$L" automation-ready.cjs "$AR_PAYLOAD"
    ar_shape "$L" "$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=2 run automation-ready.cjs "$AR_PAYLOAD")" \
        '"code":"rfd-order"' '"code":"mr-not-merged"' '!21 is still open'

    L="GitLab answering 500 fails closed"
    ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=3 expect_block "$L" automation-ready.cjs "$AR_PAYLOAD"
    ar_shape "$L" "$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=3 run automation-ready.cjs "$AR_PAYLOAD")" \
        '"verdict":"unknown"' '"errorKind":"server"'

    # The Loop is the master switch: without it nothing else can make a ticket ready.
    L="closed ticket with a merged fix MR, but no Loop"
    ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=5 expect_block "$L" automation-ready.cjs "$AR_PAYLOAD"
    AR_OUT="$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=5 run automation-ready.cjs "$AR_PAYLOAD")"
    ar_shape "$L" "$AR_OUT" '"verdict":"not-ready"' '"code":"loop-missing"' 'is not on the ticket.' '"iid":51'
    ar_lacks "$L" "$AR_OUT" '"code":"rfa-missing"' '"code":"rfd-order"' '"code":"mr-not-merged"'

    L="no Loop, and both rules failing too: loop-missing first, beside the rest"
    ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=6 expect_block "$L" automation-ready.cjs "$AR_PAYLOAD"
    ar_shape "$L" "$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=6 run automation-ready.cjs "$AR_PAYLOAD")" \
        '"reasons":[{"code":"loop-missing"' '"code":"rfd-order"' '"code":"mr-not-merged"' '!61 is still open'
else
    red "  FAIL  the fixture GitLab did not start, so the cases that need it cannot run"; FAIL=$((FAIL+1))
    skip "closed ticket with a merged fix MR" "no fixture"
    skip "open ticket, deployed after the trigger, MR still open" "no fixture"
    skip "GitLab answering 500 fails closed" "no fixture"
    skip "closed ticket with a merged fix MR, but no Loop" "no fixture"
    skip "no Loop, and both rules failing too: loop-missing first, beside the rest" "no fixture"
fi

# Port 9 is on fetch's blocked-port list: refused before any packet leaves.
L="GitLab unreachable fails closed"
ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=1 ONESHOT_AUTOMATION_API=http://127.0.0.1:9/api/v4 \
    expect_block "$L" automation-ready.cjs "$AR_PAYLOAD"
ar_shape "$L" "$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=1 ONESHOT_AUTOMATION_API=http://127.0.0.1:9/api/v4 \
    run automation-ready.cjs "$AR_PAYLOAD")" '"verdict":"unknown"' '"errorKind":"network"'

L="no token fails closed"
ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=1 ONESHOT_AUTOMATION_TOKEN= \
    expect_block "$L" automation-ready.cjs "$AR_PAYLOAD"
ar_shape "$L" "$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=1 ONESHOT_AUTOMATION_TOKEN= \
    run automation-ready.cjs "$AR_PAYLOAD")" '"verdict":"unknown"' '"errorKind":"config"'

if [ -n "$AR_PORT" ]; then
    L="a rejected token fails closed and says auth"
    ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=4 expect_block "$L" automation-ready.cjs "$AR_PAYLOAD"
    ar_shape "$L" "$(ONESHOT_PHASE=$AR_PHASE ONESHOT_TICKET=4 run automation-ready.cjs "$AR_PAYLOAD")" \
        '"verdict":"unknown"' '"errorKind":"auth"'
else
    skip "a rejected token fails closed and says auth" "no fixture"
fi

unset ONESHOT_AUTOMATION_API ONESHOT_AUTOMATION_PROJECT ONESHOT_AUTOMATION_TOKEN
kill "$AR_PID" 2>/dev/null
wait "$AR_PID" 2>/dev/null
rm -f "$AR_PORT_FILE"

rm -rf "$ONESHOT_WORKTREE"

echo
if [ "$FAIL" -eq 0 ]; then
    green "$PASS passed, 0 failed, $SKIP skipped"
    exit 0
else
    red "$PASS passed, $FAIL FAILED, $SKIP skipped"
    exit 1
fi
