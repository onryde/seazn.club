// W2a fix round 1 (review M-1): `LEVEL_RESULT_IN_BRACKET` has two emitters in `server/engine-db/append-event.ts`, and
// they ask for different things — a GENERIC draw asks the scorer to enter the winner; a FINALIZE of a fixture that
// still needs a decision asks the organiser to settle it (or record its decider). Each carries its reason as
// `EngineError.data.reason`; `server/api-v1/http.ts` forwards it on the wire, and the copy branches on it
// (`lib/scoring-vocab.ts` `engineErrorLabel`). No `server-only`: the pad and the console read it too.
export const LEVEL_RESULT_REASON = {
  /** core.finalize while settleApplies holds (ruling P2-7). */
  finalizeUnsettled: "finalize_unsettled",
  /** A generic draw in a bracket (GN-KO-1): generic has no decider. */
  genericDraw: "generic_draw",
} as const;
export type LevelResultReason = (typeof LEVEL_RESULT_REASON)[keyof typeof LEVEL_RESULT_REASON];
const REASONS: ReadonlySet<string> = new Set(Object.values(LEVEL_RESULT_REASON));
export const isLevelResultReason = (x: unknown): x is LevelResultReason => typeof x === "string" && REASONS.has(x);
