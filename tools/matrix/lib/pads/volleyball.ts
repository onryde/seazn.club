// volleyball: the setScore tile authors the coarse set summary that the matrix
// generator emits (streams/setbased.ts). The references into volleyball.tsx:
//  - :921 is SET_SCORE_TILE_ID;
//  - :1388 registers its sheet, setScoreSheet: two number steps, home then
//    away.
// Step 0 (2026-09-30, 320, the builder default `beach`) saw the tile's first
// tap open the home number step directly (no set-opener sheet came first),
// on a rosterless beach fixture. Each tap route wrote one
// `volleyball.set.summary {home, away}` row at once, with no hold and no extra
// key. So one event is one row, and beach needs no roster.
import { START_MATCH_TESTID, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** volleyball.tsx:921 (text-pinned in pad-adapters.test.ts). */
export const VOLLEYBALL_SET_SCORE_TILE = "setScore";
/** `volleyball.${coarseEventType}`: volleyball.tsx:249, the engine's setbased/volleyball.ts:99 (pinned). */
export const VOLLEYBALL_SUMMARY = "volleyball.set.summary";

function summarySteps(payload: unknown): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  if (keys.length !== 2 || keys[0] !== "away" || keys[1] !== "home" || !Number.isInteger(p.home) || !Number.isInteger(p.away)) {
    throw new Error(`volleyballPad: ${VOLLEYBALL_SUMMARY} payload ${JSON.stringify(payload)} is not the sheet's {home, away} of whole numbers`);
  }
  return [
    { kind: "tile", tileId: VOLLEYBALL_SET_SCORE_TILE },
    { kind: "number", value: p.home as number }, { kind: "confirm" },
    { kind: "number", value: p.away as number }, { kind: "confirm" },
  ];
}

export const volleyballPad: MatrixPadAdapter = {
  sport: "volleyball",
  emits: ["core.start", VOLLEYBALL_SUMMARY],
  fallbacks: [],
  stepsFor(event) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === VOLLEYBALL_SUMMARY) return summarySteps(event.payload);
    throw new Error(`volleyballPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0: every row's keys were exactly away and home.
  tolerableExtraKeys: () => [],
};
