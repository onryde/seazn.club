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
//     scripts/matrix until this move merges);
//   - the lines an executed plan records (cli-invocation.test.ts reads a
//     plan's `--import ./scripts/matrix/lib/crash-exit.ts` as the preload).
// All of them must read a recorded path as history, never edit it to suit the
// live tree. Two files did not move with the directory: they left the harness
// for scripts/lib (RELOCATED_FILES below). Nothing else in the harness may
// spell the old directory.

/** Today's harness directory, repo-relative. */
export const HARNESS_DIR = "tools/matrix";

/** Every directory the harness has lived in before HARNESS_DIR, newest
 *  first. Append, never rewrite: an entry is a fact about recorded history. */
export const HISTORICAL_HARNESS_DIRS: readonly string[] = ["scripts/matrix"];

/** Single files that left the harness instead of moving with it: recorded
 *  path → today's path. The directory map alone would send them into
 *  HARNESS_DIR, where they no longer exist. Both are shared with repo gates
 *  that are not harness code — the boundary gates import main-module.ts, and
 *  reference:boundary preloads crash-exit.ts, spawned by packages/reference's
 *  test — and nothing outside tools/ may reach tools/ (ruling 56; C3a lifted
 *  main-module.ts, CL-R4 lifted crash-exit.ts). Consulted before the
 *  directory map. Append, never rewrite: an entry is a fact about history. */
export const RELOCATED_FILES: Readonly<Record<string, string>> = {
  "scripts/matrix/lib/crash-exit.ts": "scripts/lib/crash-exit.ts",
  "scripts/matrix/lib/main-module.ts": "scripts/lib/main-module.ts",
};

function within(path: string, dir: string): string | null {
  if (path === dir) return "";
  return path.startsWith(`${dir}/`) ? path.slice(dir.length) : null;
}

/** A repo-relative path as recorded at some commit → the same file's path in
 *  today's tree. A relocated file maps to where it lives now; any other path
 *  under a historical harness directory maps into HARNESS_DIR; any other path
 *  is returned unchanged. */
export function livePath(recorded: string): string {
  if (Object.hasOwn(RELOCATED_FILES, recorded)) return RELOCATED_FILES[recorded];
  for (const dir of HISTORICAL_HARNESS_DIRS) {
    const rest = within(recorded, dir);
    if (rest !== null) return `${HARNESS_DIR}${rest}`;
  }
  return recorded;
}

/** Every spelling a live path has had, today's first — the candidates to try
 *  at a ref that may predate the move. Exactly the recorded paths livePath
 *  maps to `live`: a relocated file's recorded path, or a harness path at
 *  each historical directory (never one a relocation claims). Any other path
 *  has only itself. */
export function spellingsOf(live: string): string[] {
  const relocated = Object.keys(RELOCATED_FILES).filter((from) => RELOCATED_FILES[from] === live);
  const rest = within(live, HARNESS_DIR);
  const moved = rest === null ? [] : HISTORICAL_HARNESS_DIRS.map((dir) => `${dir}${rest}`).filter((p) => !Object.hasOwn(RELOCATED_FILES, p));
  return [live, ...relocated, ...moved];
}
