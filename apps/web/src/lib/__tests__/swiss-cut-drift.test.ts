import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { swissCutDrift, swissCutDriftOf, swissCutDriftStageIds, type SwissCutDrift } from "@/lib/swiss-cut-drift";

// W3 Task 17 (RB3-19, X-SW-25) — the pure judgement behind the desk warning: who the cut moved. The server reads the
// three inputs (`getSwissCutDrift`, proven on Postgres in swiss-signed-rules-pin.test.ts); this proves what is done with
// them, EMPTY CASE FIRST.

describe("swissCutDrift", () => {
  it("an empty frozen cut has nothing to drift from — null, even when the knockout began and today's top q is not empty", () => {
    expect(swissCutDrift([], [], true)).toBeNull();
    expect(swissCutDrift([], ["a", "b"], true)).toBeNull();
    expect(swissCutDrift([], ["a"], false)).toBeNull();
  });

  it("before the knockout began there is no warning, however far the table moved", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b", "d"], false)).toBeNull();
  });

  it("the same people is no drift — in any order (a re-order inside the cut moves no one across the line)", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b", "c"], true)).toBeNull();
    expect(swissCutDrift(["a", "b", "c"], ["c", "a", "b"], true)).toBeNull();
  });

  it("names who is out and who is in", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b", "d"], true)).toEqual({ out: ["c"], in: ["d"] });
  });

  it("several moving at once: both lists, each in the order handed in", () => {
    expect(swissCutDrift(["a", "b", "c", "d"], ["a", "f", "e", "d"], true)).toEqual({ out: ["b", "c"], in: ["f", "e"] });
  });

  it("nobody coming in is no drift: a table shorter than the cut has no one to name as taking the place", () => {
    expect(swissCutDrift(["a", "b", "c"], ["a", "b"], true)).toBeNull();
    expect(swissCutDrift(["a", "b"], [], true)).toBeNull();
  });

  it("a repeated id is one person", () => {
    expect(swissCutDrift(["a", "a", "b"], ["a", "c", "c"], true)).toEqual({ out: ["b"], in: ["c"] });
  });
});

// Match Day PB1 x W3 T17 — the ONE predicate for "this card carries the cut-drift warning". The card draws the notice from
// `swissCutDriftOf`; the division page lists `swissCutDriftStageIds` as the stages needing attention, so PB1's fold opens
// exactly those cards. EMPTY CASE FIRST: nothing supplied is no warning and no attention.
describe("swissCutDriftOf / swissCutDriftStageIds — one predicate for the warning and for the attention list", () => {
  const drift: SwissCutDrift = { out: ["c"], in: ["d"] };
  const other: SwissCutDrift = { out: ["a"], in: ["z"] };
  const swiss = (id: string) => ({ id, kind: "swiss" });

  it("the empty cases first: no map, an empty map, no stages — nothing is warned, nothing needs attention", () => {
    expect(swissCutDriftOf(swiss("s1"), true, undefined), "no map").toBeNull();
    expect(swissCutDriftOf(swiss("s1"), true, {}), "empty map").toBeNull();
    expect(swissCutDriftStageIds([swiss("s1")], true, undefined), "no map").toEqual([]);
    expect(swissCutDriftStageIds([swiss("s1")], true, {}), "empty map").toEqual([]);
    expect(swissCutDriftStageIds([], true, { s1: drift }), "no stages, even with a drift on offer").toEqual([]);
  });

  it("an organiser's Swiss with a drift carries the warning — the very object handed in — and is listed", () => {
    expect(swissCutDriftOf(swiss("s1"), true, { s1: drift })).toBe(drift);
    expect(swissCutDriftStageIds([swiss("s1")], true, { s1: drift })).toEqual(["s1"]);
  });

  it("a viewer has no warning and no attention, with the same map the organiser's card draws from (positive pair above)", () => {
    expect(swissCutDriftOf(swiss("s1"), false, { s1: drift })).toBeNull();
    expect(swissCutDriftStageIds([swiss("s1")], false, { s1: drift })).toEqual([]);
  });

  it("sweep every other stage kind: a drift keyed to a stage that is not a Swiss never lands (count reported)", () => {
    let checked = 0;
    for (const kind of StageKind.options.filter((k) => k !== "swiss")) {
      expect(swissCutDriftOf({ id: "s1", kind }, true, { s1: drift }), kind).toBeNull();
      expect(swissCutDriftStageIds([{ id: "s1", kind }], true, { s1: drift }), kind).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: the engine declares other kinds").toBeGreaterThan(0);
    expect(checked, "every non-Swiss kind swept").toBe(StageKind.options.length - 1);
    expect(StageKind.options, "premise: swiss is a declared kind").toContain("swiss");
  });

  it("several stages: only the Swiss cards with a drift are listed, in the order the stages come; a drift for a stage not on the page is ignored", () => {
    const stages = [swiss("s1"), { id: "s2", kind: "knockout" }, swiss("s3"), swiss("s4")];
    const drifts = { s1: drift, s2: other, s4: other, gone: other };
    expect(swissCutDriftStageIds(stages, true, drifts)).toEqual(["s1", "s4"]);
    expect(swissCutDriftOf(swiss("s3"), true, drifts), "a Swiss with no drift of its own").toBeNull();
  });
});
