---
description: Download the latest graphify knowledge graph (dev | stage | master) from the pipeline server. Hash-checked, decompresses in seconds.
argument-hint: "[dev|stage|master] [--force]"
---

# /get-graphify — Pull Graphify Knowledge Graph

Downloads the compressed graphify bundle for the requested branch and extracts it into `graphify-out/`. The bundle URL and SHA come from a live manifest hosted in the ERP repo's GitLab Package Registry — the build pipeline overwrites that manifest on every successful build (no MR involved), and this script fetches it on demand.

Hash is checked locally — if `graphify-out/.version` already matches the live manifest's SHA for the requested branch, the script exits immediately with no download.

## Allowed branches

- `dev`
- `stage`
- `master` (default if no argument given)

## Step 0 — Parse arguments

Parse `$ARGUMENTS`:
- First token (optional) → branch. Default: `master`.
- `--force` flag (optional) → ignore local SHA cache and re-download.

If the first token is not one of `dev`, `stage`, `master`, stop and tell the user the allowed values.

## Step 1 — Run the downloader

Run from the repo root:

```bash
bash scripts/get-graphify.sh <branch> [--force]
```

The script will:
1. Read the committed `graphify-manifest.json` stub to discover the package coordinates (project id, host, package name/version/filename).
2. Look up the GitLab token from `$GITLAB_TOKEN` or `~/.gitlab-token`. Fail with instructions if neither is set.
3. Fetch the live manifest from `…/packages/generic/graphify-manifest/latest/manifest.json` using the token.
4. Look up `<branch>` in the live manifest. If no entry exists, fail clearly and tell the user to trigger the pipeline for that branch first.
5. Compare `graphify-out/.version` against the manifest SHA. If they match, exit with `✓ already up to date`.
6. Download the compressed bundle (`curl --header "PRIVATE-TOKEN: ..."`).
7. Extract with `tar --use-compress-program="zstd -d"` into `graphify-out/`.
8. Write the new SHA to `graphify-out/.version`.

## Step 2 — Report

After the script finishes, print exactly what it printed (branch, SHA, file count). Do not paraphrase.

## Failure modes — how to respond

| Symptom | What to tell the user |
|---|---|
| `could not fetch live manifest (HTTP 404)` | The build pipeline has never published a manifest yet. Trigger the pipeline (any branch) on the pipeline server; the manifest is created automatically on the first successful build. |
| `could not fetch live manifest (HTTP 401 \| 403)` | The token is being rejected. Verify it has `read_api` scope and that the user is a member of `arbisoft/erp` on `gitlab.arbisoft.com`. |
| `no artifact published yet for branch` | The manifest exists but has no entry for the requested branch yet. Trigger the pipeline for that branch on the pipeline server. |
| `no GitLab token found` | Set `GITLAB_TOKEN` or write the token to `~/.gitlab-token`. The user's stored ERP PAT path is at `~/.claude/projects/-Users-…-erp/.gitlab-token` if that's where it lives. |
| `download failed` | Verify the token has `read_api` scope. If the artifact URL itself 404s, the package was removed from the registry — trigger the pipeline to republish. |
| `extraction failed` | The bundle is corrupted. Re-run with `--force`, or re-trigger the pipeline. |

## Notes

- `graphify-out/` is gitignored — only the small stub `graphify-manifest.json` is committed (and the stub never changes branch-to-branch, since the real manifest lives in the package registry).
- Required local tools: `curl`, `jq`, `zstd`, `tar` (all default on macOS; one-liner install on Ubuntu).
- Typical bundle size: ~3–15 MB compressed. Decompresses to ~300 MB+. Fits well under GitLab's 80 MB pipeline artifact limit.
- The manifest itself lives at `…/packages/generic/graphify-manifest/latest/manifest.json` — same project, same access control, same `PRIVATE-TOKEN` auth as the bundle.
