// Where the harness lives, and where it USED to live — the one place that
// knows both (ruling 56, 2026-10-04).
//
// The harness was scripts/matrix until ruling 56 made it the tools/matrix
// workspace (@seazn/matrix). Two kinds of reader still meet the old path:
//   - committed evidence (truth-runs/: results, TRIAGE.md, draw-counts.json,
//     W1-DRIVING-REBASES.md) records the tree AT ITS RECORDED COMMIT and is
//     never rewritten (REBASE-R3);
//   - git refs that predate the move (the single-sport ratchet's
//     `--against HEAD^1` reads the base branch, whose harness is still
//     scripts/matrix until this move merges).
// Both must read a recorded path as history, never edit it to suit the live
// tree. Nothing else in the harness may spell the old directory.

/** Today's harness directory, repo-relative. */
export const HARNESS_DIR = "tools/matrix";

/** Every directory the harness has lived in before HARNESS_DIR, newest
 *  first. Append, never rewrite: an entry is a fact about recorded history. */
export const HISTORICAL_HARNESS_DIRS: readonly string[] = ["scripts/matrix"];

function within(path: string, dir: string): string | null {
  if (path === dir) return "";
  return path.startsWith(`${dir}/`) ? path.slice(dir.length) : null;
}

/** A repo-relative path as recorded at some commit → the same file's path in
 *  today's tree. A path under a historical harness directory maps into
 *  HARNESS_DIR; any other path is returned unchanged. */
export function livePath(recorded: string): string {
  for (const dir of HISTORICAL_HARNESS_DIRS) {
    const rest = within(recorded, dir);
    if (rest !== null) return `${HARNESS_DIR}${rest}`;
  }
  return recorded;
}

/** Every spelling a live harness path has had, today's first — the
 *  candidates to try at a ref that may predate the move. A path outside
 *  HARNESS_DIR has only itself. */
export function spellingsOf(live: string): string[] {
  const rest = within(live, HARNESS_DIR);
  if (rest === null) return [live];
  return [live, ...HISTORICAL_HARNESS_DIRS.map((dir) => `${dir}${rest}`)];
}
