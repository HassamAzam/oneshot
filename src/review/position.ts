/**
 * Where on a merge request's diff a finding can be pinned. Pure.
 *
 * GitLab accepts a diff comment only on a line the diff actually shows: an
 * added line (new line number alone) or an unchanged line inside a hunk (old
 * AND new number). A finding about any other line — outside every hunk, in a
 * file the MR does not touch, or in a diff GitLab collapsed — is refused with a
 * 400. So the mapping is worked out here from the same hunks GitLab renders,
 * and a line it cannot place is posted on the MR as a whole, with the location
 * written into the note instead of losing the finding.
 */

/** The subset of one changed file this module reads (src/lib/gitlab.ts, MrDiff). */
export interface DiffFile {
  old_path: string;
  new_path: string;
  diff: string;
  deleted_file?: boolean;
}

/** A line of the new file as the diff shows it. `oldLine` only for an unchanged (context) line. */
export interface DiffLine {
  oldPath: string;
  newPath: string;
  newLine: number;
  oldLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A finding's `file` as git names it: relative to the repository root.
 *
 * A reviewer is asked for that form and does not always return it. Its
 * sub-agents are handed absolute paths, so a finding comes back as
 * `/srv/erp-wt/t9174-…/apps/teams/admin.py`; a path copied from a diff header
 * arrives as `./apps/…`. Either one fails the exact match a diff position needs
 * (the thread then lands unpinned, with a server path printed in it) and the
 * "file changed since the last review" test a re-check's new findings are held
 * to (the finding is then dropped). `root` is the run's worktree.
 */
export function repoPath(file: unknown, root?: string | null): string {
  let f = String(file ?? '').trim().replace(/\\/g, '/');
  const r = String(root ?? '').replace(/\/+$/, '');
  if (r && f.startsWith(`${r}/`)) f = f.slice(r.length + 1);
  return f.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** Every line of one file's new side that its unified diff shows, keyed by new line number. */
export function shownLines(diff: string): Map<number, { oldLine?: number }> {
  const out = new Map<number, { oldLine?: number }>();
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  for (const line of String(diff ?? '').split('\n')) {
    const h = HUNK.exec(line);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) { out.set(newN, {}); newN += 1; }
    else if (line.startsWith('-')) { oldN += 1; }
    else if (line.startsWith('\\')) { /* "\ No newline at end of file" — not a line */ }
    else { out.set(newN, { oldLine: oldN }); oldN += 1; newN += 1; }
  }
  return out;
}

/**
 * The diff line a finding at `file:line` sits on, or null when the diff does
 * not show that line. `file` is matched against the NEW path: a finding is
 * about the code as it now stands.
 */
export function diffLineFor(files: DiffFile[], file: string, line: number): DiffLine | null {
  const wanted = String(file ?? '').replace(/^\.?\//, '');
  const f = files.find((x) => x.new_path === wanted && !x.deleted_file);
  if (!f || !Number.isInteger(line) || line < 1) return null;
  const hit = shownLines(f.diff).get(line);
  if (!hit) return null;
  return {
    oldPath: f.old_path, newPath: f.new_path, newLine: line,
    ...(hit.oldLine === undefined ? {} : { oldLine: hit.oldLine }),
  };
}
