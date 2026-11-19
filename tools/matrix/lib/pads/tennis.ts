// tennis: the setScore tile authors the set summary that the matrix generator
// emits (streams/tennis.ts). The references into tennis.tsx, by symbol (line
// numbers go stale on every skin edit):
//  - `buildTiles` offers the tile (id "setScore", not exported) while no set
//    is in progress;
//  - `setScoreSheet` is its sheet: games home, games away, then two tie-break
//    steps asked only `when: tbShape` (the engine's
//    `tennisPadRules.setScoreTakesTiebreak`), i.e. only for a set that ends
//    tiebreakAt+1 to tiebreakAt;
//  - `buildSheets` registers the sheet under "setScore".
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
import { JUDGED_OK, asRecord, show } from "./judge.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** tennis.tsx `buildTiles`' setScore tile id (text-pinned in pad-adapters.test.ts). */
export const TENNIS_SET_SCORE_TILE = "setScore";
/** tennis.tsx SET_SUMMARY_TYPE, an event the engine's tennis module declares (pinned). */
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

/** tennis.toss, the event the Start's "Who serves first?" answer writes before core.start (skins/tennis.tsx TOSS_TYPE). */
export const TENNIS_TOSS = "tennis.toss";
/** The dock chip the adapter answers the toss with: the home chip (`startTossQuestion`, tennis.tsx:1228, ids "home" and "away"),
 *  the serve order every tennis spec was written against (apps/web/e2e/helpers/start-toss.ts `answerStartToss` default). */
export const TENNIS_TOSS_CHIP = "home";

/** One adapter, with its own record of the sets each fixture has banked since core.start. */
export function makeTennisPad(): MatrixPadAdapter {
  const taken = new Map<string, Taken>();
  // The home entrant of each fixture this adapter has started, KEYED BY FIXTURE (the entrant pair): what that fixture's toss row's
  // `serving` must name. The replay hands the judge the fixture's ctx, so a toss naming ANOTHER fixture's home entrant (a set
  // shared across fixtures would accept it) or a fixture this adapter never started is refused.
  const homes = new Map<string, string>();
  return {
    sport: "tennis",
    emits: ["core.start", TENNIS_SUMMARY],
    // TN-TS-1 (S2-7): a tennis Start asks "Who serves first?" and its answer posts tennis.toss and then core.start at
    // consecutive seqs (start-match-control.tsx -> lib/start-with-toss.ts runTossThenStart), so core.start is TWO rows, and the
    // toss is the pad's own choice (`serving` is the entrant behind the chip), never a generated key.
    fallbacks: [
      {
        eventType: "core.start",
        writes: [TENNIS_TOSS, "core.start"],
        why: "start-match-control.tsx:93 - a tennis Start asks \"Who serves first?\" (startTossQuestion, tennis.tsx:1228) and its answer posts the toss and then core.start (runTossThenStart, lib/start-with-toss.ts:15): a tennis.toss row {serving: the chosen entrant} and an empty core.start row",
        rowsFor: () => 2,
        judge(_event, stored, ctx) {
          const [toss, start] = stored;
          if (stored.length !== 2 || toss === undefined || start === undefined) return { ok: false, note: `${stored.length} rows, where a tennis Start writes the toss and core.start` };
          if (toss.type !== TENNIS_TOSS) return { ok: false, note: `the first row is ${toss.type}, not ${TENNIS_TOSS} (the toss is written before the Start)` };
          if (start.type !== "core.start") return { ok: false, note: `the second row is ${start.type}, not core.start` };
          const tossKeys = Object.keys(asRecord(toss.payload));
          const serving = asRecord(toss.payload).serving;
          const home = ctx === undefined ? undefined : homes.get(fixtureOf(ctx));
          if (tossKeys.length !== 1 || typeof serving !== "string" || home === undefined || serving !== home) {
            return { ok: false, note: `${TENNIS_TOSS} ${show(toss.payload)}: the pad answers the home chip, so the payload is {serving: <the home entrant>} alone` };
          }
          if (Object.keys(asRecord(start.payload)).length !== 0) return { ok: false, note: `core.start carries ${show(start.payload)}, not an empty payload` };
          return JUDGED_OK;
        },
      },
    ],
    stepsFor(event, ctx) {
      if (event.type === "core.start") {
        taken.set(fixtureOf(ctx), { home: 0, away: 0 });
        homes.set(fixtureOf(ctx), ctx.entrants.home);
        return [{ kind: "testid", testid: START_MATCH_TESTID }, { kind: "chip", chipId: TENNIS_TOSS_CHIP }];
      }
      if (event.type === TENNIS_SUMMARY) return summarySteps(event.payload, ctx, taken);
      throw new Error(`tennisPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
    },
    // Step 0: every row's keys were exactly away and home (a tie-break set's also carry tb, generated and equal).
    tolerableExtraKeys: () => [],
  };
}

export const tennisPad: MatrixPadAdapter = makeTennisPad();
