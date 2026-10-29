// football: goals and period markers, which is all the matrix generator emits
// (streams/football.ts). The references into football.tsx:
//  - :761-772 the goal tiles `goal-${side}`; :770 writes `{by}` ALONE — the
//    scorer and assist are dock chips offered on the hold, never the tile's;
//  - :857-872 the `period` tile, which opens the "period" sheet;
//  - :1074-1098 periodSheet: one choice step whose option ids ARE the markers
//    (periodMarkersOf), building `{phase: <the chosen id>}`.
// Step 0 (2026-09-30, 320, the builder default `11-a-side`, rosterless team
// entrants) saw:
//  - goal-home HOLD (pad-send-now at ~150 ms; chips ownGoal, penalty) and
//    write one `football.goal {by}` row, keys [by] only. The generated goal
//    carries `minute: 10`, which no tap writes, so the goal is a fallback:
//    one row, judged by its fallback's own judge (`by` to the side credited;
//    the minute has no tap; replay.ts judgeFallback, since e3ebd230c).
//  - period → HT, then period → FT, each write one `football.period {phase}`
//    row at once; FT decided the fixture. No lineup was demanded.
// W2e Task 19 (G1, G2) — read off the skin's SOURCE, text-pinned in
// pad-adapters.test.ts, and not yet seen by a browser (the truth run's W2E_SO
// drives it): the extra-time markers ET_HT / ET_FT are the same period sheet's
// options (periodMarkersOf lists them when the cfg plays extra time); a shoot-out
// kick is its side's kick tile `kick-${side}` (kickSheetKey, :733; offered under
// the shoot-out with the out-of-turn side disabled by footballNextKicker, :800-813),
// which opens kickSheet (:1115): one choice step whose options are `scored` /
// `missed`, building `{by, scored}`.
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import { judgeKeys, judgeOneRow } from "./judge.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** The engine's football event types (football.eventSchemas; pinned). */
export const FOOTBALL_GOAL = "football.goal";
export const FOOTBALL_PERIOD = "football.period";
/** football.tsx:859 (text-pinned in pad-adapters.test.ts). */
export const FOOTBALL_PERIOD_TILE = "period";
/** football.tsx:764 (text-pinned). */
export const footballGoalTile = (side: "home" | "away"): string => `goal-${side}`;
/** W2e: the engine's shoot-out kick (football.eventSchemas; pinned). */
export const FOOTBALL_SHOOTOUT_KICK = "football.shootout.kick";
/** football.tsx:733 kickSheetKey (text-pinned). */
export const footballKickTile = (side: "home" | "away"): string => `kick-${side}`;
/** football.tsx:1115 kickSheet's option ids (text-pinned). */
export const FOOTBALL_KICK_SCORED = "scored";
export const FOOTBALL_KICK_MISSED = "missed";

/** The side whose entrant scored, or a throw naming the payload. The
 *  generated goal is `{by, minute}`; a key past those is a route this tile
 *  cannot write. */
function goalSide(payload: unknown, ctx: TapAdapterContext): "home" | "away" {
  const p = (payload ?? {}) as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => k !== "by" && k !== "minute");
  const minuteOk = !("minute" in p) || (Number.isInteger(p.minute) && (p.minute as number) >= 0);
  const side = p.by === ctx.entrants.home ? "home" : p.by === ctx.entrants.away ? "away" : null;
  if (payload === null || typeof payload !== "object" || extra.length > 0 || !minuteOk || side === null) {
    throw new Error(`footballPad: ${FOOTBALL_GOAL} payload ${JSON.stringify(payload)} is not {by: one of the fixture's entrants, minute?: a whole number}`);
  }
  return side;
}

/** A kick is the kicking side's tile, then the sheet's Scored / Missed. The generated kick is `{by, scored}`: exactly
 *  what the sheet builds, so any other key (a kicker `person`, an `at`) is a route this sheet cannot write. */
function kickSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => k !== "by" && k !== "scored");
  const side = p.by === ctx.entrants.home ? "home" : p.by === ctx.entrants.away ? "away" : null;
  if (payload === null || typeof payload !== "object" || extra.length > 0 || typeof p.scored !== "boolean" || side === null) {
    throw new Error(`footballPad: ${FOOTBALL_SHOOTOUT_KICK} payload ${JSON.stringify(payload)} is not the kick sheet's {by: one of the fixture's entrants, scored: true or false}`);
  }
  return [{ kind: "tile", tileId: footballKickTile(side) }, { kind: "choice", optionId: p.scored ? FOOTBALL_KICK_SCORED : FOOTBALL_KICK_MISSED }];
}

function periodSteps(payload: unknown): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p);
  if (payload === null || typeof payload !== "object" || keys.length !== 1 || typeof p.phase !== "string" || p.phase === "") {
    throw new Error(`footballPad: ${FOOTBALL_PERIOD} payload ${JSON.stringify(payload)} is not the sheet's {phase}`);
  }
  return [{ kind: "tile", tileId: FOOTBALL_PERIOD_TILE }, { kind: "choice", optionId: p.phase }];
}

export const footballPad: MatrixPadAdapter = {
  sport: "football",
  emits: ["core.start", FOOTBALL_GOAL, FOOTBALL_PERIOD, FOOTBALL_SHOOTOUT_KICK],
  fallbacks: [
    {
      eventType: FOOTBALL_GOAL,
      writes: [FOOTBALL_GOAL],
      why: "football.tsx:770 — the goal tile writes {by} alone; the generated minute has no tap (Step 0 2026-09-30: row keys [by]), so its judge holds `by` to the side credited and any other key the row carries to the event",
      rowsFor: () => 1,
      // Fix round 1 (I-1): the side credited is the goal. A minute the pad
      // might store later must equal the generated one; a key the goal never
      // carries is refused.
      judge: (event, rows) => judgeOneRow(rows, "the goal tile", (row) => judgeKeys(event, row, { required: ["by"] })),
    },
  ],
  stepsFor(event, ctx) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    // The tile HOLDS; the replay's closing releaseHold sends it now.
    if (event.type === FOOTBALL_GOAL) return [{ kind: "tile", tileId: footballGoalTile(goalSide(event.payload, ctx)) }];
    if (event.type === FOOTBALL_PERIOD) return periodSteps(event.payload);
    if (event.type === FOOTBALL_SHOOTOUT_KICK) return kickSteps(event.payload, ctx);
    throw new Error(`footballPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0: the marker rows' keys were exactly [phase]; the goal is a fallback. W2e: the kick sheet builds exactly
  // {by, scored}, so its row carries no key the generated kick lacks.
  tolerableExtraKeys: () => [],
};
