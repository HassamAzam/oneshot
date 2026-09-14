---
description: Backmerge a source branch into a target branch — creates (or finds) the MR, detects conflicts, and optionally resolves them for you before returning the MR URL.
argument-hint: "[source-branch] [target-branch]"
---

# /backmerge — Backmerge Source Branch into Target

## Allowed paths

Only two directions are permitted:

| Source   | Target  |
|----------|---------|
| `master` | `stage` |
| `stage`  | `dev`   |

Reject any other pair immediately.

**Special case — `master → dev`:** Not a valid single-step path. Automatically treat as two hops: `master → stage`, then `stage → dev`. Inform the user: _"`master → dev` requires two hops: running `master → stage` first, then `stage → dev`."_

---

## Step 0 — Collect inputs

Ask using `AskUserQuestion`:

**"Which backmerge do you want to run?"**
- `master → stage`
- `stage → dev`
- `Both (master → stage, then stage → dev)`

If `$ARGUMENTS` has two words, validate against allowed paths and skip the question. If the words are `master` and `dev`, treat as "Both".

---

## Step 1 — Orient

```bash
git fetch origin <source> <target>
git log origin/<target>..origin/<source> --oneline | head -20
git log origin/<source>..origin/<target> --oneline | head -20
```

Print: `Backmerging <source> → <target> | <source> is N ahead, target is M ahead`

If source is 0 commits ahead, stop: nothing to backmerge.

---

## Step 2 — Find or create the MR

Read from `.claude/settings.local.json`: `integrations.gitlab.token`, `integrations.gitlab.api_url`, `integrations.gitlab.project`.

Search for an open MR:
```bash
curl -s -H "PRIVATE-TOKEN: <TOKEN>" "<API>/projects/<PROJECT>/merge_requests?state=opened&source_branch=<source>&target_branch=<target>"
```

If none found, create one:
```bash
curl -s -X POST -H "PRIVATE-TOKEN: <TOKEN>" -H "Content-Type: application/json" \
  "<API>/projects/<PROJECT>/merge_requests" \
  -d '{"source_branch":"<source>","target_branch":"<target>","title":"<source> -> <target>","description":"Backmerge of `<source>` into `<target>` via /backmerge.","remove_source_branch":false}'
```

Note the `iid` and `web_url`.

---

## Step 3 — Check for conflicts

Fetch `detailed_merge_status` from the MR. If `"checking"` or `"preparing"`, wait 5 s and retry once.

- `"mergeable"` or `"ci_still_running"` → proceed to Step 3a
- `"conflict"` → continue to Step 4
- Anything else → print status + MR URL and stop

---

## Step 3a — Ask about merging (single-leg run)

> Use this step when running a **single leg** (`master → stage` OR `stage → dev`).

Ask using `AskUserQuestion`:

**"MR <web_url> is created. Should I wait for the pipeline to pass (checking every 2 mins) and merge automatically?"**
- **Yes, wait and merge for me** → poll every 2 minutes; when `detailed_merge_status` is `"mergeable"`, merge via API and print the Step 6 summary.
- **No, I'll merge it myself** → print MR URL and stop.

Polling loop (if auto-merge chosen):
```bash
# every 2 minutes:
curl -s -H "PRIVATE-TOKEN: <TOKEN>" "<API>/projects/<PROJECT>/merge_requests/<iid>"
# "mergeable"              → merge and finish
# "ci_still_running" / "checking" / "preparing" → wait another 2 min
# "not_approved" / "blocked_*" / "conflict"     → stop, print status + MR URL
```

Use `ScheduleWakeup` with `delaySeconds: 120` to poll — do not busy-wait.

Merge call:
```bash
curl -s -X PUT -H "PRIVATE-TOKEN: <TOKEN>" -H "Content-Type: application/json" \
  "<API>/projects/<PROJECT>/merge_requests/<iid>/merge" \
  -d '{"merge_commit_message":"<source> -> <target>"}'
```

---

## Step 3b — Ask about merging (two-hop: master → dev)

> Use this step for Leg 1 (`master → stage`) when the overall run is `master → dev`.

Ask using `AskUserQuestion`:

**"Leg 1 MR (master → stage) <web_url> is created. Should I wait for the pipeline to pass and merge automatically?"**
- **Yes, wait and merge for me** → poll every 2 minutes; when mergeable, merge via API, then automatically proceed to Leg 2 (stage → dev).
- **No, I'll merge it myself** → print MR URL and inform: _"I'll check every 2 minutes to detect when you've merged it, then automatically kick off stage → dev."_ Poll every 2 minutes using `ScheduleWakeup` with `delaySeconds: 120` and `git fetch origin stage dev && git log origin/dev..origin/stage --oneline | wc -l` until the count is > 0, then proceed to Leg 2.

In both cases, once Leg 1 is confirmed merged and stage has new commits, run Steps 1–6 for Leg 2 (`stage → dev`), applying **Step 3a** for that leg.

---

## Step 4 — Ask how to resolve conflicts

**"The MR has conflicts. How should they be resolved?"**
- **Resolve them for me** → continue to Step 5
- **I'll do it myself** → list conflicting files (`git diff --name-only --diff-filter=U`), print MR URL, stop

---

## Step 5 — Resolve conflicts

```bash
git stash push -u -m "backmerge-wip-$(date +%s)"
git checkout <source> && git pull origin <source>
git merge --no-commit --no-ff origin/<target>
```

For each file in `git diff --name-only --diff-filter=U`:

1. Show ours vs theirs using index blobs (`git ls-files --unmerged <file>` + `git cat-file blob <hash>`)
2. Ask: **Keep ours / Keep theirs / Describe resolution**
3. Write chosen blob to file and `git add <file>`

Then commit and push:
```bash
git commit -m "chore: merge <target> into <source> to resolve backmerge conflicts"
git push origin <source>
git stash list | grep "backmerge-wip" && git stash pop
```

If the pre-commit hook fails, show output and stop — never use `--no-verify`.

---

## Step 6 — Return

Wait 3 s, re-fetch MR status, then print:
```
Backmerge complete.
  Source:  <source>
  Target:  <target>
  MR:      <web_url>
  Status:  <detailed_merge_status>
```

---

## Hard rules

- Only `master → stage` and `stage → dev` are valid — reject all other pairs
- Always merge `<target>` into `<source>`, never the reverse
- Never commit in a conflict state
- Never skip pre-commit hooks
- Never print `GITLAB_TOKEN`
- Always stash before touching the working tree
- Never force-push
