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

# py-lint is PostToolUse, so it answers with {"decision":"block"} rather than a
# permissionDecision — the allow/deny helpers above cannot read it.
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
expect_clean "clean file"                py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/clean.py")"
expect_clean "affirmed pylint disable"   py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/allowed_comment.py")"
expect_clean "migration is exempt"       py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/migrations/0001_initial.py")"
expect_clean "non-python file"           py-lint.cjs "$(py_payload "$ONESHOT_WORKTREE/apps/demo/notes.md")"
expect_clean "python outside worktree"   py-lint.cjs "$(py_payload "/tmp/oneshot-verify-outside.py")"
expect_clean "failed write is not linted" py-lint.cjs "$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"tool_response":{"success":false}}' "$ONESHOT_WORKTREE/apps/demo/commented.py")"

rm -rf "$ONESHOT_WORKTREE"

echo
if [ "$FAIL" -eq 0 ]; then
    green "$PASS passed, 0 failed"
    exit 0
else
    red "$PASS passed, $FAIL FAILED"
    exit 1
fi
