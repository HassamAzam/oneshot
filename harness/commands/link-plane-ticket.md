---
description: Mirror a Plane (projects.arbisoft.com) ticket referenced by an MR into a GitLab issue and add a [closes #N] link.
argument-hint: "[<mr-url-or-iid>]  (omit to batch-scan my open MRs)"
---

# /link-plane-ticket — Plane ticket → GitLab issue → MR `[closes #N]`

Our MRs reference Plane tickets (`projects.arbisoft.com/.../browse/<KEY>-<N>/`) instead of
GitLab issues, so the MR never auto-links to a GitLab issue. This command, for each target MR:

1. Extracts the Plane ticket key from the MR description.
2. Reads the Plane ticket via the **Plane MCP** (already authenticated).
3. Creates (or reuses) a mirrored **GitLab issue** in `arbisoft/erp`.
4. Prepends `[closes #<iid>]` to the MR description.

The GitLab work (create issue, patch MR) is done by the deterministic script
`.claude/scripts/plane_ticket_to_gitlab.py` — this command only resolves Plane data and confirms.

## Step 1 — Resolve the target MR(s)

- **`$ARGUMENTS` is an MR URL or bare IID** → that single MR. Parse the IID from a URL of the form
  `https://gitlab.arbisoft.com/arbisoft/erp/-/merge_requests/<IID>`.
- **`$ARGUMENTS` is empty (batch mode)** → fetch my open MRs and process every one that references a
  Plane ticket but has no `[closes #` line yet. Token is in `$GITLAB_ERP_ACCESS_TOKEN`:

  ```bash
  for role in author_username assignee_username; do
    curl -s -H "PRIVATE-TOKEN: $GITLAB_ERP_ACCESS_TOKEN" \
      "https://gitlab.arbisoft.com/api/v4/projects/arbisoft%2Ferp/merge_requests?state=opened&$role=ibrahim.noor&per_page=100"
  done
  ```

  Merge the two result sets by `iid` (dedupe). Keep only MRs whose `description` matches the Plane
  regex below **and** does not already contain `[closes #`.

## Step 2 — Extract the Plane key from each MR description

Match against the MR `description`:

```
projects\.arbisoft\.com/[^)\s]*browse/([A-Z][A-Z0-9]*)-(\d+)
```

Group 1 = `project_identifier` (e.g. `WORKSTREAMFE`), group 2 = `issue_identifier` (e.g. `24`).
The full key is `<project_identifier>-<issue_identifier>` and the canonical Plane URL is
`https://projects.arbisoft.com/arbisoft/browse/<KEY>/`.

If an MR has no Plane reference, skip it (report it as skipped, don't error).

## Step 3 — Read the Plane ticket via MCP

```
mcp__plane__get_issue_using_readable_identifier(
    project_identifier=<group 1>, issue_identifier=<group 2>)
```

From the result keep: `name` (→ issue title), `description_html`, `priority`, `project` (UUID),
and `state` (UUID). Resolve the state UUID to a human name with
`mcp__plane__get_state` (pass the `project` UUID + `state` UUID). If the state lookup fails, fall
back to `state_name: "unknown"` — do not block on it.

## Step 4 — Show the plan and confirm

Before any write, present a compact summary and **wait for explicit approval**:

```
MR  !<iid>  <mr title>
  Plane:  <KEY> — <plane ticket name>
  Will:   create GitLab issue (label: plane-import, assignee: <MR assignee or "none">)
          + add [closes #<new-iid>] to the MR description

Proceed?
```

In batch mode, list every MR in one block and confirm **once** for the whole set.

## Step 5 — Run the deterministic script (per MR)

Pipe one JSON object per MR to the script on stdin (large HTML bodies escape badly in a shell
heredoc — stage the payload via a small gitignored `tmp_scripts/` runner that builds the dict in
Python and feeds it to the script with `subprocess`, rather than inlining the HTML):

```bash
python3 .claude/scripts/plane_ticket_to_gitlab.py <<'JSON'
{
  "mr_iid": <iid>,
  "plane_key": "<KEY>",
  "plane_url": "https://projects.arbisoft.com/arbisoft/browse/<KEY>/",
  "title": "<Plane name>",
  "description_html": "<Plane description_html>",
  "priority": "<Plane priority>",
  "state_name": "<resolved state name>"
}
JSON
```

The script resolves the issue in this order, idempotently:

1. **Exact reuse** — an open issue already carrying this Plane key (hidden `<!-- plane-key: <KEY> -->`
   marker or the key in its title) is reused, no new issue created.
2. **Similarity gate** — otherwise it searches open issues by the title's distinctive keywords and
   scores them by title token-overlap. If any clear the threshold it makes **no changes** and returns
   `{"ok": true, "needs_decision": true, "similar": [{"iid","title","web_url","score"}, ...]}`.
3. **Create** — only when nothing similar is found does it create the `plane-import` issue (creating
   the label if missing, assigning the MR's assignee).

In all writing paths it then prepends `[closes #<iid>]` to the MR (skipped if already present) and
prints `{"ok": true, "issue_iid": ..., "issue_action": "created|reused|linked", "mr_updated": ...}`.

### Step 5a — Handle `needs_decision`

When the script returns `needs_decision`, do **not** create anything. Show the candidates and ask:

```
A similar open GitLab issue already exists for Plane ticket <KEY>:

  #<iid>  (score <score>)  <title>
          <web_url>
  ...

Options:
  1. Link an existing issue (give its number) — adds [closes #N] to the MR, no new issue.
  2. Create a new issue anyway.
  3. Skip this MR.
```

Re-run the script with the same payload plus the chosen control:
- **Link existing #N** → add `"link_issue_iid": N`.
- **Create anyway** → add `"force_create": true`.
- **Skip** → move on, no re-run.

In batch mode, collect all `needs_decision` MRs and ask about them together after the auto-resolved
ones are done.

## Step 6 — Report

Per MR, print one line:

```
!<mr_iid>  →  issue #<issue_iid> (<created|reused>)  <issue_url>   [MR description updated|already linked]
```

If `ok` is `false`, print the script's `error` and continue to the next MR (don't abort the batch).

## Hard rules

- **Never write before Step 4 approval.** Both the issue creation and the MR-description edit are
  outward-facing.
- Never fabricate a Plane key — only use one matched from an MR description by the Step 2 regex.
- Never print `$GITLAB_ERP_ACCESS_TOKEN`.
- `[closes #<iid>]` is a short ref that resolves within `arbisoft/erp`. Note these MRs usually target
  `dev`, not the default branch — GitLab records the link but only auto-closes the issue when the MR
  merges into the default branch. The link is the deliverable; auto-close on `dev` is not expected.
- This command edits MRs authored by other people. In batch mode, only touch MRs where I
  (ibrahim.noor) am the author or assignee.
```
