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

# The local-tests desk: a stand-in workstream-automation clone that tracks a
# cypress.env.json (the real one does), a run directory whose wsa/ worktree has
# one too, and a credentials file. Every value is a placeholder. WSA is where a
# real run's worktree would be, and only ever named, never created.
LT="/tmp/oneshot-verify-lt"
LT_REPO="$LT/workstream-automation"
LT_CREDS="$LT/config/cypress-env.json"
LT_RUN="$LT/runs/7"
WSA="$ROOT/state/runs/0/wsa"
export ONESHOT_LOCAL_TESTS_REPO="$LT_REPO"
export ONESHOT_LOCAL_TESTS_CREDS="$LT_CREDS"
rm -rf "$LT"
mkdir -p "$LT_REPO/cypress/e2e" "$LT_RUN/wsa" "$LT/config" "$LT/home"
printf '{}\n' > "$LT_REPO/cypress.env.json"
printf '{}\n' > "$LT_RUN/wsa/cypress.env.json"
printf '{}\n' > "$LT_CREDS"
printf 'export default {};\n' > "$LT_REPO/cypress.config.ts"
printf '{"scripts":{"report":"cypress run --reporter cypress-multi-reporters","lint":"eslint ."}}\n' \
    > "$LT_REPO/package.json"

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
# bash_cwd_payload <cwd> <command> — a Bash call from a session whose shell
# already stands in <cwd>. The SDK sends `cwd` on every hook input.
bash_cwd_payload() {
    printf '{"tool_name":"Bash","cwd":"%s","tool_input":{"command":%s}}' "$1" "$(printf '%s' "$2" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')"
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

# The automation clone is a person's checkout, and a run's state/runs/<iid>/wsa is a
# worktree of it sharing one .git: no git there that changes files, refs or config,
# from any phase. Reads stay open — reading that repo is the scope session's job.
echo
echo "git-guard: local tests"
expect_deny  "commit in a run's automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA commit -am wip")"
expect_deny  "bare push from the automation worktree, after a cd" \
                                       git-guard.cjs "$(bash_payload "cd $WSA && git push")"
expect_deny  "checkout -- <path> in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "cd $WSA && git checkout -- cypress/e2e/leaves.cy.ts")"
expect_deny  "restore in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA restore cypress/Pages/LeavePage.ts")"
expect_deny  "clean -fdx in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA clean -fdx")"
expect_deny  "stash (it lands on the clone's stash stack)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA stash push -m tmp")"
expect_deny  "reset --hard from a session standing in the worktree" \
                                       git-guard.cjs "$(bash_cwd_payload "$WSA" "git reset --hard")"
expect_deny  "checkout -- <path> from a subdirectory of the worktree" \
                                       git-guard.cjs "$(bash_cwd_payload "$WSA/cypress/e2e" "git checkout -- leaves.cy.ts")"
expect_deny  "rebase in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA rebase origin/master")"
expect_deny  "merge in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA merge origin/feature")"
expect_deny  "am in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA am /tmp/0001.patch")"
expect_deny  "apply --index (stages as well)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA apply --index /tmp/x.patch")"
expect_deny  "config (writes the clone's .git/config)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA config user.email x@example.com")"
expect_deny  "the worktree named by --work-tree" \
                                       git-guard.cjs "$(bash_payload "git --git-dir=$LT_REPO/.git --work-tree=$WSA reset --hard")"
expect_deny  "the worktree named by a GIT_WORK_TREE assignment" \
                                       git-guard.cjs "$(bash_payload "GIT_WORK_TREE=$WSA git checkout -- .")"
expect_allow "status in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA status --short")"
expect_allow "diff into the temporary-changes patch" \
                                       git-guard.cjs "$(bash_payload "cd $WSA && git diff > $ROOT/state/runs/0/artifacts/local-tests/temporary-changes.patch")"
expect_allow "log, show, ls-files and grep in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA log --oneline -3 && git -C $WSA show HEAD:cypress.config.ts && git -C $WSA ls-files cypress/e2e && git -C $WSA grep -n visit -- cypress/")"
expect_allow "plain apply (working tree only, like an Edit)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA apply /tmp/x.patch")"
expect_allow "config --get in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA config --get remote.origin.url")"
expect_allow "commit in the ticket's worktree after leaving the automation one" \
                                       git-guard.cjs "$(bash_payload "cd $WSA && git diff --stat && cd $ONESHOT_WORKTREE && git commit -am wip")"

# An allow-list, not a list of mutators: the list it replaced let all of these through.
# A wsa shares the clone's .git, so `remote remove origin` edits the person's
# .git/config and drops refs/remotes/origin/*, and `worktree remove` can take another
# ticket's wsa-run away mid-run. wsa-run is the run step's worktree: reads only there.
WSA_RUN="$ROOT/state/runs/0/wsa-run"
expect_deny  "branch <new> in the automation worktree (a ref the clone can see)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA branch tmp-x")"
expect_deny  "a lightweight tag in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA tag tmp-x")"
expect_deny  "branch -M in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA branch -M master old")"
expect_deny  "remote remove origin (rewrites the clone's .git/config)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA remote remove origin")"
expect_deny  "remote rename"           git-guard.cjs "$(bash_payload "git -C $WSA remote rename origin up")"
expect_deny  "worktree remove of another ticket's wsa-run" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA worktree remove --force $ROOT/state/runs/8800/wsa-run")"
expect_deny  "fetch with a refspec that writes local branches" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA fetch origin '+refs/heads/*:refs/heads/*'")"
expect_deny  "reflog expire"           git-guard.cjs "$(bash_payload "git -C $WSA reflog expire --expire=now --all")"
expect_deny  "update-index (not a read)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA update-index --assume-unchanged cypress.env.json")"
expect_deny  "gc in the automation worktree (not a read)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA gc --prune=now")"
expect_deny  "commit in a run's wsa-run" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA_RUN commit -am wip")"
expect_deny  "plain apply in a wsa-run (the run step's worktree, not the session's)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA_RUN apply /tmp/x.patch")"
expect_deny  "add in a wsa-run"        git-guard.cjs "$(bash_payload "git -C $WSA_RUN add -A")"
expect_allow "branch and tag listings in the automation worktree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA branch -a && git -C $WSA branch --show-current && git -C $WSA branch --contains HEAD && git -C $WSA tag -l && git -C $WSA tag --list 'v*'")"
expect_allow "remote -v, remote get-url and worktree list" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA remote -v && git -C $WSA remote get-url origin && git -C $WSA worktree list")"
expect_allow "rev-parse, cat-file, merge-base, describe, blame and ls-tree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA rev-parse HEAD && git -C $WSA cat-file -t HEAD && git -C $WSA merge-base HEAD origin/master && git -C $WSA describe --always && git -C $WSA blame cypress/e2e/leaves.cy.ts && git -C $WSA ls-tree HEAD cypress/")"
expect_allow "plain fetch and config <key> (reads)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA fetch origin && git -C $WSA config user.email")"
expect_allow "add -N of a new spec in the session's wsa" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA add -N cypress/e2e/new.cy.ts")"
expect_allow "status and diff in a wsa-run" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA_RUN status --short && git -C $WSA_RUN diff --stat")"

# local-tests-scope stands in the ERP worktree with write scope on its run directory
# only, so the read-only-worktree rule applies there. A QA redo round tells it to
# re-apply the previous round's patch to its fresh wsa: that call is the automation
# rule's to judge, and it allows a plain apply in a run's wsa.
SAVED_PHASE="$ONESHOT_PHASE"; SAVED_SCOPES="$ONESHOT_WRITE_SCOPES"
export ONESHOT_PHASE="local-tests-scope"
export ONESHOT_WRITE_SCOPES="$ROOT/state/runs/0"
LT_PATCH="$ROOT/state/runs/0/artifacts/local-tests/temporary-changes.patch"
expect_allow "local-tests-scope: git -C <wsa> apply <patch> (the redo round's first step)" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA apply $LT_PATCH")"
expect_allow "local-tests-scope: cd <wsa> && git apply ../artifacts/…" \
                                       git-guard.cjs "$(bash_payload "cd $WSA && git apply ../artifacts/local-tests/temporary-changes.patch")"
expect_allow "local-tests-scope: add -N in its wsa" \
                                       git-guard.cjs "$(bash_payload "cd $WSA && git add -N cypress/e2e/new.cy.ts && git diff --stat")"
expect_allow "local-tests-scope: reading the ticket's diff in its ERP worktree" \
                                       git-guard.cjs "$(bash_payload 'git diff origin/master --stat && git log --oneline -3')"
expect_deny  "local-tests-scope: apply in its read-only ERP worktree" \
                                       git-guard.cjs "$(bash_payload 'git apply /tmp/x.patch')"
expect_deny  "local-tests-scope: checkout -- <path> in its read-only ERP worktree" \
                                       git-guard.cjs "$(bash_payload 'git checkout -- apps/leaves/models.py')"
expect_deny  "local-tests-scope: an apply in wsa pointed at the ERP worktree by --work-tree" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA --work-tree=$ONESHOT_WORKTREE apply /tmp/x.patch")"
export ONESHOT_PHASE="$SAVED_PHASE"; export ONESHOT_WRITE_SCOPES="$SAVED_SCOPES"

# Normal phases in their own checkouts are none of the automation rule's business.
expect_allow "implement: branch, tag, stash and apply in its own worktree" \
                                       git-guard.cjs "$(bash_payload 'git branch tmp-x && git tag v0-local && git stash && git stash pop && git apply /tmp/x.patch')"
ONESHOT_PHASE="verify" expect_allow "verify: diff, log and show in its own worktree" \
                                       git-guard.cjs "$(bash_payload 'git diff origin/dev...HEAD && git log -p -3 && git show HEAD --stat')"
ONESHOT_PHASE="mr" ONESHOT_WRITE_SCOPES="$ROOT/state/runs/0" expect_allow "mr: fetch, log and push of the leased branch" \
                                       git-guard.cjs "$(bash_payload 'git fetch origin && git log --oneline -3 && git push -u origin oneshot/ticket-0-verify')"

# The conductor-cwd allowlist leaves checkout -- <path>, restore and clean open on
# purpose: remediate repairs a run's own checkout with them. Aimed at the automation
# repos they are refused; anywhere else remediate keeps them.
SAVED_WORKTREE="$ONESHOT_WORKTREE"; SAVED_PHASE="$ONESHOT_PHASE"
unset ONESHOT_WORKTREE
export ONESHOT_PHASE="remediate"
expect_deny  "checkout -- <path> in the automation clone from remediate" \
                                       git-guard.cjs "$(bash_payload "git -C $LT_REPO checkout -- cypress.config.ts")"
expect_deny  "restore in the automation clone from remediate" \
                                       git-guard.cjs "$(bash_payload "cd $LT_REPO && git restore .")"
expect_deny  "clean in a run's automation worktree from remediate" \
                                       git-guard.cjs "$(bash_payload "git -C $WSA clean -fd")"
expect_deny  "checkout -- . from a session standing in the clone" \
                                       git-guard.cjs "$(bash_cwd_payload "$LT_REPO" "git checkout -- .")"
expect_deny  "the worktree spelled in capitals (APFS folds case)" \
                                       git-guard.cjs "$(bash_payload "git -C $ROOT/STATE/RUNS/0/WSA restore .")"
expect_allow "checkout -- <path> in a run's own checkout from remediate" \
                                       git-guard.cjs "$(bash_cwd_payload "$SAVED_WORKTREE" "git checkout -- package-lock.json")"
expect_allow "clean and restore in a run's own checkout from remediate" \
                                       git-guard.cjs "$(bash_cwd_payload "$SAVED_WORKTREE" "git clean -fd && git restore frontend/")"
expect_allow "log and fetch in the clone from remediate" \
                                       git-guard.cjs "$(bash_payload "git -C $LT_REPO log --oneline -5 && git -C $LT_REPO fetch origin master")"
ONESHOT_LOCAL_TESTS_REPO="" expect_allow "the clone is just a directory on a desk with the feature off" \
                                       git-guard.cjs "$(bash_payload "git -C $LT_REPO restore .")"
expect_deny  "remote remove in the clone from remediate" \
                                       git-guard.cjs "$(bash_payload "git -C $LT_REPO remote remove origin")"
expect_allow "remediate: branch listing, status and fetch in a run's own checkout" \
                                       git-guard.cjs "$(bash_cwd_payload "$SAVED_WORKTREE" "git branch -a && git status --short && git fetch origin")"
expect_allow "remediate: status and fetch in the clone" \
                                       git-guard.cjs "$(bash_payload "git -C $LT_REPO status --short && git -C $LT_REPO fetch origin")"
export ONESHOT_WORKTREE="$SAVED_WORKTREE"; export ONESHOT_PHASE="$SAVED_PHASE"

# The old deny-list read ONESHOT_LOCAL_TESTS_REPO only. config.ts and localtests.cjs
# also accept the legacy ONELOOP_ spelling, and a placeholder counts as unset.
ONESHOT_LOCAL_TESTS_REPO="" ONELOOP_LOCAL_TESTS_REPO="$LT_REPO" ONESHOT_PHASE="remediate" ONESHOT_WORKTREE="" \
    expect_deny "the clone named by the legacy ONELOOP_ spelling" \
                                       git-guard.cjs "$(bash_payload "git -C $LT_REPO restore .")"
ONESHOT_LOCAL_TESTS_REPO="REPLACE_ME" ONESHOT_PHASE="remediate" ONESHOT_WORKTREE="" \
    expect_allow "a placeholder repo is the feature off" \
                                       git-guard.cjs "$(bash_payload "git -C $LT_REPO restore .")"

# Specs run in local-tests-run, which is conductor code; no session starts Cypress
# or the run script, by any spelling.
expect_deny  "npx cypress run"         git-guard.cjs "$(bash_payload 'npx cypress run --spec cypress/e2e/leaves.cy.ts')"
expect_deny  "cypress run"             git-guard.cjs "$(bash_payload 'cypress run --browser chrome')"
expect_deny  "node_modules/.bin/cypress" \
                                       git-guard.cjs "$(bash_payload './node_modules/.bin/cypress run')"
expect_deny  "npx -y cypress@13 in the automation worktree, after a cd" \
                                       git-guard.cjs "$(bash_payload "cd $WSA && npx -y cypress@13 run")"
expect_deny  "yarn cypress run"        git-guard.cjs "$(bash_payload 'yarn cypress run')"
expect_deny  "timeout 900 npx cypress run" \
                                       git-guard.cjs "$(bash_payload 'timeout 900 npx cypress run')"
expect_deny  "nohup cypress run"       git-guard.cjs "$(bash_payload 'nohup cypress run &')"
expect_deny  "bash -c with npx cypress inside" \
                                       git-guard.cjs "$(bash_payload 'bash -c "npx cypress run --spec x"')"
expect_deny  "node on Cypress's own bin" \
                                       git-guard.cjs "$(bash_payload 'node node_modules/cypress/bin/cypress run')"
expect_deny  "Cypress's module API from node -e" \
                                       git-guard.cjs "$(bash_payload "node -e \"require('cypress').run({ spec: 'x' })\"")"
expect_deny  "npm run report (a package script that runs cypress)" \
                                       git-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'npm run report')"
expect_deny  "node scripts/localtests.cjs run" \
                                       git-guard.cjs "$(bash_payload 'node scripts/localtests.cjs run 0')"
expect_deny  "the run script by absolute path" \
                                       git-guard.cjs "$(bash_payload "node $ROOT/scripts/localtests.cjs gc")"
expect_deny  "the run script as its own command" \
                                       git-guard.cjs "$(bash_payload './scripts/localtests.cjs status')"
ONESHOT_PHASE="local-tests-scope" expect_deny "npx cypress from local-tests-scope, which decides what runs" \
                                       git-guard.cjs "$(bash_payload 'npx cypress run')"
expect_allow "npm run lint (a package script that does not run cypress)" \
                                       git-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'npm run lint')"
expect_allow "reading the run script"  git-guard.cjs "$(bash_payload 'cat scripts/localtests.cjs')"
expect_allow "grepping the specs for cypress" \
                                       git-guard.cjs "$(bash_payload "grep -rn \"from 'cypress'\" cypress/")"
expect_allow "listing the Cypress binary" \
                                       git-guard.cjs "$(bash_payload 'ls -la node_modules/.bin/cypress')"
expect_allow "npx tsc"                 git-guard.cjs "$(bash_payload 'npx tsc --noEmit')"

# An option's value is not the command, and --prefix/-C/--cwd/--dir move where the
# package.json script is read from. --prefix <clone> runs the suite with the person's
# own cypress.env.json against whatever SERVER it names.
expect_deny  "npm --prefix <clone> run report" \
                                       git-guard.cjs "$(bash_cwd_payload /tmp "npm --prefix $LT_REPO run report")"
expect_deny  "npm run report --prefix <clone> (npm reads options anywhere)" \
                                       git-guard.cjs "$(bash_cwd_payload /tmp "npm run report --prefix $LT_REPO")"
expect_deny  "npm --prefix=<clone> run report" \
                                       git-guard.cjs "$(bash_cwd_payload /tmp "npm --prefix=$LT_REPO run report")"
expect_deny  "yarn --cwd <clone> report" \
                                       git-guard.cjs "$(bash_cwd_payload /tmp "yarn --cwd $LT_REPO report")"
expect_deny  "pnpm -C <clone> run report" \
                                       git-guard.cjs "$(bash_cwd_payload /tmp "pnpm -C $LT_REPO run report")"
expect_deny  "npx --prefix <wsa> cypress run" \
                                       git-guard.cjs "$(bash_payload "npx --prefix $WSA cypress run")"
expect_deny  "npm exec --prefix <wsa> -- cypress run" \
                                       git-guard.cjs "$(bash_payload "npm exec --prefix $WSA -- cypress run")"
expect_deny  "npx --cache /tmp/c cypress run" \
                                       git-guard.cjs "$(bash_payload 'npx --cache /tmp/c cypress run')"
expect_deny  "npx with an unknown option and its value before cypress" \
                                       git-guard.cjs "$(bash_payload 'npx --foo bar cypress run')"
expect_deny  "npx -c 'cypress run'"    git-guard.cjs "$(bash_payload "npx -c 'cypress run'")"
expect_deny  "timeout -k 10 900 npx cypress run" \
                                       git-guard.cjs "$(bash_payload 'timeout -k 10 900 npx cypress run')"
expect_deny  "timeout --signal KILL 900 npx cypress run" \
                                       git-guard.cjs "$(bash_payload 'timeout --signal KILL 900 npx cypress run')"
expect_deny  "env -i PATH=… npx cypress run" \
                                       git-guard.cjs "$(bash_payload 'env -i PATH=/usr/bin npx cypress run')"
expect_deny  "sudo -u qa npx cypress run" \
                                       git-guard.cjs "$(bash_payload 'sudo -u qa npx cypress run')"
expect_allow "npm --prefix <clone> run lint (a script that does not run cypress)" \
                                       git-guard.cjs "$(bash_cwd_payload /tmp "npm --prefix $LT_REPO run lint")"
expect_allow "npx tsc -p cypress (tsc's option, not npx's)" \
                                       git-guard.cjs "$(bash_payload 'npx tsc -p cypress --noEmit')"
expect_allow "npx eslint on a spec"    git-guard.cjs "$(bash_payload 'npx --yes eslint cypress/e2e/leaves.cy.ts')"
expect_allow "npm ls cypress and npm view cypress version" \
                                       git-guard.cjs "$(bash_payload 'npm ls cypress && npm view cypress version')"
expect_allow "command -v cypress (a lookup, not a run)" \
                                       git-guard.cjs "$(bash_payload 'command -v cypress')"
expect_allow "timeout 600 npm test"    git-guard.cjs "$(bash_payload 'timeout 600 npm test -- --watchAll=false')"
expect_allow "npm --prefix frontend run build (implement)" \
                                       git-guard.cjs "$(bash_payload 'npm --prefix frontend run build')"

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
echo "frontend-test-guard"
# The matcher is the app repo's own Jest `testMatch`, so the two halves of that
# config are the two halves of this block.
expect_deny  "__tests__/ under frontend/src" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/components/leaves/person_view/__tests__/LeaveForm.test.js")"
expect_deny  "a plain .js inside __tests__/ (testMatch is directory-based)" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/components/leaves/__tests__/helpers.js")"
expect_deny  ".test.js outside __tests__/ (erp has two of these)" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/common/utils/tests/misc.test.js")"
expect_deny  ".spec.jsx under frontend/src" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/components/rewards/BonusInput.spec.jsx")"
expect_deny  ".test.tsx under frontend/src" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/components/home/Announcements.test.tsx")"
expect_deny  "Edit of an existing Jest test, not just Write" \
    frontend-test-guard.cjs '{"tool_name":"Edit","tool_input":{"file_path":"'"$ONESHOT_WORKTREE"'/frontend/src/components/profile/__tests__/AddRelative.test.js"}}'

# THE CARVE-OUT. Playwright is the sanctioned route and `verify` breaks on every
# UI ticket if any of these is denied. Each lives outside Jest's `roots`, which
# is exactly why the rule is anchored on frontend/src and not on the filename.
expect_allow "Playwright driver in the worktree scratch dir" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/.verify-scratch/cases.spec.js")"
expect_allow "Playwright driver in the run's harness dir" \
    frontend-test-guard.cjs "$(write_payload "$ROOT/state/runs/0/harness/drive.test.js")"
expect_allow "Playwright spec at the app repo root, outside Jest's roots" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/e2e/leaves.spec.ts")"
expect_allow "Playwright spec under frontend/ but outside frontend/src" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/e2e/leaves.spec.js")"

# Everything else the guard must keep its hands off.
expect_allow "a backend Django test"   frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/apps/leaves/tests/leave_form_test.py")"
expect_allow "a backend pytest-style test" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/apps/leaves/tests/test_leave_form.py")"
expect_allow "ordinary frontend source"  frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/components/leaves/LeaveForm.jsx")"
expect_allow "the port-pinning config verify must edit" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/constants/config.js")"
expect_allow "Jest's own setup file (infrastructure, outside roots)" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/config/setupTests.js")"
expect_allow "a snapshot (.snap is not in testMatch)" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/components/profile/__tests__/__snapshots__/AddRelative.test.js.snap")"
expect_allow "Oneshot's own unit test (this repo has no frontend/)" \
    frontend-test-guard.cjs "$(write_payload "$ROOT/src/conductor/runner.test.ts")"
expect_allow "Read of a Jest test — this guard is writes only" \
    frontend-test-guard.cjs '{"tool_name":"Read","tool_input":{"file_path":"'"$ONESHOT_WORKTREE"'/frontend/src/components/profile/__tests__/AddRelative.test.js"}}'

# The guard is phase-independent: verify writes Playwright, implement writes
# code, and neither may author a Jest test. Pinning a non-implement phase stops
# someone narrowing this to `implement` and reopening it for every other phase.
SAVED_PHASE="$ONESHOT_PHASE"
export ONESHOT_PHASE="verify"
expect_deny  "a Jest test from verify, not just implement" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/frontend/src/components/leaves/__tests__/LeaveForm.test.js")"
expect_allow "verify's Playwright driver"  frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/.verify-scratch/run-cases.js")"
export ONESHOT_PHASE="$SAVED_PHASE"

# A path that reaches frontend/src through a symlink is still frontend/src, and
# a prefix-only check would wave it through. Same realpath rule write-scope
# depends on, pinned here so nobody "simplifies" realish() out of this guard.
mkdir -p "$ONESHOT_WORKTREE/frontend/src/components"
ln -sfn "$ONESHOT_WORKTREE/frontend/src/components" "$ONESHOT_WORKTREE/shortcut" 2>/dev/null
expect_deny  "a Jest test reached through a symlink (realpath escape)" \
    frontend-test-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/shortcut/__tests__/Sneaky.test.js")"

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

# The Cypress credentials: any cypress.env.json (workstream-automation tracks one,
# so the clone and every wsa worktree has it) and the desk's credentials file.
# Judged by name, not by verb — naming one is enough, unless the command only
# lists or tests for it — and a search that would open one without naming it is
# refused too. LT_* fixtures are set up at the top; every value is a placeholder.
read_payload() { printf '{"tool_name":"Read","tool_input":{"file_path":"%s"}}' "$1"; }
grep_payload() { printf '{"tool_name":"Grep","tool_input":%s}' "$1"; }
echo
echo "secret-guard: local tests"
expect_deny  "Read of a run worktree's cypress.env.json" secret-guard.cjs "$(read_payload "$WSA/cypress.env.json")"
expect_deny  "Read of the clone's cypress.env.json"      secret-guard.cjs "$(read_payload "$LT_REPO/cypress.env.json")"
expect_deny  "Read of Cypress.ENV.json (APFS folds case)" secret-guard.cjs "$(read_payload "$LT_REPO/Cypress.ENV.json")"
expect_deny  "Read of the desk's credentials file"       secret-guard.cjs "$(read_payload "$LT_CREDS")"
ln -sfn "$LT_CREDS" "$LT/innocent.json"
expect_deny  "Read through a symlink to the credentials file" secret-guard.cjs "$(read_payload "$LT/innocent.json")"
# Unset, the variable falls back to the default path. ONESHOT_HOME moves too, so a
# desk .env that sets it cannot answer for the default.
mkdir -p "$LT/home/.config/oneshot"
HOME="$LT/home" ONESHOT_HOME="$LT" ONESHOT_LOCAL_TESTS_CREDS="" expect_deny "Read of the default credentials path" \
    secret-guard.cjs "$(read_payload "$LT/home/.config/oneshot/cypress-env.json")"
HOME="$LT/home" ONESHOT_HOME="$LT" ONESHOT_LOCAL_TESTS_CREDS="" expect_deny "cat of the default credentials by a ~ path" \
    secret-guard.cjs "$(bash_cwd_payload /tmp 'cat ~/.config/oneshot/cypress-env.json')"
expect_deny  "Grep of the credentials file, even for names only" \
    secret-guard.cjs "$(grep_payload '{"pattern":"pass","path":"'"$LT_CREDS"'"}')"
expect_deny  "Grep content over the clone root (the file is tracked, not ignored)" \
    secret-guard.cjs "$(grep_payload '{"pattern":"baseUrl","path":"'"$LT_REPO"'","output_mode":"content"}')"
expect_deny  "Grep content over a run directory, reaching wsa/" \
    secret-guard.cjs "$(grep_payload '{"pattern":"baseUrl","path":"'"$LT_RUN"'","output_mode":"content"}')"
expect_deny  "Grep content with no path, standing in the clone" \
    secret-guard.cjs '{"tool_name":"Grep","cwd":"'"$LT_REPO"'","tool_input":{"pattern":"baseUrl","output_mode":"content"}}'
expect_deny  "Grep content over the clone with a glob that takes it in" \
    secret-guard.cjs "$(grep_payload '{"pattern":"x","path":"'"$LT_REPO"'","glob":"*.json","output_mode":"content"}')"
expect_allow "Grep content over the clone with a *.ts glob" \
    secret-guard.cjs "$(grep_payload '{"pattern":"baseUrl","path":"'"$LT_REPO"'","glob":"*.{ts,js}","output_mode":"content"}')"
expect_allow "Grep content over the clone with type ts" \
    secret-guard.cjs "$(grep_payload '{"pattern":"baseUrl","path":"'"$LT_REPO"'","type":"ts","output_mode":"content"}')"
expect_allow "Grep content over the clone with glob !cypress.env.json" \
    secret-guard.cjs "$(grep_payload '{"pattern":"baseUrl","path":"'"$LT_REPO"'","glob":"!cypress.env.json","output_mode":"content"}')"
expect_allow "Grep content over cypress/ in the clone" \
    secret-guard.cjs "$(grep_payload '{"pattern":"baseUrl","path":"'"$LT_REPO/cypress"'","output_mode":"content"}')"
expect_allow "Grep files_with_matches over the clone (names only)" \
    secret-guard.cjs "$(grep_payload '{"pattern":"baseUrl","path":"'"$LT_REPO"'"}')"
expect_deny  "Glob hunting for it by name" \
    secret-guard.cjs '{"tool_name":"Glob","tool_input":{"pattern":"**/cypress.env.json","path":"'"$LT"'"}}'
expect_allow "Glob for specs"          secret-guard.cjs '{"tool_name":"Glob","tool_input":{"pattern":"cypress/e2e/**/*.cy.ts","path":"'"$LT_REPO"'"}}'

expect_deny  "cat a run worktree's cypress.env.json" secret-guard.cjs "$(bash_cwd_payload /tmp "cat $WSA/cypress.env.json")"
expect_deny  "head by bare name, standing in the clone" secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'head -5 cypress.env.json')"
expect_deny  "less the credentials file" secret-guard.cjs "$(bash_cwd_payload /tmp "less $LT_CREDS")"
expect_deny  "tail the credentials file" secret-guard.cjs "$(bash_cwd_payload /tmp "tail -n 3 $LT_CREDS")"
expect_deny  "grep a key out of it"    secret-guard.cjs "$(bash_cwd_payload /tmp "grep -i password $LT_REPO/cypress.env.json")"
expect_deny  "sed -n over it"          secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "sed -n '1,5p' cypress.env.json")"
expect_deny  "awk over it"             secret-guard.cjs "$(bash_cwd_payload /tmp "awk '{print}' $LT_CREDS")"
expect_deny  "cp it out"               secret-guard.cjs "$(bash_cwd_payload /tmp "cp $LT_REPO/cypress.env.json /tmp/x.json")"
expect_deny  "cp the credentials into a worktree" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cp $LT_CREDS $WSA/cypress.env.json")"
expect_deny  "python one-liner (its ; splits the verb off)" \
    secret-guard.cjs "$(bash_cwd_payload /tmp "python3 -c \"import json; print(json.load(open('$LT_CREDS')))\"")"
expect_deny  "node one-liner"          secret-guard.cjs "$(bash_cwd_payload /tmp "node -e \"console.log(require('$LT_REPO/cypress.env.json'))\"")"
expect_deny  "git show <rev>:cypress.env.json" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git show origin/master:cypress.env.json')"
expect_deny  "cd into the clone, then cat *.json" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cd $LT_REPO && cat *.json")"
expect_deny  "recursive grep over the clone root" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'grep -rn baseUrl .')"
expect_deny  "rg with no path, standing in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'rg password')"
expect_deny  "git grep, standing in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git grep -n password')"
expect_deny  "git -C <clone> grep"     secret-guard.cjs "$(bash_cwd_payload /tmp "git -C $LT_REPO grep -n password")"
expect_allow "recursive grep over cypress/" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'grep -rn baseUrl cypress/')"
expect_allow "recursive grep that excludes the file" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'grep -rn --exclude=cypress.env.json baseUrl .')"
expect_allow "rg -g '!cypress.env.json'" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "rg -g '!cypress.env.json' password")"
expect_allow "rg -t ts"                secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'rg -t ts baseUrl')"
expect_allow "grep -rl over the clone (names only, like files_with_matches)" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'grep -rl baseUrl .')"
expect_allow "git grep -l over the clone (names only)" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git grep -l password')"
expect_allow "git grep with a cypress/ pathspec" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git grep -n visit -- cypress/')"
expect_allow "git grep excluding it by pathspec" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "git grep -n visit -- . ':!cypress.env.json'")"
expect_allow "ls and test -f"          secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "ls -la cypress.env.json && test -f $LT_CREDS && echo present")"
expect_allow "grep the specs for Cypress.env(" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "grep -rn 'Cypress.env(' cypress/")"
expect_allow "cat cypress.config.ts"   secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'cat cypress.config.ts')"
expect_allow "recursive grep in a worktree with no cypress.env.json" \
                                       secret-guard.cjs "$(bash_cwd_payload "$ONESHOT_WORKTREE" 'grep -rn TODO .')"
# grep -r honours no ignore file, so from at or above state/runs it opens every run's
# worktree; rg skips state/ as ignored. A stand-in ONESHOT_HOME keeps the fixture out
# of this checkout's real state/.
mkdir -p "$LT/state/runs/9/wsa" && printf '{}\n' > "$LT/state/runs/9/wsa/cypress.env.json"
ONESHOT_HOME="$LT" expect_deny "grep -r over state/runs reaches every run's worktree" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT" 'grep -rn baseUrl state/runs')"
ONESHOT_HOME="$LT" expect_allow "rg from the Oneshot root (state/ is ignored)" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT" 'rg baseUrl')"
expect_allow "Read of another file next to the credentials" \
                                       secret-guard.cjs "$(read_payload "$LT/config/notes.json")"

# wsa-run is the run step's worktree, and its cypress.env.json is the committed file
# merged with the desk credentials. capture removes wsa before the run starts, so
# while a run is in progress wsa-run's is the only copy in the run directory.
LT_ONLY="$LT/only-wsa-run"
mkdir -p "$LT_ONLY/state/runs/8/wsa-run/cypress/e2e" && printf '{}\n' > "$LT_ONLY/state/runs/8/wsa-run/cypress.env.json"
ONESHOT_HOME="$LT_ONLY" expect_deny "grep -r over state/runs reaches a wsa-run with no wsa beside it" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_ONLY" 'grep -rn CREDENTIALS state/runs')"
ONESHOT_HOME="$LT_ONLY" expect_deny "grep -r over one run directory reaches its wsa-run" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_ONLY" 'grep -rn SERVER state/runs/8')"
ONESHOT_HOME="$LT_ONLY" expect_deny "cd into a run directory, then grep -r ." \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_ONLY" 'cd state/runs/8 && grep -rn CREDENTIALS .')"
ONESHOT_HOME="$LT_ONLY" expect_deny "Grep content over a run directory, reaching wsa-run/" \
    secret-guard.cjs "$(grep_payload '{"pattern":"SERVER","path":"'"$LT_ONLY/state/runs/8"'","output_mode":"content"}')"
ONESHOT_HOME="$LT_ONLY" expect_deny "git diff in a wsa-run" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_ONLY" 'git -C state/runs/8/wsa-run diff')"
ONESHOT_HOME="$LT_ONLY" expect_deny "git diff HEAD standing in a wsa-run" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_ONLY/state/runs/8/wsa-run" 'git diff HEAD')"
ONESHOT_HOME="$LT_ONLY" expect_allow "git diff --stat in a wsa-run" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_ONLY" 'git -C state/runs/8/wsa-run diff --stat')"
ONESHOT_HOME="$LT_ONLY" expect_allow "git diff of cypress/ in a wsa-run" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_ONLY" 'git -C state/runs/8/wsa-run diff -- cypress/')"

# People fill the clone's tracked cypress.env.json in locally, so a diff of its working
# tree prints the credentials as + lines without ever naming the file.
expect_deny  "git diff in the clone"   secret-guard.cjs "$(bash_cwd_payload /tmp "git -C $LT_REPO diff")"
expect_deny  "cd into the clone, then git diff HEAD" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cd $LT_REPO && git diff HEAD")"
expect_deny  "git diff from a subdirectory of the clone (no pathspec is the whole repo)" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO/cypress/e2e" 'git diff')"
expect_deny  "--git-dir/--work-tree naming the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "git --git-dir=$LT_REPO/.git --work-tree=$LT_REPO diff")"
expect_deny  "a wsa pointed at the clone's working tree" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "git -C $LT_RUN/wsa --work-tree=$LT_REPO diff HEAD")"
expect_deny  "GIT_WORK_TREE naming the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "GIT_WORK_TREE=$LT_REPO git diff")"
expect_deny  "git log -p in the clone" secret-guard.cjs "$(bash_cwd_payload /tmp "git -C $LT_REPO log -p -3")"
expect_deny  "git show in the clone"   secret-guard.cjs "$(bash_cwd_payload /tmp "git -C $LT_REPO show HEAD")"
expect_deny  "git diff -- . from the clone's root" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git diff -- .')"
expect_deny  "git diff -- '*.json' in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "git diff -- '*.json'")"
expect_allow "git diff -- cypress/ in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git diff HEAD -- cypress/')"
expect_allow "git diff of cypress/ without --" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git diff cypress/')"
expect_allow "git diff excluding it by pathspec" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "git diff -- . ':!cypress.env.json'")"
expect_allow "git diff -- '*.ts' in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "git diff -- '*.ts'")"
expect_allow "git diff -- . from inside cypress/" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO/cypress" 'git diff -- .')"
expect_allow "git diff --stat, --name-only and log --oneline in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "git -C $LT_REPO diff --stat && git -C $LT_REPO diff --name-only HEAD && git -C $LT_REPO log --oneline -5 && git -C $LT_REPO status --short")"
expect_allow "git show <rev>:<another file> in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'git show HEAD:cypress.config.ts')"
expect_allow "the scope session cutting its patch in wsa (the committed copy only)" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cd $LT_RUN/wsa && git diff > /tmp/temporary-changes.patch")"
expect_allow "implement: git diff, show and log -p in its own worktree" \
                                       secret-guard.cjs "$(bash_cwd_payload "$ONESHOT_WORKTREE" 'git diff && git diff HEAD && git show HEAD && git log -p -3')"
ONESHOT_LOCAL_TESTS_REPO="" expect_allow "git diff in the clone on a desk with the feature off" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "git -C $LT_REPO diff")"

# Brace expansion. pathWords used to split *.{json,ts} at its comma, globRe threw on
# `*.{json`, and the catch allowed the whole command — every segment of it.
expect_deny  "cat a brace glob in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cat $LT_REPO/*.{json,ts}")"
expect_deny  "cat a brace glob in a run worktree" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cat $LT_RUN/wsa/*.{json,bak}")"
expect_deny  "cat a brace glob over the credentials folder" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cat $LT/config/*.{json,bak}")"
expect_deny  "brace expansion with no glob: {cypress.env.json,x}" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cat $LT_REPO/{cypress.env.json,x}")"
expect_deny  "brace expansion of the extension: cypress.env.{json,x}" \
                                       secret-guard.cjs "$(bash_cwd_payload /tmp "cat $LT_REPO/cypress.env.{json,x}")"
expect_deny  "a harmless brace glob does not switch the rule off for the next segment" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "find . -name '*.{js,ts}'; cat $LT_REPO/cypress.env.json")"
expect_deny  "an unbalanced brace glob where the file sits" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'cat *.{json')"
expect_deny  "Grep content with an unbalanced brace glob over the clone" \
    secret-guard.cjs "$(grep_payload '{"pattern":"x","path":"'"$LT_REPO"'","glob":"*.{ts","output_mode":"content"}')"
expect_deny  "Glob with a brace pattern for it" \
    secret-guard.cjs '{"tool_name":"Glob","tool_input":{"pattern":"**/cypress.{env,config}.json","path":"'"$LT"'"}}'
expect_allow "a brace glob for specs" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'ls cypress/e2e/*.{cy.ts,cy.js} && cat cypress/e2e/*.{cy.ts,cy.js}')"
expect_allow "cat {package.json,cypress.config.ts} in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" 'cat {package.json,cypress.config.ts}')"
expect_allow "a node one-liner with an object literal, standing in the clone" \
                                       secret-guard.cjs "$(bash_cwd_payload "$LT_REPO" "node -e \"const x = {a: 1, b: 2}; console.log(x)\"")"
expect_allow "a brace glob where no credentials sit" \
                                       secret-guard.cjs "$(bash_cwd_payload "$ONESHOT_WORKTREE" 'cat *.{json,ts} && cat *.{json')"

# The legacy ONELOOP_ spelling names the credentials file too.
ONESHOT_LOCAL_TESTS_CREDS="" ONELOOP_LOCAL_TESTS_CREDS="$LT/config/notes.json" expect_deny \
    "Read of a credentials file named by the legacy ONELOOP_ spelling" \
                                       secret-guard.cjs "$(read_payload "$LT/config/notes.json")"

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
# Not a registered hook: the readiness script the conductor runs before an
# automation session (runAutomationReadyGuard). Every way it can fail to judge a
# ticket has to answer `unknown` and block, never `ready`. It is the only
# script here that talks to GitLab, so it gets a fixture GitLab on a free local
# port and never sees the real one. Label names come from the real
# config/project.json, because ONESHOT_HOME is this checkout.
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
# A block is decision:block with its reason and no `continue` or `stopReason`.
# The token is never printed or logged. Each <text> must appear. Counts only a
# failure, so the section still reports one line per case.
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

# ---------------------------------------------------------------- artifact-guard
#
# RUN=<the run directory the test env already scopes writes to>. The deny cases
# are a handoff and the journal; the allow cases are the three *-partial.json
# backstops a prompt actually asks for, and anything one level deeper — a
# session's own scratch is none of this guard's business.
echo
echo "artifact-guard"
RUN="$ROOT/state/runs/0"
edit_json_payload() {
    printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"a","new_string":"b"}}' "$1"
}

expect_deny  "Write another phase's findings.json" \
                                       artifact-guard.cjs "$(write_payload "$RUN/findings.json")"
expect_deny  "Write verify.json (the merge gate reads it)" \
                                       artifact-guard.cjs "$(write_payload "$RUN/verify.json")"
expect_deny  "Write run.json (the journal, holds human approvals)" \
                                       artifact-guard.cjs "$(write_payload "$RUN/run.json")"
expect_deny  "Edit findings.json"      artifact-guard.cjs "$(edit_json_payload "$RUN/findings.json")"
expect_deny  "Write merge.json (name defaulted from the phase, not declared)" \
                                       artifact-guard.cjs "$(write_payload "$RUN/merge.json")"
expect_deny  "Write ANOTHER run's artifact" \
                                       artifact-guard.cjs "$(write_payload "$ROOT/state/runs/999/findings.json")"

expect_allow "Write review-partial.json (the sanctioned backstop)" \
                                       artifact-guard.cjs "$(write_payload "$RUN/review-partial.json")"
expect_allow "Write verify-partial.json" \
                                       artifact-guard.cjs "$(write_payload "$RUN/verify-partial.json")"
expect_allow "Write testcases-partial.json" \
                                       artifact-guard.cjs "$(write_payload "$RUN/testcases-partial.json")"
expect_allow "Write artifacts/verify.json (a subdirectory, not a handoff)" \
                                       artifact-guard.cjs "$(write_payload "$RUN/artifacts/verify.json")"
expect_allow "Write scratch/plan.json" artifact-guard.cjs "$(write_payload "$RUN/scratch/plan.json")"
expect_allow "Write a worktree file"   artifact-guard.cjs "$(write_payload "$ONESHOT_WORKTREE/apps/x/views.py")"

# The local-tests step's own records. Its crash recovery reads the resources file back
# and signals, frees, drops and removes what it names, so a session holding
# writes: ['run'] must not be able to write one.
expect_deny  "Write local-tests-resources.json (the run step's cleanup acts on it)" \
                                       artifact-guard.cjs "$(write_payload "$RUN/local-tests-resources.json")"
expect_deny  "Write local-tests-capture.json" \
                                       artifact-guard.cjs "$(write_payload "$RUN/local-tests-capture.json")"
expect_deny  "redirect into local-tests-seq" \
                                       artifact-guard.cjs "$(bash_payload "echo 99 > $RUN/local-tests-seq")"
expect_deny  "rm local-tests-resources.json after a cd" \
                                       artifact-guard.cjs "$(bash_payload "cd $RUN && rm local-tests-resources.json")"
expect_allow "cat local-tests-resources.json (reads are never refused)" \
                                       artifact-guard.cjs "$(bash_payload "cat $RUN/local-tests-resources.json")"
expect_allow "Write a file under artifacts/local-tests/" \
                                       artifact-guard.cjs "$(write_payload "$RUN/artifacts/local-tests/notes.md")"

# APFS is case-insensitive: Findings.json IS findings.json there, and so is a
# path whose directories are spelled in capitals.
expect_deny  "Write Findings.json (another spelling of the same file)" \
                                       artifact-guard.cjs "$(write_payload "$RUN/Findings.json")"
if [ -d "$ROOT/state" ] && [ -d "$ROOT/STATE" ]; then
    expect_deny  "Write through STATE/ on a case-insensitive volume" \
                                       artifact-guard.cjs "$(write_payload "$ROOT/STATE/runs/0/findings.json")"
else
    skip "Write through STATE/ on a case-insensitive volume" "case-sensitive volume, or no state/ yet"
fi

# The Bash surface. write-scope.cjs never sees these, which is the whole reason
# this guard watches both.
expect_deny  "redirect over verify.json" \
                                       artifact-guard.cjs "$(bash_payload "echo '{}' > $RUN/verify.json")"
expect_deny  "append to the journal"   artifact-guard.cjs "$(bash_payload "echo x >> $RUN/run.json")"
expect_deny  "python json.dump into findings.json" \
                                       artifact-guard.cjs "$(bash_payload "python3 -c \"import json;json.dump({}, open('$RUN/findings.json','w'))\"")"
expect_deny  "node writeFileSync into verify.json" \
                                       artifact-guard.cjs "$(bash_payload "node -e \"require('fs').writeFileSync('$RUN/verify.json','{}')\"")"
expect_deny  "cp over findings.json"   artifact-guard.cjs "$(bash_payload "cp /tmp/x.json $RUN/findings.json")"
expect_deny  "sed -i on verify.json"   artifact-guard.cjs "$(bash_payload "sed -i '' 's/fail/pass/' $RUN/verify.json")"
expect_deny  "tee into findings.json"  artifact-guard.cjs "$(bash_payload "echo '{}' | tee $RUN/findings.json")"
expect_deny  "rm the journal"          artifact-guard.cjs "$(bash_payload "rm $RUN/run.json")"
expect_deny  "absolute redirect after cd" \
                                       artifact-guard.cjs "$(bash_payload "cd $RUN && echo '{}' > $RUN/verify.json")"
expect_deny  "relative path from the conductor cwd" \
                                       artifact-guard.cjs "$(bash_payload "echo '{}' > state/runs/0/findings.json")"
expect_deny  "noclobber redirect (>|) over verify.json" \
                                       artifact-guard.cjs "$(bash_payload "echo '{}' >| $RUN/verify.json")"

# Where the shell stands. The commonest shape in the event log is
# `cd …/state/runs/<iid> && …` followed by a bare basename.
expect_deny  "cd into the run dir, then a relative redirect" \
                                       artifact-guard.cjs "$(bash_payload "cd $RUN && echo '{}' > verify.json")"
expect_deny  "relative rm from a session already standing in the run dir" \
                                       artifact-guard.cjs "$(bash_cwd_payload "$RUN" "rm findings.json")"
expect_deny  "cd via a literal \$ONESHOT_HOME, then a relative rm" \
                                       artifact-guard.cjs "$(bash_payload 'cd $ONESHOT_HOME/state/runs/0 && rm verify.json')"
expect_deny  "redirect into a literal \$ONESHOT_HOME path" \
                                       artifact-guard.cjs "$(bash_payload 'echo x > $ONESHOT_HOME/state/runs/0/run.json')"
expect_deny  "cd and rm inside a subshell" \
                                       artifact-guard.cjs "$(bash_payload "(cd $RUN && rm verify.json)")"
expect_allow "cd into the run dir, then a read" \
                                       artifact-guard.cjs "$(bash_payload "cd $RUN && cat verify.json > /tmp/v.json")"
expect_allow "cd into the run dir, then a partial" \
                                       artifact-guard.cjs "$(bash_payload "cd $RUN && echo '{}' > verify-partial.json")"
expect_allow "cd into the run dir, then on into artifacts/" \
                                       artifact-guard.cjs "$(bash_payload "cd $RUN && cd artifacts && echo '{}' > verify.json")"

# Taking a handoff away is as good as rewriting it: the merge gate reads a
# missing findings.json as "no findings".
expect_deny  "mv findings.json out of the run dir" \
                                       artifact-guard.cjs "$(bash_payload "mv $RUN/findings.json /tmp/x")"
expect_deny  "cp a file INTO the run dir under a handoff's name" \
                                       artifact-guard.cjs "$(bash_payload "cp /tmp/verify.json $RUN/")"
expect_deny  "rsync --remove-source-files from a handoff" \
                                       artifact-guard.cjs "$(bash_payload "rsync --remove-source-files $RUN/findings.json /tmp/")"
expect_deny  "rm -rf the whole run dir" \
                                       artifact-guard.cjs "$(bash_payload "rm -rf $RUN")"
expect_deny  "mv the whole run dir away" \
                                       artifact-guard.cjs "$(bash_payload "mv $RUN /tmp/x")"
expect_allow "rm -rf a scratch dir inside the run" \
                                       artifact-guard.cjs "$(bash_payload "rm -rf $RUN/scratch")"
expect_allow "mv within scratch/"      artifact-guard.cjs "$(bash_payload "mv $RUN/scratch/a $RUN/scratch/b")"
expect_allow "mv a partial out"        artifact-guard.cjs "$(bash_payload "mv $RUN/verify-partial.json /tmp/x")"
expect_allow "cp a handoff out (a read)" \
                                       artifact-guard.cjs "$(bash_payload "cp $RUN/findings.json /tmp/copy.json")"

# The other spellings of a write.
expect_deny  "pathlib write_text"      artifact-guard.cjs "$(bash_payload "python3 -c \"from pathlib import Path; Path('$RUN/findings.json').write_text('{}')\"")"
expect_deny  "os.remove"               artifact-guard.cjs "$(bash_payload "python3 -c \"import os; os.remove('$RUN/findings.json')\"")"
expect_deny  "os.rename onto verify.json" \
                                       artifact-guard.cjs "$(bash_payload "python3 -c \"import os; os.rename('/tmp/f', '$RUN/verify.json')\"")"
expect_deny  "shutil.copy onto verify.json" \
                                       artifact-guard.cjs "$(bash_payload "python3 -c \"import shutil; shutil.copy('/tmp/f', '$RUN/verify.json')\"")"
expect_deny  "open(..., 'r+')"         artifact-guard.cjs "$(bash_payload "python3 -c \"f=open('$RUN/findings.json','r+'); f.truncate(0)\"")"
expect_deny  "Path(...).open('r+')"    artifact-guard.cjs "$(bash_payload "python3 -c \"from pathlib import Path; Path('$RUN/verify.json').open('r+')\"")"
# A heredoc can put the path on the line after the call. Segments split on
# newlines, so only the pass over the whole command sees the two together.
expect_deny  "python heredoc: open( and its path on separate lines" \
                                       artifact-guard.cjs "$(bash_payload "python3 - <<'EOF'"$'\n'"with open("$'\n'"    '$RUN/verify.json', 'w') as f:"$'\n'"    f.write('{}')"$'\n'"EOF")"
expect_deny  "node heredoc: writeFileSync( and its path on separate lines" \
                                       artifact-guard.cjs "$(bash_payload "node - <<'EOF'"$'\n'"require('fs').writeFileSync("$'\n'"  '$RUN/verify.json',"$'\n'"  '{}')"$'\n'"EOF")"
expect_allow "python heredoc: a read whose path is on the next line" \
                                       artifact-guard.cjs "$(bash_payload "python3 - <<'EOF'"$'\n'"import json"$'\n'"with open("$'\n'"    '$RUN/verify.json') as f:"$'\n'"    print(json.load(f))"$'\n'"EOF")"
# That pass takes absolute paths only. A relative one means wherever the shell
# stood at that point, and here that is artifacts/, not the run directory.
expect_allow "cd on into artifacts/, then a relative python write" \
                                       artifact-guard.cjs "$(bash_cwd_payload "$RUN" "cd artifacts && python3 -c \"open('verify.json','w')\"")"
expect_deny  "sed -i.bak"              artifact-guard.cjs "$(bash_payload "sed -i.bak 's/fail/pass/' $RUN/verify.json")"
expect_deny  "sed --in-place"          artifact-guard.cjs "$(bash_payload "sed --in-place 's/fail/pass/' $RUN/verify.json")"
expect_deny  "find -name findings.json -delete" \
                                       artifact-guard.cjs "$(bash_payload "find $RUN -name findings.json -delete")"
expect_deny  "find over every run's verify.json" \
                                       artifact-guard.cjs "$(bash_payload "find $ROOT/state -name verify.json -delete")"
expect_deny  "find . -delete from a session standing in the run dir" \
                                       artifact-guard.cjs "$(bash_cwd_payload "$RUN" "find . -name findings.json -delete")"
expect_deny  "find . -delete from a conductor phase standing in \$ONESHOT_HOME" \
                                       artifact-guard.cjs "$(bash_cwd_payload "$ROOT" "find . -name verify.json -delete")"
expect_deny  "cd above state/runs, then find . -delete" \
                                       artifact-guard.cjs "$(bash_cwd_payload "$ONESHOT_WORKTREE" "cd $ROOT/state && find . -name verify.json -delete")"
# `.` is above state/runs only when the shell really stands there. Resolved
# against the $ONESHOT_HOME fallback as well, every worktree `find .` was.
expect_allow "find -name <handoff> -delete inside the worktree" \
                                       artifact-guard.cjs "$(bash_cwd_payload "$ONESHOT_WORKTREE" "find . -name verify.json -delete")"
expect_deny  "rm FINDINGS.JSON"        artifact-guard.cjs "$(bash_payload "rm $RUN/FINDINGS.JSON")"
expect_allow "shutil.copy a handoff out (a read)" \
                                       artifact-guard.cjs "$(bash_payload "python3 -c \"import shutil; shutil.copy('$RUN/findings.json', '/tmp/f.json')\"")"
expect_allow "sed -n over verify.json" artifact-guard.cjs "$(bash_payload "sed -n '/fail/p' $RUN/verify.json")"
expect_allow "find findings.json without deleting" \
                                       artifact-guard.cjs "$(bash_payload "find $RUN -name findings.json")"

expect_allow "cat findings.json (reads are never refused)" \
                                       artifact-guard.cjs "$(bash_payload "cat $RUN/findings.json")"
expect_allow "python json.load of testcases.json" \
                                       artifact-guard.cjs "$(bash_payload "python3 -c \"import json;d=json.load(open('$RUN/testcases.json'))\"")"
expect_allow "jq over verify.json"     artifact-guard.cjs "$(bash_payload "jq '.results' $RUN/verify.json")"
expect_allow "redirect into a partial" artifact-guard.cjs "$(bash_payload "echo '{}' > $RUN/verify-partial.json")"
expect_allow "grep -r for a finding id" \
                                       artifact-guard.cjs "$(bash_payload "grep -rn F-1 $RUN/findings.json")"
expect_allow "an ordinary build command" \
                                       artifact-guard.cjs "$(bash_payload 'npm test -- --watchAll=false')"

rm -rf "$ONESHOT_WORKTREE" "$LT"

echo
if [ "$FAIL" -eq 0 ]; then
    green "$PASS passed, 0 failed, $SKIP skipped"
    exit 0
else
    red "$PASS passed, $FAIL FAILED, $SKIP skipped"
    exit 1
fi
