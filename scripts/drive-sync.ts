/**
 * `npm run drive:sync -- <iid> [<iid>…]` — bring tickets' Google Drive folders
 * up to date from their run directories, and print each folder's link.
 *
 * The conductor does this on every phase pass; this is for backfilling runs
 * that finished before ONESHOT_GDRIVE_* was configured, and for checking a
 * credential by hand. Safe to repeat: unchanged files are not re-uploaded.
 */
import { existsSync, readdirSync } from 'node:fs';
import { RUNS } from '../src/lib/config.js';
import { driveConfig, syncDrive } from '../src/lib/drivesync.js';

async function main(): Promise<void> {
  if (!driveConfig()) {
    console.error('Drive is off: set ONESHOT_GDRIVE_ROOT and ONESHOT_GDRIVE_CREDENTIALS (see docs/GDRIVE.md).');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  if (args.some((a) => !/^\d+$/.test(a))) {
    console.error('usage: npm run drive:sync -- [<iid> …]   (no iid = every run under state/runs/)');
    process.exit(1);
  }
  const iids = args.length
    ? args.map(Number)
    : (existsSync(RUNS) ? readdirSync(RUNS) : []).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  let ok = 0;
  for (const iid of iids) {
    const url = await syncDrive(iid);
    if (url) ok += 1;
    console.log(`#${iid} ${url ?? '(no folder — see warnings above)'}`);
  }
  process.exit(ok === iids.length && ok > 0 ? 0 : 1);
}

void main();
