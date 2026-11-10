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

## The ticket index

Beside the ticket folders, the root holds one spreadsheet, **Oneshot ticket
index**, with a row per ticket:

| Ticket | Title | Status | Current phase | Last updated | Plan | Research | Test cases | Demo PDF | Demo video | MR | Drive folder |
|---|---|---|---|---|---|---|---|---|---|---|---|

- **Ticket** links the full GitLab issue URL, with the iid as the text.
- **Status** is one of running, on a gate (parked waiting on a person),
  blocked, aborted, merged, or done (finished without a merge).
- The rest link the Drive files, the MR and the folder.

A ticket's row is found by its issue URL, so a re-run rewrites it rather than
adding a second one. A pass with nothing new writes nothing. The index is
updated by the same pass as the folder, in its own `try`: if Sheets refuses,
the folder still syncs and a `drive: ticket index not updated` warning is
logged.

The sheet is created by the app, so the `drive.file` sign-in covers it with no
extra consent. The **Google Sheets API** does need to be enabled on the same
Cloud project as the Drive API. It is free and needs no billing.

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

There are two ways in. Both give Oneshot one folder and nothing else; pick by
what your Google Workspace allows.

| | Service account | Your own sign-in (`drive.file`) |
|---|---|---|
| Use when | the folder can sit in a Shared Drive and be shared with an outside address | only My Drive, or no sharing outside the domain |
| What it can see | only the folder shared with it | only files and folders Oneshot itself created |
| Who owns the files | the Shared Drive | you (they count against your quota) |
| Credential | a service-account key | a refresh token tied to you; revoke it at myaccount.google.com → Security → Third-party connections |

Neither uses domain-wide delegation.

### Option B — your own sign-in, `drive.file` scope

1. In Google Cloud, enable the **Google Drive API** and the **Google Sheets
   API** (for the ticket index; both free, no billing). On the **OAuth consent
   screen**, choose user type **Internal** (an External app left in *Testing*
   status has its refresh tokens expire after 7 days) and add the scope
   `.../auth/drive.file`. Under **Credentials**, create an **OAuth client ID**
   of type **Desktop app** and download its JSON.
2. On a machine with a browser, sign in once:

   ```bash
   npm run drive:login -- --client ~/Downloads/client_secret.json --out ~/.config/oneshot/gdrive-user.json
   ```

   It opens Google's consent page, saves the refresh token to `--out` with
   mode 600, creates a root folder "Oneshot tickets" at the top of your My
   Drive (`--root-name` to change it), and prints the two `.env` lines. Under
   `drive.file` Oneshot cannot see a folder you made by hand, which is why the
   script makes it. Move, rename or share that folder freely afterwards.

   On a server with no browser, add `--no-browser` and run it there as the
   `oneshot` user with `--out /etc/oneshot/gdrive-user.json`: it prints the
   sign-in address; open it on your Mac, allow access, and the browser lands on
   a `127.0.0.1` page that cannot load. That is expected. Copy the whole
   address from the address bar and paste it back. (Google retired the old
   copy-a-code page, so this is how every CLI does it now.) Your password only
   ever goes to Google's own page.
3. Put those two lines in `.env` (on the server, copy the file to
   `/etc/oneshot/`, mode 600, owner `oneshot`) and continue at step 5 below.

### Option A — service account

1. In a Google Cloud project, enable the **Google Drive API** and the
   **Google Sheets API**, create a
   **service account**, and create a **JSON key** for it.
2. Pick (or create) the root folder **inside a Shared Drive**: a service
   account has no storage of its own, so uploads into a folder in someone's My
   Drive fail with `storageQuotaExceeded`. In a Shared Drive the files belong to
   the drive, not to the uploader.

   Give the service account access to **that one folder only**, not to the
   whole drive: open the folder → Share → add the service account's email as
   **Contributor** (enough to create and replace files). It then sees nothing
   else in Drive — no domain-wide delegation is used or needed. Two org
   settings can block this, and both need a Workspace admin:
   - folder sharing by Content managers may be turned off for the drive, and
   - the service account's address ends in `iam.gserviceaccount.com`, which is
     outside your domain, so the drive's external-sharing rule must allow it
     (or the admin allowlists that address).

   Share the folder with the people who should read it; it holds ticket content.
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
  `node:crypto` or a refresh-token grant, chosen by the credential file, and
  list / create folder / resumable upload. No `googleapis` dependency.
- `src/lib/drivesync.ts` — the reconcile pass, the PDF build and the
  `journal.drive` ledger.
- `scripts/drive-sync.ts` — `npm run drive:sync`.
- `scripts/drive-login.ts` — `npm run drive:login`, the one-time sign-in for option B.
