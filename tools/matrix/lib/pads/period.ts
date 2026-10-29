// hockey and icehockey: one pad shape, because the product builds both from
// one file (period-shared.ts) and the matrix generates both from one
// generator (streams/period.ts). The references into period-shared.ts:
//  - :436-437 the event names `${k}.goal` and `${k}.period.advance`;
//  - :916-928 the goal tiles `goal-${side}`, writing `{by}`;
//  - :963-981 the `advance` tile: ONE tap to whatever the engine names next
//    (detail.nextAdvance), and :976 always stamps `at` beside `to` (the
//    whistle: whistleAt, :533-547).
// W2d T18 (HK-TB-2): a HOCKEY goal tile no longer holds `{by}` — its dock is a
// CHOICE of the goal's type (`DockSpec.requires`), and nothing is queued until
// a chip answers it. So a hockey goal is the tile, then its type's chip
// (`kind:<k>`, or `ownGoal` for og), and the row is `{by, kind}`. Ice hockey's
// goal still holds `{by}`.
// Step 0 (2026-09-30, 320, fih-outdoor and iihf, rosterless team entrants)
// saw a goal tile HOLD and write `{by}` alone (equal), and each advance tap
// write `{to, at: {period, elapsed: 0}}` at once. An object is no tolerable
// id, so the advance is a fallback: one row, judged by its fallback's own
// judge (`to` to the event, `at` to the shape the tile stamps; replay.ts
// judgeFallback, since e3ebd230c).
//
// The advance tile carries no label choice, so the adapter checks that the
// label the pad is about to write is the one the event names. It keeps a
// cursor per fixture (the entrant pair, reset by core.start) over
// periodLabels and overtimeWhistles — the generator's own, one authority — and throws
// naming both labels on a mismatch. The replay turns the throw into a finding,
// never a silent wrong tap.
//
// W2e Task 20 (G2, G3) — read off the skin's SOURCE (period-shared.ts), text-
// pinned in pad-adapters.test.ts, and not yet seen by a browser (the truth run's
// W2E_SO and W2E_OT drive it):
//  - an overtime cfg lengthens the whistles' order: the first FT ends regulation
//    and opens the overtime, whose own whistles (OT2.. for fixed periods) end
//    in a SECOND FT (expectedAdvance :1061). The cursor walks the longest order,
//    the cfg's, because the adapter holds no score to know a match was decided
//    sooner; the fixture's strict fold refuses a whistle past a decision.
//  - a shoot-out (FIH) or GWS (IIHF) attempt is its side's attempt tile
//    `attempt-${side}` (attemptSheetKey :891, offered in the SHOOTOUT phase :513 with
//    the out-of-turn side disabled by the engine's shootoutNext, :935-948),
//    which opens attemptSheet (:1304): one choice step whose options are
//    `scored` / `missed`, building `{by, scored}`. The dock's taker, keeper and
//    retake chips (:1661) are band 2+ and the generator writes none.
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import { overtimeWhistles, periodLabels, type PeriodOvertime } from "../streams/period.ts";
import { judgeKeys, judgeOneRow, type Stamp } from "./judge.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** What the advance tile stamps beside `to` (period-shared.ts:976, Step 0
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

/** period-shared.ts:967 (text-pinned in pad-adapters.test.ts). */
export const PERIOD_ADVANCE_TILE = "advance";
/** period-shared.ts:919 (text-pinned). */
export const periodGoalTile = (side: "home" | "away"): string => `goal-${side}`;

/** period-shared.ts:891 attemptSheetKey (text-pinned in pad-adapters.test.ts). */
export const periodAttemptTile = (side: "home" | "away"): string => `attempt-${side}`;
/** period-shared.ts:1315-1316 attemptSheet's option ids (text-pinned). */
export const PERIOD_ATTEMPT_SCORED = "scored";
export const PERIOD_ATTEMPT_MISSED = "missed";

/** The cfg's overtime as the kernel reads it, or a throw naming what it is not. */
function overtimeOf(sport: string, overtime: unknown): PeriodOvertime | null {
  if (overtime === null || overtime === undefined) return null;
  const o = overtime as { kind?: unknown; count?: unknown };
  if (typeof overtime === "object" && (o.kind === "sudden_death" || (o.kind === "periods" && Number.isInteger(o.count) && (o.count as number) >= 1))) return overtime as PeriodOvertime;
  throw new Error(`${sport}Pad: the cfg's overtime is ${JSON.stringify(overtime)}, not null, a sudden-death period or a whole number ≥ 1 of fixed periods`);
}

/** The advances a match walks, in order: every label after the first, then FT; with overtime, the overtime's own whistles
 *  (every overtime label after the first, then FT again: a level FT opens the overtime, and its final whistle is a second FT). */
function advanceOrder(sport: string, cfg: unknown): readonly string[] {
  const c = cfg as { periods?: { count?: unknown }; overtime?: unknown } | null;
  const count = c?.periods?.count;
  if (!Number.isInteger(count) || (count as number) < 1) {
    throw new Error(`${sport}Pad: the cfg's periods.count is ${JSON.stringify(count)}, not a whole number ≥ 1`);
  }
  const regulation = [...periodLabels(count as number).slice(1), "FT"];
  const overtime = overtimeOf(sport, c?.overtime);
  return overtime === null ? regulation : [...regulation, ...overtimeWhistles(overtime)];
}

export function makePeriodPad(sport: "hockey" | "icehockey"): MatrixPadAdapter {
  const goal = `${sport}.goal`;
  const advance = `${sport}.period.advance`;
  /** fixture (entrant pair) → how many advances it has tapped since core.start. */
  const tapped = new Map<string, number>();
  const fixtureOf = (ctx: TapAdapterContext) => `${ctx.entrants.home}|${ctx.entrants.away}`;

  // W2d T18: the sport whose goal cannot be sent without its type (the engine's GOAL_KIND_REQUIRED, the skin's
  // `goalKindRequired`). Hockey alone — FIH ranks on field goals; IIHF on no goal type.
  const typed = sport === "hockey";
  function goalSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
    const p = (payload ?? {}) as Record<string, unknown>;
    const side = p.by === ctx.entrants.home ? "home" : p.by === ctx.entrants.away ? "away" : null;
    const keys = Object.keys(p).sort().join(",");
    const shapeOk = typed ? keys === "by,kind" && typeof p.kind === "string" && p.kind !== "" : keys === "by";
    if (payload === null || typeof payload !== "object" || !shapeOk || side === null) {
      throw new Error(
        `${sport}Pad: ${goal} payload ${JSON.stringify(payload)} is not {by: one of the fixture's entrants${typed ? ", kind: the goal's type" : ""}}`,
      );
    }
    if (!typed) {
      // The tile HOLDS; the replay's closing releaseHold sends it now.
      return [{ kind: "tile", tileId: periodGoalTile(side) }];
    }
    // The tile opens the type CHOICE; the chip answers it, and the answered goal HOLDS like any other tap.
    return [
      { kind: "tile", tileId: periodGoalTile(side) },
      { kind: "chip", chipId: p.kind === "og" ? "ownGoal" : `kind:${String(p.kind)}` },
    ];
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

  const attempt = `${sport}.shootout.attempt`;
  /** An attempt is the taking side's attempt tile, then the sheet's Scored / Missed. The generated attempt is `{by, scored}`:
   *  exactly what the sheet builds, so any other key (a taker `person`, a `void` retake, an `at`) is a route this sheet
   *  cannot write. */
  function attemptSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
    const p = (payload ?? {}) as Record<string, unknown>;
    const side = p.by === ctx.entrants.home ? "home" : p.by === ctx.entrants.away ? "away" : null;
    if (payload === null || typeof payload !== "object" || Object.keys(p).sort().join(",") !== "by,scored" || typeof p.scored !== "boolean" || side === null) {
      throw new Error(`${sport}Pad: ${attempt} payload ${JSON.stringify(payload)} is not the attempt sheet's {by: one of the fixture's entrants, scored: true or false}`);
    }
    return [{ kind: "tile", tileId: periodAttemptTile(side) }, { kind: "choice", optionId: p.scored ? PERIOD_ATTEMPT_SCORED : PERIOD_ATTEMPT_MISSED }];
  }

  return {
    sport,
    emits: ["core.start", goal, advance, attempt],
    fallbacks: [
      {
        eventType: advance,
        writes: [advance],
        why: "period-shared.ts:976 — the advance tile stamps `at` {period, elapsed} beside `to` (Step 0 2026-09-30: row keys [at, to]); an object is no tolerable id, so its judge holds `to` to the event and `at` to the shape the tile stamps",
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
      if (event.type === attempt) return attemptSteps(event.payload, ctx);
      throw new Error(`${sport}Pad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
    },
    // Step 0: the goal rows' keys were exactly [by] ([by, kind] for hockey since W2d T18); the advance is a fallback.
    tolerableExtraKeys: () => [],
  };
}
