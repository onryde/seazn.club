// tennis: the setScore tile authors the set summary that the matrix generator
// emits (streams/tennis.ts). The references into tennis.tsx:
//  - :702-709 offers the tile (id "setScore", not exported) while no set is
//    in progress;
//  - :857-891 is setScoreSheet: games home, games away, then two tie-break
//    steps asked only `when: tbShape` (:863-867, :878, :887), i.e. only for a
//    set that ends tiebreakAt+1 to tiebreakAt (isTbShape, :851-855);
//  - :1055 registers the sheet under "setScore".
// Step 0 (2026-09-30, 320, the builder default `tour`) saw a 6-3 set ask
// exactly two numbers, home first ("Games — Home"), and write one
// `tennis.set_summary {home, away}` row at once, with no hold and no `tb` key.
// So one event is one row. A tie-break-shaped set is refused by name: its sheet
// asks two more numbers the generated summary does not carry.
import { START_MATCH_TESTID, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** tennis.tsx:704 (text-pinned in pad-adapters.test.ts). */
export const TENNIS_SET_SCORE_TILE = "setScore";
/** tennis.tsx:106 SET_SUMMARY_TYPE, an event the engine's tennis module declares (pinned). */
export const TENNIS_SUMMARY = "tennis.set_summary";

/** The cfg's tie-break trigger, or null where the cfg has none. */
function tiebreakAt(cfg: unknown): number | null {
  const at = (cfg as { set?: { tiebreakAt?: unknown } } | null)?.set?.tiebreakAt;
  return typeof at === "number" ? at : null;
}

function summarySteps(payload: unknown, cfg: unknown): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  if (keys.length !== 2 || keys[0] !== "away" || keys[1] !== "home" || !Number.isInteger(p.home) || !Number.isInteger(p.away)) {
    throw new Error(`tennisPad: ${TENNIS_SUMMARY} payload ${JSON.stringify(payload)} is not the sheet's {home, away} of whole numbers`);
  }
  const home = p.home as number;
  const away = p.away as number;
  const at = tiebreakAt(cfg);
  if (at !== null && Math.max(home, away) === at + 1 && Math.min(home, away) === at) {
    throw new Error(`tennisPad: ${TENNIS_SUMMARY} ${home}-${away} is a tie-break set — the sheet asks tie-break points (tennis.tsx:872-889) the summary does not carry`);
  }
  return [
    { kind: "tile", tileId: TENNIS_SET_SCORE_TILE },
    { kind: "number", value: home }, { kind: "confirm" },
    { kind: "number", value: away }, { kind: "confirm" },
  ];
}

export const tennisPad: MatrixPadAdapter = {
  sport: "tennis",
  emits: ["core.start", TENNIS_SUMMARY],
  fallbacks: [],
  stepsFor(event, ctx) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === TENNIS_SUMMARY) return summarySteps(event.payload, ctx.cfg);
    throw new Error(`tennisPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0: every row's keys were exactly away and home.
  tolerableExtraKeys: () => [],
};
