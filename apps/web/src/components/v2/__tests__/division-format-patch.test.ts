// W2c Task 17, fix round 1 (review I-2): the division Settings door's PATCH body, driven through its real inputs.
//
// The control "Use the default order" blanks a chess division's tie-break list. The door builds its PATCH on
// `{...division.config}` and OMITS a blank field, so with ["rapid"] stored the old list rode along and the reset did
// nothing. No test covered it (the existing sequence-field tests only prove a stored list SURVIVES a save). These do:
// the saved config goes in, the form's raw values go in, and the body that would be PATCHed comes out.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { declaredCfgs } from "@seazn/engine/testkit";
import { SPORT_RULES, hydrateRuleValues } from "@/lib/match-rules";
import { divisionFormatPatch, type DivisionFormatPatchInput } from "../division-format-patch";

const CHESS = "boardgame";
const chessConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  variant: "classical",
  clock: { base: 5400 },
  ...over,
});
const TIEBREAK = SPORT_RULES[CHESS]!.find((f) => f.kind === "sequence")!;

/** The door's inputs for a sport whose form was just opened on `config`: hydrated, untouched. */
function opened(sportKey: string, config: Record<string, unknown>, over: Partial<DivisionFormatPatchInput> = {}): DivisionFormatPatchInput {
  return {
    sportKey,
    divisionConfig: config,
    savedVariantKey: "classical",
    variantKey: "classical",
    ruleValues: hydrateRuleValues(sportKey, config),
    pointsFieldKeys: [],
    pointsValues: {},
    savedPoints: undefined,
    advanced: null,
    ...over,
  };
}
/** What the PATCH carries on the wire: JSON drops an undefined, exactly as the request does. */
const wire = (patch: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;

describe("the division door's reset of the tie-break list (I-2)", () => {
  it("stored [rapid] -> 'Use the default order' -> the PATCH no longer carries the list (and keeps what else is stored)", () => {
    const config = chessConfig({ tiebreakRungs: ["rapid"] });
    const input = opened(CHESS, config);
    expect(input.ruleValues.tiebreakRungs, "premise: the form opened on the stored list").toBe("rapid");
    const reset = { ...input, ruleValues: { ...input.ruleValues, tiebreakRungs: "" } };
    const patch = divisionFormatPatch(reset);
    expect(Object.hasOwn(patch, "tiebreakRungs"), "the key is gone from the body").toBe(false);
    expect(Object.hasOwn(wire(patch), "tiebreakRungs"), "and from the wire").toBe(false);
    expect(wire(patch)).toEqual({ variant: "classical", clock: { base: 5400 } });
  });

  it("the positive pair: untouched keeps the list, the EMPTY list is kept as the empty list, a new order is sent as typed", () => {
    for (const list of [["rapid"], [], ["blitz", "rapid"], [...TIEBREAK_RUNGS]] as string[][]) {
      const config = chessConfig({ tiebreakRungs: list });
      expect(wire(divisionFormatPatch(opened(CHESS, config))), JSON.stringify(list)).toEqual(config);
    }
    const input = opened(CHESS, chessConfig({ tiebreakRungs: ["rapid"] }));
    const reordered = { ...input, ruleValues: { ...input.ruleValues, tiebreakRungs: "blitz,armageddon" } };
    expect(wire(divisionFormatPatch(reordered)).tiebreakRungs).toEqual(["blitz", "armageddon"]);
    const emptied = { ...input, ruleValues: { ...input.ruleValues, tiebreakRungs: TIEBREAK.emptyValue! } };
    expect(wire(divisionFormatPatch(emptied)).tiebreakRungs, "'no tie-break games' is a list of its own, not a reset").toEqual([]);
  });

  it("a division that never had a list is not given one by a reset", () => {
    const config = chessConfig();
    const patch = divisionFormatPatch({ ...opened(CHESS, config), ruleValues: { tiebreakRungs: "" } });
    expect(wire(patch)).toEqual(config);
  });

  it("only an ordered list is cleared by a blank: a blank NUMBER field still keeps what is saved", () => {
    const config = chessConfig({ tiebreakRungs: ["rapid"] });
    const input = opened(CHESS, config);
    const blankClock = { ...input, ruleValues: { ...input.ruleValues, clockBaseMinutes: "" } };
    expect(wire(divisionFormatPatch(blankClock)), "premise: the clock field exists and was hydrated").toEqual(config);
    expect(Object.keys(input.ruleValues)).toContain("clockBaseMinutes");
  });
});

describe("the moved save builder keeps its behaviour (pins for the code that moved out of applyFormat)", () => {
  it("an untouched form loses no saved key, for every declared config of every sport (counted)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      for (const { cfg } of declaredCfgs(m)) {
        const config = cfg as Record<string, unknown>;
        const patch = wire(divisionFormatPatch(opened(m.key, config)));
        for (const key of Object.keys(config)) {
          expect(Object.hasOwn(patch, key), `${m.key}: ${key} survives an untouched save`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked, "declared configs walked").toBeGreaterThan(0);
  });

  it("a variant change drops the identity keys so the new preset wins them; the same variant keeps them", () => {
    // `abandonPolicy` is a key generic still declares that no variant preset carries (W2e D6 deleted `progressScore`, the
    // key this case used to ride on): like it, it lives only in the division's own config, so a variant change must keep it.
    const config = { resultMode: "score", allowDraws: true, abandonPolicy: "share", points: { win: 3, draw: 1, loss: 0 } };
    const same = divisionFormatPatch(opened("generic", config, { ruleValues: {} }));
    expect(same.resultMode).toBe("score");
    expect(same.allowDraws).toBe(true);
    const changed = divisionFormatPatch(opened("generic", config, { ruleValues: {}, variantKey: "win_loss" }));
    expect(Object.hasOwn(changed, "resultMode")).toBe(false);
    expect(Object.hasOwn(changed, "allowDraws")).toBe(false);
    expect(changed.abandonPolicy, "the division's own keys stay").toBe("share");
  });

  it("football: a saved soBonus rides through an untouched save and a rule-field save — no field owns it (W2d PS-1)", () => {
    const config = { points: { win: 3, draw: 1, loss: 0, soBonus: 1 } };
    const input = opened("football", config);
    expect(divisionFormatPatch(input).points, "untouched keeps it").toEqual(config.points);
    const subs = divisionFormatPatch({ ...input, ruleValues: { ...input.ruleValues, maxSubs: "3" } });
    expect(subs.points, "a rule field's save leaves points as saved").toEqual(config.points);
    expect(subs.maxSubs).toBe(3);
  });

  it("the standings-points boxes write the keys the sport declares, a blank box falls back to the saved value, and the advanced JSON is laid on last", () => {
    const config = { resultMode: "score", allowDraws: true, abandonPolicy: "replay", points: { win: 3, draw: 1, loss: 0 } };
    const patch = divisionFormatPatch(
      opened("generic", config, {
        ruleValues: {},
        pointsFieldKeys: ["win", "draw", "loss"],
        pointsValues: { win: "4", draw: "", loss: "0" },
        savedPoints: { win: 3, draw: 1, loss: 0 },
        advanced: { abandonPolicy: "share" },
      }),
    );
    expect(patch.points).toEqual({ win: 4, draw: 1, loss: 0 });
    expect(patch.abandonPolicy, "advanced wins over the saved config").toBe("share");
  });
});
