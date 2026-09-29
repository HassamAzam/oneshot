/**
 * Write memory for every merged run that predates merge writing it itself.
 *
 * Between 09-10 (memorize removed) and the merge hook, merged runs left no
 * card and no index line, so recall saw two tickets. This walks state/runs,
 * and for each run that was merged — by the pipeline, or by a person on GitLab —
 * writes its card and index line. Existing cards are
 * kept — #29 and #46 have richer ones a memorize session wrote.
 *
 *   npm run memory:backfill            # write
 *   npm run memory:backfill -- --dry   # list what would be written
 */
import { readdirSync } from 'node:fs';
import { RUNS } from '../src/lib/config.js';
import { readArtifact, readJournal } from '../src/lib/artifacts.js';
import { getIssue, getMergeRequest } from '../src/lib/gitlab.js';
import { writeMemory } from '../src/lib/memory.js';

const dry = process.argv.includes('--dry');

async function main(): Promise<void> {
  const iids = readdirSync(RUNS).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b);
  for (const iid of iids) {
    const journal = readJournal(iid);
    const sha = readArtifact<{ mergedSha?: string }>(iid, 'merge.json')?.mergedSha ?? journal?.mergedSha;
    // A person merging the MR (the qualityGate close-out, or a plain merge on
    // GitLab) leaves no sha in the run, so ask GitLab.
    let mergedByHand = false;
    if (!sha && journal?.status === 'done' && typeof journal.mrIid === 'number') {
      const mr = await getMergeRequest(journal.mrIid);
      mergedByHand = mr.ok && mr.data?.state === 'merged';
    }
    if (!sha && !mergedByHand) continue;
    const how = sha ? `merged ${sha.slice(0, 8)}` : `!${journal?.mrIid} merged by hand`;
    if (dry) { console.log(`#${iid} would be written (${how})`); continue; }
    const issue = await getIssue(iid);
    const line = writeMemory(iid, { labels: issue.ok ? issue.data?.labels : undefined, keepCard: true, mergedByHand });
    console.log(line
      ? `#${iid} ${line.modules.join(', ') || '(no module)'} — ${line.files.length} files${issue.ok ? '' : ' (labels unavailable)'}`
      : `#${iid} skipped: no journal`);
  }
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });
