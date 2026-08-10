// `restFloor` resolves four separate controls into one number and names the one
// that won. Two things are worth proving and neither is obvious:
//
//   1. The SOURCE. Nothing before this returned it, so nothing before this
//      could tell an organiser why lowering the field in front of them changed
//      nothing. Every assertion on `source` below fails without `rest-floor.ts`.
//   2. That splitting the arithmetic out did not change the NUMBER.
//      `effectiveRestMinutes` is what the placer, the verifier, `build-encode.ts`
//      and `repair.ts` ask. Both it and `restFloor` are enumerated over the whole
//      input space against an independent oracle below — not against each other,
//      which is a tautology today and would stay green through any mutation.
//      Drift here is the recurring defect in this subsystem, so it is checked
//      exhaustively rather than sampled.
import { describe, expect, it } from "vitest";
import { effectiveRestMinutes } from "./calendar.ts";
import { restFloor, type RestFloorInputs } from "./rest-floor.ts";

const base: RestFloorInputs = { perEntrantMinRest: 0, gapMinutes: 5, matchMinutes: 30 };

describe("restFloor — which control set the floor", () => {
  it("credits perEntrantMinRest when nothing else is configured", () => {
    expect(restFloor({ ...base, perEntrantMinRest: 20 })).toEqual({
      minutes: 20,
      source: "perEntrantMinRest",
    });
  });

  it("credits perEntrantMinRest at a floor of zero rather than inventing a source", () => {
    expect(restFloor(base)).toEqual({ minutes: 0, source: "perEntrantMinRest" });
  });

  it("credits restMin when the Constraints tab is the stricter of the two", () => {
    const r = restFloor({ ...base, perEntrantMinRest: 10, constraints: { restMin: 30 } });
    expect(r).toEqual({ minutes: 30, source: "restMin" });
  });

  it("keeps the Settings value, and the credit, when it is the stricter", () => {
    const r = restFloor({ ...base, perEntrantMinRest: 30, constraints: { restMin: 10 } });
    expect(r).toEqual({ minutes: 30, source: "perEntrantMinRest" });
  });

  // The tie rule has to be pinned or the panel's copy flickers between two
  // truthful answers as an organiser edits an unrelated field.
  it("gives a tie to the earlier source, not the later one", () => {
    const r = restFloor({ ...base, perEntrantMinRest: 30, constraints: { restMin: 30 } });
    expect(r.minutes).toBe(30);
    expect(r.source).toBe("perEntrantMinRest");
  });

  // This is the interaction the UI exists to expose: a checkbox two rows below
  // the number silently outranks it. 30 + 5 = 35 > 30.
  it("credits noBackToBack when one whole fixture is longer than every explicit rest", () => {
    const r = restFloor({
      ...base,
      perEntrantMinRest: 20,
      constraints: { restMin: 30, noBackToBack: true },
    });
    expect(r).toEqual({ minutes: 35, source: "noBackToBack" });
  });

  it("skips noBackToBack entirely when the caller carries no match length", () => {
    const { matchMinutes: _omitted, ...noLength } = base;
    const r = restFloor({ ...noLength, perEntrantMinRest: 20, constraints: { noBackToBack: true } });
    expect(r).toEqual({ minutes: 20, source: "perEntrantMinRest" });
  });

  it("credits restByGroup and names the key that won", () => {
    const r = restFloor(
      { ...base, perEntrantMinRest: 10, constraints: { restByGroup: { "pool-a": 45 } } },
      { poolId: "pool-a", divisionId: "div-1" },
    );
    expect(r).toEqual({ minutes: 45, source: "restByGroup", groupId: "pool-a" });
  });

  it("takes the strictest of a pool and a division entry, not the most specific", () => {
    const r = restFloor(
      { ...base, constraints: { restByGroup: { "pool-a": 10, "div-1": 45 } } },
      { poolId: "pool-a", divisionId: "div-1" },
    );
    expect(r).toEqual({ minutes: 45, source: "restByGroup", groupId: "div-1" });
  });

  // Order between the two group keys is invisible while their values differ —
  // MAX does not care. It decides who gets the CREDIT on a tie, which is what
  // the panel prints, so it is pinned here: pool is consulted first.
  it("credits the pool, not the division, when both demand the same rest", () => {
    const r = restFloor(
      { ...base, constraints: { restByGroup: { "pool-a": 45, "div-1": 45 } } },
      { poolId: "pool-a", divisionId: "div-1" },
    );
    expect(r).toEqual({ minutes: 45, source: "restByGroup", groupId: "pool-a" });
  });

  // #459 in its original form: `??` made an explicit pool zero ERASE the
  // division rule, because `0 ?? x` is `0`.
  it("does not let a pool entry of zero erase a division rule", () => {
    const r = restFloor(
      { ...base, constraints: { restByGroup: { "pool-a": 0, "div-1": 45 } } },
      { poolId: "pool-a", divisionId: "div-1" },
    );
    expect(r.minutes).toBe(45);
  });

  it("leaves groupId absent when a later, non-group source overtakes one", () => {
    const r = restFloor(
      {
        ...base,
        constraints: { restByGroup: { "pool-a": 10 }, noBackToBack: true },
      },
      { poolId: "pool-a" },
    );
    expect(r).toEqual({ minutes: 35, source: "noBackToBack" });
    expect("groupId" in r).toBe(false);
  });
});

/** An INDEPENDENT reading of the same rule, written deliberately unlike the
 *  implementation — every candidate collected first, one `Math.max` at the end,
 *  no running accumulator and no notion of a winning source.
 *
 *  It exists because `effectiveRestMinutes` now returns `restFloor(…).minutes`
 *  verbatim, so asserting the two agree is a tautology that cannot fail and
 *  would prove nothing about either. Both are checked against THIS instead. */
const oracle = (
  config: RestFloorInputs,
  group?: { poolId?: string; divisionId?: string },
): number => {
  const c = config.constraints;
  const candidates = [config.perEntrantMinRest];
  if (c?.restMin !== undefined) candidates.push(c.restMin);
  for (const key of [group?.poolId, group?.divisionId]) {
    if (key === undefined) continue;
    const v = c?.restByGroup?.[key];
    if (v !== undefined) candidates.push(v);
  }
  if (c?.noBackToBack === true && config.matchMinutes !== undefined) {
    candidates.push(config.matchMinutes + config.gapMinutes);
  }
  return Math.max(...candidates);
};

describe("restFloor / effectiveRestMinutes against an independent oracle", () => {
  // Exhaustive rather than sampled: this is the seam a fork would open at.
  const rests = [0, 10, 30];
  const restMins = [undefined, 0, 10, 45];
  const matchLens = [undefined, 30];
  const backToBacks = [undefined, false, true];
  const groups = [
    undefined,
    { poolId: "pool-a" },
    { divisionId: "div-1" },
    { poolId: "pool-a", divisionId: "div-1" },
  ];
  const byGroups = [undefined, { "pool-a": 0 }, { "pool-a": 60 }, { "div-1": 25 }];

  it("both match the oracle for every combination of the four sources", () => {
    let checked = 0;
    for (const perEntrantMinRest of rests) {
      for (const restMin of restMins) {
        for (const matchMinutes of matchLens) {
          for (const noBackToBack of backToBacks) {
            for (const restByGroup of byGroups) {
              for (const group of groups) {
                const config = {
                  perEntrantMinRest,
                  gapMinutes: 5,
                  ...(matchMinutes !== undefined ? { matchMinutes } : {}),
                  constraints: {
                    ...(restMin !== undefined ? { restMin } : {}),
                    ...(restByGroup !== undefined ? { restByGroup } : {}),
                    noBackToBack: noBackToBack === true,
                    // The rest of SchedulingConstraints is irrelevant here and
                    // is left off: `restFloor` takes a structural type, so the
                    // parity check does not need a full parsed object.
                  },
                } as Parameters<typeof effectiveRestMinutes>[0];
                const want = oracle(config, group);
                const where = `at ${JSON.stringify({ config, group })}`;
                expect(restFloor(config, group).minutes, `restFloor ${where}`).toBe(want);
                expect(effectiveRestMinutes(config, group), `effectiveRestMinutes ${where}`).toBe(
                  want,
                );
                checked += 1;
              }
            }
          }
        }
      }
    }
    // Guards the loops themselves: a mistyped array collapses the space to a
    // handful of cases and the assertion above still passes.
    expect(checked).toBe(
      rests.length *
        restMins.length *
        matchLens.length *
        backToBacks.length *
        byGroups.length *
        groups.length,
    );
    expect(checked).toBeGreaterThan(1000);
  });

  it("covers cases where the sources actually disagree", () => {
    // Without this the parity loop could be vacuous — every combination
    // returning the same trivial 0 would also "agree".
    const distinct = new Set<string>();
    for (const perEntrantMinRest of rests) {
      for (const restMin of restMins) {
        for (const noBackToBack of backToBacks) {
          const r = restFloor({
            ...base,
            perEntrantMinRest,
            constraints: {
              ...(restMin !== undefined ? { restMin } : {}),
              noBackToBack: noBackToBack === true,
            },
          });
          distinct.add(r.source);
        }
      }
    }
    expect([...distinct].sort()).toEqual(["noBackToBack", "perEntrantMinRest", "restMin"]);
  });
});
