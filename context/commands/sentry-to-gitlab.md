---
description: Create a GitLab issue from a Sentry issue URL with label "prod-sentry".
argument-hint: "<sentry-issue-url>"
---

# /sentry-to-gitlab — Sentry Issue → GitLab Issue

Given a Sentry issue URL in `$ARGUMENTS`, fetch the issue details and create a formatted GitLab issue labelled `prod-sentry`.

## Step 1 — Read credentials

Read `.claude/settings.local.json` and extract:
- `integrations.sentry.auth_token` → `SENTRY_TOKEN`
- `integrations.sentry.base_url` → `SENTRY_BASE` (default: `https://sentry.io/api/0`)
- `integrations.gitlab.token` → `GITLAB_TOKEN`
- `integrations.gitlab.api_url` → `GITLAB_API`
- `integrations.gitlab.project` → `GITLAB_PROJECT`

If any are missing, stop and tell the user to add them to `.claude/settings.local.json` under `integrations`.

## Step 2 — Parse the Sentry URL

From `$ARGUMENTS`, extract the **issue ID** (the integer segment after `/issues/`).

Example:
- `https://workstream-991.sentry.io/issues/7395347447/?...` → issue ID = `7395347447`

If the URL doesn't match this pattern, tell the user and stop.

## Step 3 — Fetch issue from Sentry API

Run these two curl calls sequentially (the second depends on the first succeeding):

```bash
# Issue summary
curl -s -H "Authorization: Bearer <SENTRY_TOKEN>" \
  "<SENTRY_BASE>/issues/<ISSUE_ID>/"

# Latest event (stacktrace, tags, request context)
curl -s -H "Authorization: Bearer <SENTRY_TOKEN>" \
  "<SENTRY_BASE>/issues/<ISSUE_ID>/events/latest/"
```

From the **issue summary**, extract:
- `shortId` — e.g. `ERP-1YG`
- `title` — exception title
- `culprit` — endpoint or module
- `level` — error / warning / info
- `status` — unresolved / resolved
- `count` — total occurrences
- `userCount` — affected users
- `firstSeen` / `lastSeen`
- `permalink` — full Sentry URL

From the **latest event**, extract:
- Exception type and value
- Stacktrace: collect the last 5–8 `inApp=true` frames. For each frame include: `filename:lineNo in function`. If no in-app frames exist, fall back to the last 5 frames overall.
- `tags` — key/value pairs (environment, server, release, etc.)
- `request.url` and `request.method` if present

## Step 4 — Format the GitLab issue

Build the title and description using this exact template:

**Title:**
```
[Sentry <shortId>] <title>
```

**Description:**
```markdown
## Sentry Issue

| Field | Value |
|---|---|
| Short ID | `<shortId>` |
| Level | `<level>` |
| Status | `<status>` |
| Culprit | `<culprit>` |
| Occurrences | <count> |
| Affected users | <userCount> |
| First seen | <firstSeen> |
| Last seen | <lastSeen> |
| Sentry link | <permalink> |

## Exception

**Type:** `<exception_type>`

**Message:**
```
<exception_value>
```

## Stacktrace

```
<frame1_filename>:<lineNo> in <function>
<frame2_filename>:<lineNo> in <function>
...
```

## Tags

<tags as a bullet list: `key`: value>

## Request

**Method:** `<method>`  
**URL:** `<url>`

---
*Created automatically from Sentry via `/sentry-to-gitlab`*
```

## Step 5 — Create the GitLab issue

Run:

```bash
curl -s -X POST \
  -H "PRIVATE-TOKEN: <GITLAB_TOKEN>" \
  -H "Content-Type: application/json" \
  "<GITLAB_API>/projects/<GITLAB_PROJECT>/issues" \
  -d '{
    "title": "<title>",
    "description": "<description>",
    "labels": "prod-sentry"
  }'
```

Parse the response. On success (`id` present in response), print:

```
GitLab issue created: <web_url>
Sentry issue: <permalink>
```

On failure, print the full error response and stop.

## Hard rules

- Never print the `SENTRY_TOKEN` or `GITLAB_TOKEN` to the user.
- Always read credentials from `.claude/settings.local.json` — never ask the user to paste tokens.
- If the Sentry issue is already resolved (`status == "resolved"`), warn the user before creating the issue but still proceed unless they say no.
- Do not create the issue if the GitLab project already has an open issue with the same Sentry `shortId` in the title — check first with a search: `GET <GITLAB_API>/projects/<GITLAB_PROJECT>/issues?search=<shortId>&state=opened`.
