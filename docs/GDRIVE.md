# Google Drive ticket folders

Oneshot can keep one Google Drive folder per ticket, holding everything a run
produces, so the team has one place to browse per ticket — like a Confluence
space beside the GitLab issue. GitLab notes stay the timeline; the Drive folder
is the shelf. It is **off by default**.

## What the folder holds

Under the configured root, one folder per ticket named `<iid> — <title>` (the
folder's description is the full GitLab issue URL):

| File | From | Format |
|---|---|---|
| `00 README` | the run journal | Google Doc: issue URL, MR URL, branch, status, phase table, contents |
| `01 Research` | `research.json` | Google Doc — research is posted nowhere else |
| `02 Plan` | `plan.json` | Google Doc, the same markdown the plan note on GitLab uses |
| `03 Test cases` | `testcases.json` | Google Sheet, the team CSV format |
| `04 Verification` | `verify.json` | Google Doc, per-case results |
| `05 Review findings` | `findings.json` | Google Doc, verdict and each finding |
| `06 Demo — screenshots.pdf` | `ui-evidence.json` + its screenshots | PDF: a cover, then one screenshot per page with its caption, in the order ui-evidence listed them |
| `07 Demo video.webm` | `demo.json` (`artifacts/demo/`) | the recording as is |
| `Screenshots/` | `ui-evidence.json` | the individual images |

A file appears once its phase has written its artifact; the README lists what is
there so far. The run report (`report.html`) and transcripts are not uploaded:
they hold full session content and stay on the desk.

## How it updates

`src/lib/drivesync.ts` runs at the end of every `publishPending` pass (that is,
after every phase) and once more when a run finishes, parks or blocks, so the
README carries the final status.

It reconciles rather than queues: each pass maps the artifacts to files
(`src/lib/drivepack.ts`), hashes each one, and uploads only what changed since
the hash recorded in `run.json` under `drive`. A changed file is replaced in
place — same file, same link, and Drive keeps the old content as a revision. The
PDF is rebuilt only when a screenshot or caption changes.

Files are found by Drive `appProperties` (`oneshotTicket = <project>:<iid>` on
the folder, `oneshotKey` on each file), not by name. A ticket's second run
starts with a fresh journal and still finds the same folder and files, and a
title change renames the folder instead of making a new one. A file someone
deleted by hand is recreated on the next pass.

Edits made by hand to the Docs are overwritten the next time that artifact
changes. Comment on them instead.

Drive failures never fail or block a run. Each is logged as a `drive:` warning
and the pass moves on; after three consecutive failures (a bad credential fails
every call alike) the pass stops and the next one tries again. Under `DRY_RUN`
nothing is uploaded.

## Setup

1. In a Google Cloud project, enable the **Google Drive API**, create a
   **service account**, and create a **JSON key** for it.
2. Create a **Shared Drive** (a service account has no storage of its own and
   cannot own files in My Drive), add the service account's email as
   **Content manager**, and create the root folder in it. Share that Shared
   Drive with the people who should read the folders; it holds ticket content.
3. Put the key on the desk, readable only by the conductor's user:

   ```bash
   install -m 600 /path/to/key.json ~/.config/oneshot/gdrive-sa.json
   ```

   On the server, keep it under `/etc/oneshot/` (mode 600, owned by `oneshot`)
   and point to it from `/etc/oneshot/oneshot.env`.
4. Set both keys in `.env`:

   ```
   ONESHOT_GDRIVE_ROOT=<folder id, the last segment of the folder URL>
   ONESHOT_GDRIVE_CREDENTIALS=~/.config/oneshot/gdrive-sa.json
   ```

5. Check it, and backfill runs that finished before it was on:

   ```bash
   npm run drive:sync -- 9002
   ```

   With no iid it walks every run under `state/runs/`. It prints each folder's
   link and is safe to repeat.

The PDF is printed by Playwright's Chromium, which the desk already has for
verify and ui-evidence. If it cannot launch, the PDF is skipped with a warning
and everything else still uploads.

## Implementation map

- `src/lib/drivepack.ts` — pure: folder name, file mapping, the research /
  verification / review / README markdown, and the PDF page HTML. Tested in
  `drivepack.test.ts`.
- `src/lib/gdrive.ts` — the Drive REST client: a service-account JWT signed with
  `node:crypto`, and list / create folder / resumable upload. No `googleapis`
  dependency.
- `src/lib/drivesync.ts` — the reconcile pass, the PDF build and the
  `journal.drive` ledger.
- `scripts/drive-sync.ts` — `npm run drive:sync`.
