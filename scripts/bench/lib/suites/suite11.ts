// Suite 11 — "PDC Worlds". The first REAL suite through the pipeline B06a
// extracted, and the whole reason that extraction happened: adding a pack is
// now a suite definition plus a registry row, not a branch in `bench.ts`.
//
// The pack itself is built by `packs/build-packs/suite11.ts` from two
// committed primary-source datasets. This module is only identity — which
// pack to fold, and which key the report and log lines carry.
import { fileURLToPath } from "node:url";
import type { SuiteReport } from "../report.ts";
import { runPackSuite, type PackSuiteInput } from "./run-suite.ts";
import type { PlayDeclaration } from "./types.ts";

/** Resolved from THIS module rather than from the process cwd — the bench runs
 *  from the repo root via `npm run bench:scheduler` and from a worktree root
 *  in CI, and a cwd-relative path would silently read a different file (or
 *  none) between the two. Same reasoning as `tiny.ts`. */
export const SUITE11_PACK_PATH = fileURLToPath(new URL("../../packs/suite11.json", import.meta.url));

/** Both `suiteKey` and `packPath` are passed explicitly. The runner refuses to
 *  guess a missing `packPath` — it used to default to `_tiny`'s, which meant a
 *  suite that forgot to pass one folded the proof pack while reporting under
 *  its own name (B06a finding 3).
 *
 *  `play` (B07a T7 fix round 1, I1) — see `runTinySuite`'s own doc comment
 *  for why this is a parameter rather than something read off the row. */
export async function runSuite11(
  input: PackSuiteInput,
  play?: PlayDeclaration["play"],
): Promise<SuiteReport> {
  return await runPackSuite(input, {
    suiteKey: "suite11",
    packPath: SUITE11_PACK_PATH,
    ...(play === undefined ? {} : { play }),
  });
}
