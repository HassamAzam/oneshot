---
name: mr-to-ticket
description: Create the missing arbisoft/erp GitLab issue for a merge request that has none, assign it to the MR author, and prepend "Closes #<issue>" to the MR. Use when given a GitLab MR URL/iid without a ticket.
---

# MR → ticket

The work already exists, so the issue always goes to people. `groom.py` does every write.

1. `python3 ~/.claude/scripts/groom.py mr <iid>` — the MR's title, description, author, branches.
2. Dry-run the create below with `--dry-run`, show the user `label_reasons`, and wait for their yes.
3. Create with `--confirm-labels "<approved list>"`, with a body built from the MR (PR-Bot "Description" → Summary, "File Walkthrough" → Changes):
   ```bash
   python3 ~/.claude/scripts/groom.py create --mr <iid> --title "<title>" --kind <kind> --size <size> --confirm-labels "<approved>" <<'GROOM_BODY'
   ## Summary
   - <what the MR does>

   ## Changes
   - <file or area — change>

   ## Related MR
   !<iid> by <author> — `<source>` → `<target>`
   GROOM_BODY
   ```
   The author is assigned and the MR description gets `Closes #<issue>` prepended; nothing else in it changes.

## Before you finish
- [ ] The user approved the labels before the real create
- [ ] Summary and Changes come from the MR, not from guessing at the code
- [ ] The output shows the issue URL and `mr: !<iid> now closes #<issue>`
