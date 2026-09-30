// hockey and icehockey: one pad shape, because the product builds both from
// one file (period-shared.ts) and the matrix generates both from one
// generator (streams/period.ts). The references into period-shared.ts:
//  - :421-422 the event names `${k}.goal` and `${k}.period.advance`;
//  - :901-913 the goal tiles `goal-${side}`, writing `{by}`;
//  - :948-966 the `advance` tile: ONE tap to whatever the engine names next
//    (detail.nextAdvance), and :961 always stamps `at` beside `to` (the
//    whistle: whistleAt, :518-532).
// Step 0 (2026-09-30, 320, fih-outdoor and iihf, rosterless team entrants)
// saw a goal tile HOLD and write `{by}` alone (equal), and each advance tap
// write `{to, at: {period, elapsed: 0}}` at once. An object is no tolerable
// id, so the advance is a fallback: one row, judged by fold.
//
// The advance tile carries no label choice, so the adapter checks that the
// label the pad is about to write is the one the event names. It keeps a
// cursor per fixture (the entrant pair, reset by core.start) over
// periodLabels — the generator's own, one authority — and throws naming both
// labels on a mismatch. The replay turns the throw into a finding, never a
// silent wrong tap.
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import { periodLabels } from "../streams/period.ts";
import { judgeKeys, judgeOneRow, type Stamp } from "./judge.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** What the advance tile stamps beside `to` (period-shared.ts:961, Step 0
 *  2026-09-30: `{period: "Q1", elapsed: 0}`): the phase it leaves and the
 *  seconds into it, nothing else. */
const AT_STAMP: Stamp = {
  shape: "{period: a label, elapsed: a whole number ≥ 0}",
  is: (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const a = v as Record<string, unknown>;
    return Object.keys(a).sort().join(",") === "elapsed,period"
      && typeof a.period === "string" && a.period !== ""
      && Number.isInteger(a.elapsed) && (a.elapsed as number) >= 0;
  },
};

/** period-shared.ts:952 (text-pinned in pad-adapters.test.ts). */
export const PERIOD_ADVANCE_TILE = "advance";
/** period-shared.ts:904 (text-pinned). */
export const periodGoalTile = (side: "home" | "away"): string => `goal-${side}`;

/** The advances a match walks, in order: every label after the first, then FT. */
function advanceOrder(sport: string, cfg: unknown): readonly string[] {
  const count = (cfg as { periods?: { count?: unknown } } | null)?.periods?.count;
  if (!Number.isInteger(count) || (count as number) < 1) {
    throw new Error(`${sport}Pad: the cfg's periods.count is ${JSON.stringify(count)}, not a whole number ≥ 1`);
  }
  return [...periodLabels(count as number).slice(1), "FT"];
}

export function makePeriodPad(sport: "hockey" | "icehockey"): MatrixPadAdapter {
  const goal = `${sport}.goal`;
  const advance = `${sport}.period.advance`;
  /** fixture (entrant pair) → how many advances it has tapped since core.start. */
  const tapped = new Map<string, number>();
  const fixtureOf = (ctx: TapAdapterContext) => `${ctx.entrants.home}|${ctx.entrants.away}`;

  function goalSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
    const p = (payload ?? {}) as Record<string, unknown>;
    const side = p.by === ctx.entrants.home ? "home" : p.by === ctx.entrants.away ? "away" : null;
    if (payload === null || typeof payload !== "object" || Object.keys(p).length !== 1 || side === null) {
      throw new Error(`${sport}Pad: ${goal} payload ${JSON.stringify(payload)} is not {by: one of the fixture's entrants}`);
    }
    // The tile HOLDS; the replay's closing releaseHold sends it now.
    return [{ kind: "tile", tileId: periodGoalTile(side) }];
  }

  function advanceSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (payload === null || typeof payload !== "object" || Object.keys(p).length !== 1 || typeof p.to !== "string" || p.to === "") {
      throw new Error(`${sport}Pad: ${advance} payload ${JSON.stringify(payload)} is not {to}`);
    }
    const key = fixtureOf(ctx);
    const n = tapped.get(key);
    if (n === undefined) throw new Error(`${sport}Pad: advance to ${p.to} before core.start on this fixture — the pad's next label is unknown`);
    const order = advanceOrder(sport, ctx.cfg);
    if (n >= order.length) throw new Error(`advance would write nothing (FT is behind it), event names ${p.to}`);
    if (order[n] !== p.to) throw new Error(`advance would write ${order[n]}, event names ${p.to}`);
    tapped.set(key, n + 1);
    return [{ kind: "tile", tileId: PERIOD_ADVANCE_TILE }];
  }

  return {
    sport,
    emits: ["core.start", goal, advance],
    fallbacks: [
      {
        eventType: advance,
        writes: [advance],
        why: "period-shared.ts:961 — the advance tile stamps `at` {period, elapsed} beside `to` (Step 0 2026-09-30: row keys [at, to]); an object is no tolerable id, so its judge holds `to` to the event and `at` to the shape the tile stamps",
        rowsFor: () => 1,
        // Fix round 1 (I-1): the label the pad wrote is the one the event names.
        judge: (event, rows) => judgeOneRow(rows, "the advance tile", (row) => judgeKeys(event, row, { required: ["to"], stamped: { at: AT_STAMP } })),
      },
    ],
    stepsFor(event, ctx) {
      if (event.type === "core.start") {
        tapped.set(fixtureOf(ctx), 0);
        return [{ kind: "testid", testid: START_MATCH_TESTID }];
      }
      if (event.type === goal) return goalSteps(event.payload, ctx);
      if (event.type === advance) return advanceSteps(event.payload, ctx);
      throw new Error(`${sport}Pad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
    },
    // Step 0: the goal rows' keys were exactly [by]; the advance is a fallback.
    tolerableExtraKeys: () => [],
  };
}
