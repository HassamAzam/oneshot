import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every run directory we can read: state/runs/<iid> and state/runs-archive/<name>. */
export function runDirs(oneshotHome) {
  const out = [];
  const runs = join(oneshotHome, 'state', 'runs');
  if (existsSync(runs)) {
    for (const name of readdirSync(runs)) {
      const iid = Number(name);
      if (!Number.isInteger(iid) || iid <= 0) continue;
      out.push({ dir: join(runs, name), iid, archived: false });
    }
  }
  const arch = join(oneshotHome, 'state', 'runs-archive');
  if (existsSync(arch)) {
    for (const name of readdirSync(arch)) {
      const dir = join(arch, name);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const iid = Number((name.match(/^(\d+)/) || [])[1]);
      out.push({ dir, iid: Number.isInteger(iid) ? iid : 0, archived: true });
    }
  }
  return out;
}

export function readJournal(dir) {
  const f = join(dir, 'run.json');
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j && j.runId ? j : null;
  } catch { return null; }
}

export const ts = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

export function journalToRun(j, operatorId, archived) {
  const ended = (j.phases || []).reduce((a, p) => Math.max(a, p.endedAt || 0), 0);
  const finished = ['done', 'blocked', 'aborted'].includes(j.status);
  return {
    run_id: j.runId,
    ticket_iid: j.iid,
    title: j.title ?? null,
    url: j.url ?? null,
    status: j.status ?? null,
    branch: j.branch ?? null,
    mr_iid: j.mrIid ?? null,
    merged_sha: j.mergedSha ?? null,
    deployed_sha: j.deployedSha ?? null,
    blocked_why: j.blockedWhy ? String(j.blockedWhy).slice(0, 2000) : null,
    operator_id: operatorId,
    archived: !!archived,
    started_at: ts(j.createdAt),
    ended_at: finished && ended ? ts(ended) : null,
  };
}

/** The journal's record for (phase, lap). The last matching record wins. */
export function phaseRecord(j, phase, lap) {
  let rec = null;
  for (const p of j.phases || []) if (p.phase === phase && (p.lap ?? 0) === lap) rec = p;
  return rec;
}

export const sessionKey = (runId, phase, lap) => `${runId}/${phase}/lap${lap}`;
