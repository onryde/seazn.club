// PROMPT-61 §2 — stage-scoped decider overlay, pure.
import { describe, expect, it } from "vitest";
import { stageScopedCfg } from "../stage-cfg";

describe("stageScopedCfg", () => {
  it("overlays only shootout/extraTime from the stage config", () => {
    const div = { shootout: false, points: { win: 3 }, halfMinutes: 45 };
    expect(
      stageScopedCfg(div, {
        shootout: true,
        extraTime: { enabled: true, halfMinutes: 15 },
        points: { win: 99 }, // stage points are competition.ts territory, not deciders
      }),
    ).toEqual({
      shootout: true,
      extraTime: { enabled: true, halfMinutes: 15 },
      points: { win: 3 },
      halfMinutes: 45,
    });
  });

  it("is the identity when the stage sets no decider key", () => {
    const div = { extraTime: { enabled: true, halfMinutes: 15 } };
    expect(stageScopedCfg(div, null)).toBe(div);
    expect(stageScopedCfg(div, undefined)).toBe(div);
    expect(stageScopedCfg(div, {})).toBe(div);
    expect(stageScopedCfg(div, { rngSeed: 7 })).toBe(div);
  });

  it("overlays stage.config.rules onto the division config, per key", () => {
    const division = { bestOf: 1, setTo: 21, cap: 30 };
    const out = stageScopedCfg(division, { rules: { bestOf: 3 } }) as Record<string, unknown>;
    expect(out).toEqual({ bestOf: 3, setTo: 21, cap: 30 });
  });

  it("lets a stage's own decider keys win over anything in rules", () => {
    // rules is applied FIRST, the decider loop second, so `shootout` has one
    // winner even if a future writer smuggles it into rules.
    const out = stageScopedCfg(
      { shootout: "none" },
      {
        shootout: "best_of_five",
        rules: { shootout: "sudden_death" },
      },
    ) as Record<string, unknown>;
    expect(out.shootout).toBe("best_of_five");
  });

  it("treats an explicit null in rules as no override, not as a value", () => {
    // "inherit" is key ABSENCE. Object.assign copies nulls, so a null that
    // reached the column would blank the division value.
    const out = stageScopedCfg({ bestOf: 3 }, { rules: { bestOf: null } }) as Record<
      string,
      unknown
    >;
    expect(out.bestOf).toBe(3);
  });

  it("is reference-identical when the stage carries no rules", () => {
    const division = { bestOf: 3 };
    expect(stageScopedCfg(division, { pairing: "fold" })).toBe(division);
  });
});
