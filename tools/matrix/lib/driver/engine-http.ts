// The product's EngineErrorCode → HTTP status map (apps/web/src/server/api-v1/http.ts
// ENGINE_HTTP), restated because http.ts imports next/server and cannot load
// under node --experimental-strip-types. engine-http.test.ts pins it entry for
// entry against that file's text and against EngineErrorCode.options, so a
// new engine code or a changed status reds here first (W1a carry 3).
import type { EngineErrorCode } from "@seazn/engine/core";

export const ENGINE_HTTP_STATUS: Readonly<Record<EngineErrorCode, number>> = Object.freeze({
  SEQ_CONFLICT: 409,
  SCHEDULE_CONFLICT: 409,
  INVALID_EVENT: 422,
  WRONG_PHASE: 422,
  ALREADY_DECIDED: 422,
  LINEUP_INVALID: 422,
  CONFIG_INVALID: 422,
  STAGE_NOT_READY: 422,
  DRAW_NOT_ALLOWED: 422,
  QUALIFICATION_INVALID: 422,
  ELIGIBILITY: 422,
  MODULE_NOT_FOUND: 422,
  MODULE_DUPLICATE: 500,
  NON_MONOTONIC_TIME: 422,
  EXPEDITE_WRONG_WINNER: 422,
  SUB_WINDOW_EXCEEDED: 422,
  UNKNOWN_PHASE: 422,
  GAME_AWARD_DURING_TIEBREAK: 422,
  SEEDING_RULES_MISSING: 422,
  SEEDING_MAP_SLOT_INVALID: 422,
  SEEDING_MAP_SOURCE_INVALID: 422,
  SEEDING_BESTNTH_UNEQUAL_POOLS: 422,
  SEEDING_MAP_SOURCE_AMBIGUOUS: 422,
});

/** The `?? 422` of http.ts:158 — what the product answers an EngineError whose
 *  code its map lacks. engine-http.test.ts pins it against that text. */
export const ENGINE_HTTP_FALLBACK = 422;

/** An EngineError's status, as http.ts:157-158 computes it:
 *  `ENGINE_HTTP[err.code] ?? 422`. For an EngineError ONLY — the product answers
 *  any other throw 500 INTERNAL (http.ts:244-247), so a caller must never pass
 *  a code read off something that is not an EngineError. */
export function engineHttpStatus(code: string): number {
  return Object.hasOwn(ENGINE_HTTP_STATUS, code) ? ENGINE_HTTP_STATUS[code as EngineErrorCode] : ENGINE_HTTP_FALLBACK;
}
