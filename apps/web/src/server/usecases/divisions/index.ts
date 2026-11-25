import "server-only";
// Division use-cases (doc 08 §3, doc 06). Creation snapshots the merged
// variant config and PINS the sport module version (doc 02 §4) so a running
// division always replays under the rules it started with.
//
// Split by concern (src/server/MODULARIZATION.md). This folder replaces the single `divisions.ts`; importers keep
// `from "@/server/usecases/divisions"` and land here. The barrel re-exports exactly the public surface the file had;
// siblings never import it.
//
//   types       the division row, its column list (COLS, sibling-only) and the variant option the format editor offers
//   helpers     deriveYouth, and the finished-competition guard create and restore share (assertCompetitionNotEnded, sibling-only)
//   queries     the read paths: variant options, a competition's divisions, one division, the sports an org has run
//   create      createDivision (plan cap, online-chess flag, the competition delete's shared lock, the Online Chess package row) and fireDivisionCreated
//   lifecycle   delete (with the Online Chess package refund), archive and restore a division; the danger zone's refund read
//   patch       patchDivision, the PATCH door (format lock, age band and cutoff, camera policy, online save, public cache expiry) and its PatchDivisionResult

export type { DivisionRow, VariantOption } from "./types";
export { deriveYouth } from "./helpers";
export { listVariantOptions, listDivisions, getDivision, recentDivisionSports } from "./queries";
export { fireDivisionCreated, createDivision } from "./create";
export { deleteDivision, archiveDivision, restoreDivision, divisionPackageRefund } from "./lifecycle";
export type { DivisionPackageRefund } from "./lifecycle";
export { patchDivision } from "./patch";
export type { PatchDivisionResult } from "./patch";
