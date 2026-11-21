import "server-only";
import { log } from "@/server/logger";
import { EngineError, StageKind } from "@seazn/engine/core";
import { type BracketStage } from "@seazn/engine/competition";

// americano folds like a table stage (Jul3/08 §3): its pair fixtures feed the
// standard standings machinery.
export const TABLE_KINDS = new Set(["league", "group", "swiss", "americano"]);

// L3/#414 pass 2 — the bracket-shaped kinds. TABLE_KINDS (4) ∪ {"ladder"} (1)
// ∪ BRACKET_KINDS (4) = 9 = every StageKind value: completeStageIfReady's
// branch below is exhaustive by construction, not by the type checker (kind
// is validated from a raw DB string at the loadStageInputs boundary, so TS
// can't prove the three branches cover it statically — see parseStageKind).
// Exported (round-4 review, B) so bracket-kinds-sync.test.ts can pin this
// literal against its two hand-copied siblings (usecases/stages/ folder's own
// BRACKET_KINDS, the engine's BRACKET_STAGE_KINDS) — see that test's header
// comment for why an unsynced 5th bracket kind is a silent, fail-open hazard.
export const BRACKET_KINDS = ["knockout", "double_elim", "stepladder", "page_playoff"] as const;
export function isBracketKind(kind: StageKind): kind is BracketStage["kind"] {
  return (BRACKET_KINDS as readonly string[]).includes(kind);
}

// L3/#414 pass 2 — `stages.kind` arrives from loadStageInputs's row as a raw
// `string`. The DB CHECK constraint (V298__page_playoff_stage_kind.sql) keeps
// it in the same 9 values as the engine's StageKind, but nothing upstream of
// here ever verified that — the two deleted casts (`as StageCtx["kind"]`,
// `as never`) just told the type checker to trust it. Parse once, reuse the
// validated value everywhere a kind is needed, and fail loudly instead of
// silently absorbing a value the engine doesn't recognise (e.g. the CHECK
// constraint drifting from StageKind again in a future migration).
export function parseStageKind(raw: string, stageId: string): StageKind {
  const parsed = StageKind.safeParse(raw);
  if (!parsed.success) {
    log.error({ event: "stage_kind_invalid", stageId, kind: raw }, "unknown stage kind from DB");
    throw new EngineError("CONFIG_INVALID", `stage ${stageId} has unknown kind "${raw}"`, {
      stageId,
      kind: raw,
    });
  }
  return parsed.data;
}
