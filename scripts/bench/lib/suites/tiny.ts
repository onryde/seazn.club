// `_tiny` — the bench's own proof suite, and from B06a nothing more than a
// suite DEFINITION: which pack to fold, and which key the report and log lines
// carry. The pipeline it used to own now lives in `run-suite.ts`, unchanged in
// behaviour and shared with every pack suite B06b onward adds.
//
// Why this file still exists rather than the registry pointing straight at
// `runPackSuite`: `_tiny` is a suite like any other, and a suite's identity
// (its pack path, its key) belongs beside its name. The alternative — a
// registry row carrying a bare literal path — puts one suite's facts in the
// table that lists all of them.
import { fileURLToPath } from "node:url";
import type { SuiteReport } from "../report.ts";
import { runPackSuite, type PackSuiteInput } from "./run-suite.ts";

/** The committed micro-pack, resolved from THIS module rather than from the
 *  process cwd — the bench is run from the repo root by `npm run
 *  bench:scheduler` and from a worktree root by CI, and a cwd-relative path
 *  would silently read a different file (or none) between the two. */
export const TINY_PACK_PATH = fileURLToPath(new URL("../../packs/_tiny.json", import.meta.url));

/** Kept as the name eight test files already import. `_tiny` has no input of
 *  its own — every field on it is the general one. */
export type TinySuiteInput = PackSuiteInput;

/** The entry point `bench.ts` reaches through `SUITE_REGISTRY`.
 *
 *  The suite key is `"_tiny"` and the pack is this module's own: passing both
 *  explicitly is what lets `run-suite.ts` refuse to guess. The runner used to
 *  default a missing `packPath` to `TINY_PACK_PATH`, which meant a suite that
 *  forgot to pass one ran the proof pack and reported under its own name. */
export async function runTinySuite(input: TinySuiteInput): Promise<SuiteReport> {
  return await runPackSuite(input, { suiteKey: "_tiny", packPath: TINY_PACK_PATH });
}

// The pipeline's own helpers, re-exported because eight test files import them
// from this path and the move is meant to be invisible to them. A later wave
// may point those imports at `run-suite.ts` directly; doing it here would have
// mixed a rename across eight files into a behaviour-preserving move.
export {
  crossDivisionCourtClashes,
  divisionDeclaresOfficials,
  findExistingSeed,
  fixtureCountIssue,
  isRoundRobinStage,
  KEEP_BRANDING_KEY,
  registrationDivisionsOf,
  resolveScheduleLocks,
  selectedDivisionExposures,
  tinyPackStage,
} from "./run-suite.ts";
export type {
  RegistrationDriverContext,
  RegistrationDriverSet,
  ScheduleLockResolution,
} from "./run-suite.ts";
