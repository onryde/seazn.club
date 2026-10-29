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
// So one event is one row.
//
// W2e Task 23 (G8, CL7-3). A tie-break-ended set IS now generated (the tiebreakSet and shortSetTb deciding paths), so the
// adapter types it: the sheet's tbHome and tbAway steps (after away, each confirmed), the summary's `tb` block. Whether a score
// is tie-break-shaped is not the cfg's alone - it is `rulesFor` of the set ABOUT TO BE PLAYED, which the skin restates from the
// kernel (tennis.tsx `rulesFor`, `isTbShape`): the trigger defaults to 6 when the cfg omits `tiebreakAt`, and the deciding set
// of a cfg with `finalSet.matchTiebreakTo` is a MATCH tie-break, whose points ride in home/away and which REFUSES a `tb` block
// (so 7-6 there is a finished match tie-break to 7 by 1, and no tie-break shape). Which set is the deciding one depends on the
// sets each side has won, so - like the cricket pad - the adapter keeps one record per fixture (the entrant pair), reset by
// core.start, in a per-adapter closure (never module state: a second adapter or a second replay in a process shares nothing).
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** tennis.tsx:704 (text-pinned in pad-adapters.test.ts). */
export const TENNIS_SET_SCORE_TILE = "setScore";
/** tennis.tsx:106 SET_SUMMARY_TYPE, an event the engine's tennis module declares (pinned). */
export const TENNIS_SUMMARY = "tennis.set_summary";

/** The fields of the cfg the sheet's rules read (tennis.tsx TennisCfgShape); every one optional, as the skin reads it. */
interface CfgShape {
  bestOf?: number;
  set?: { tiebreakAt?: number | null };
  finalSet?: "same" | { matchTiebreakTo: number } | { tiebreakTo: number };
}
const cfgOf = (cfg: unknown): CfgShape => ((typeof cfg === "object" && cfg !== null ? cfg : {}));

/** What the sheet is asking at one point of a fixture: the trigger (null = no tie-break) and whether the set is a match tie-break. */
interface SetRules { tiebreakAt: number | null; mtb: boolean }

/** `rulesFor` of the skin (tennis.tsx, kernel.ts rulesFor): the rules of the set about to be played, given the sets each side has won. */
function rulesFor(won: Taken, cfg: unknown): SetRules {
  const c = cfgOf(cfg);
  const tiebreakAt = c.set?.tiebreakAt === undefined ? 6 : c.set.tiebreakAt;
  const need = Math.ceil((c.bestOf ?? 3) / 2) - 1;
  const deciding = won.home === need && won.away === need;
  const finalSet = c.finalSet ?? "same";
  const mtb = deciding && typeof finalSet === "object" && "matchTiebreakTo" in finalSet;
  return { tiebreakAt, mtb };
}

/** `isTbShape` of the skin (tennis.tsx): tiebreakAt+1 : tiebreakAt either way round - never in a match tie-break or a no-tie-break set. */
function isTbShape(home: number, away: number, rules: SetRules): boolean {
  if (rules.mtb || rules.tiebreakAt === null) return false;
  const at = rules.tiebreakAt;
  return (home === at + 1 && away === at) || (away === at + 1 && home === at);
}

/** The sets each side has won since core.start. */
interface Taken { home: number; away: number }

const fixtureOf = (ctx: TapAdapterContext) => `${ctx.entrants.home}|${ctx.entrants.away}`;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isPair = (v: unknown): v is { home: number; away: number } => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v).sort();
  const p = v as Record<string, unknown>;
  return keys.length === 2 && keys[0] === "away" && keys[1] === "home" && whole(p.home) && whole(p.away);
};

function summarySteps(payload: unknown, ctx: TapAdapterContext, taken: Map<string, Taken>): readonly TapStep[] {
  const refuse = (): never => {
    throw new Error(`tennisPad: ${TENNIS_SUMMARY} payload ${JSON.stringify(payload)} is not the sheet's {home, away} of whole numbers (plus a {home, away} tb block on a tie-break set)`);
  };
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return refuse();
  const { tb, ...games } = payload as Record<string, unknown>;
  if (!isPair(games)) return refuse();
  const hasTb = Object.hasOwn(payload, "tb");
  if (hasTb && !isPair(tb)) return refuse();
  const record = taken.get(fixtureOf(ctx));
  if (record === undefined) {
    throw new Error(`tennisPad: ${TENNIS_SUMMARY} before core.start — the pad cannot tell which set it is (a tie-break set or the deciding match tie-break) without the sets won since the start`);
  }
  const { home, away } = games;
  const rules = rulesFor(record, ctx.cfg);
  const tbShape = isTbShape(home, away, rules);
  if (tbShape && !hasTb) {
    throw new Error(`tennisPad: ${TENNIS_SUMMARY} ${home}-${away} is a tie-break set — the payload omits tb, and the sheet asks tie-break points for it (tennis.tsx tbHome/tbAway, when: tbShape)`);
  }
  if (!tbShape && hasTb) {
    throw new Error(`tennisPad: ${TENNIS_SUMMARY} ${home}-${away} carries tb on a score that is not a tie-break set${rules.mtb ? " — the deciding set is a match tie-break, whose points ride in home/away" : ""} (the sheet asks no tie-break points)`);
  }
  // The set is banked: the side with more games (or match tie-break points) took it.
  if (home > away) record.home += 1;
  else if (away > home) record.away += 1;
  return [
    { kind: "tile", tileId: TENNIS_SET_SCORE_TILE },
    { kind: "number", value: home }, { kind: "confirm" },
    { kind: "number", value: away }, { kind: "confirm" },
    ...(hasTb
      ? [{ kind: "number", value: (tb as { home: number }).home } as TapStep, { kind: "confirm" } as TapStep, { kind: "number", value: (tb as { away: number }).away } as TapStep, { kind: "confirm" } as TapStep]
      : []),
  ];
}

/** One adapter, with its own record of the sets each fixture has banked since core.start. */
export function makeTennisPad(): MatrixPadAdapter {
  const taken = new Map<string, Taken>();
  return {
    sport: "tennis",
    emits: ["core.start", TENNIS_SUMMARY],
    fallbacks: [],
    stepsFor(event, ctx) {
      if (event.type === "core.start") {
        taken.set(fixtureOf(ctx), { home: 0, away: 0 });
        return [{ kind: "testid", testid: START_MATCH_TESTID }];
      }
      if (event.type === TENNIS_SUMMARY) return summarySteps(event.payload, ctx, taken);
      throw new Error(`tennisPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
    },
    // Step 0: every row's keys were exactly away and home (a tie-break set's also carry tb, generated and equal).
    tolerableExtraKeys: () => [],
  };
}

export const tennisPad: MatrixPadAdapter = makeTennisPad();
