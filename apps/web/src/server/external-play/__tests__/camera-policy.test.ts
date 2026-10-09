// T6 — the camera-policy ladder, pure half. Three levels (design §5.1: "set
// per division/stage, defaulting from the competition"; controller ruling Q1=D,
// 2026-10-09): stage → division → competition, each a COLUMN (V432), the
// competition's NOT NULL so the chain has a floor.
import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import {
  CAMERA_POLICIES,
  assertCameraPolicyValue,
  assertPolicyChange,
  effectivePolicy,
  policyRank,
  readCameraPolicy,
  type CameraPolicy,
} from "../camera-policy";

describe("effectivePolicy", () => {
  // THE EMPTY CASE, FIRST. A policy set that answers "no" to every question
  // lands on the default, and three vacuous "Finished" defects shipped in
  // another programme because nobody wrote this line down.
  it("empty case: nothing set at any level ⇒ off", () => {
    expect(effectivePolicy({ stage: null, division: null, competition: null })).toBe("off");
  });

  it("stage wins when set, EVEN WHEN LESS STRICT than what it inherits", () => {
    // The differential case: the wrong implementation (max of the ranks)
    // answers "required" here, so this test can witness the regression.
    expect(effectivePolicy({ stage: "off", division: "required", competition: "required" })).toBe("off");
    expect(effectivePolicy({ stage: "optional", division: "required", competition: "off" })).toBe("optional");
  });

  it("the division wins over the competition when the stage is unset, downwards too", () => {
    expect(effectivePolicy({ stage: null, division: "off", competition: "required" })).toBe("off");
    expect(effectivePolicy({ stage: null, division: "required", competition: "off" })).toBe("required");
  });

  it("inherits the competition floor when stage and division are unset", () => {
    expect(effectivePolicy({ stage: null, division: null, competition: "required" })).toBe("required");
    expect(effectivePolicy({ stage: null, division: null, competition: "optional" })).toBe("optional");
    expect(effectivePolicy({ stage: null, division: null, competition: "off" })).toBe("off");
  });

  it("sweeps every (stage, division, competition) triple and reports how many it checked", () => {
    const levels: (CameraPolicy | null)[] = [null, ...CAMERA_POLICIES];
    let checked = 0;
    let decidedByStage = 0;
    let decidedByDivision = 0;
    let decidedByCompetition = 0;
    for (const stage of levels) {
      for (const division of levels) {
        for (const competition of levels) {
          const got = effectivePolicy({ stage, division, competition });
          // The rule as the spec states it — the NEAREST level that is set —
          // written as an explicit walk, not as the implementation's `??`.
          let want: CameraPolicy = "off";
          if (stage !== null) {
            want = stage;
            decidedByStage += 1;
          } else if (division !== null) {
            want = division;
            decidedByDivision += 1;
          } else if (competition !== null) {
            want = competition;
            decidedByCompetition += 1;
          }
          expect(got, `stage=${stage} division=${division} competition=${competition}`).toBe(want);
          checked += 1;
        }
      }
    }
    expect(levels.length, "premise: 3 policies plus unset").toBe(4);
    expect(checked, "anti-vacuity: 4 × 4 × 4 triples").toBe(64);
    // Every level actually decided some cases — a sweep where one level never
    // wins cannot see that level's precedence break.
    expect(decidedByStage, "stage decided 3 × 16 triples").toBe(48);
    expect(decidedByDivision, "division decided 3 × 4 triples").toBe(12);
    expect(decidedByCompetition, "competition decided 3 triples").toBe(3);
  });

  it("policyRank orders off < optional < required and covers the whole union", () => {
    expect(CAMERA_POLICIES).toEqual(["off", "optional", "required"]);
    expect(CAMERA_POLICIES.map(policyRank)).toEqual([0, 1, 2]);
  });

  it("policyRank refuses a value outside the union instead of returning NaN-ish -1", () => {
    // A guard, not a comment: an unranked policy would make assertPolicyChange
    // compare -1 and silently allow every change.
    let caught: unknown;
    try {
      policyRank("mandatory" as CameraPolicy);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(500);
    expect((caught as HttpError).code).toBe("CAMERA_POLICY_UNRANKED");
  });
});

describe("assertPolicyChange (D9 — downgrade-only once a round has opened)", () => {
  const pairs: { from: CameraPolicy; to: CameraPolicy }[] = CAMERA_POLICIES.flatMap((from) =>
    CAMERA_POLICIES.map((to) => ({ from, to })),
  );

  it("empty case: before any round opens, every ordered pair is allowed", () => {
    let checked = 0;
    for (const { from, to } of pairs) {
      expect(
        () => assertPolicyChange({ from, to, windowOpened: false }),
        `${from} → ${to} before the window`,
      ).not.toThrow();
      checked += 1;
    }
    expect(checked, "anti-vacuity: 3 × 3 ordered pairs").toBe(9);
  });

  it("once a round has opened, a downgrade or a no-op passes and an upgrade is refused", () => {
    let allowed = 0;
    let refused = 0;
    for (const { from, to } of pairs) {
      // Expected verdict from the ladder's DECLARED order (index in
      // CAMERA_POLICIES), not from policyRank, the code under test.
      const isUpgrade = CAMERA_POLICIES.indexOf(to) > CAMERA_POLICIES.indexOf(from);
      if (!isUpgrade) {
        expect(
          () => assertPolicyChange({ from, to, windowOpened: true }),
          `${from} → ${to} is a downgrade or a no-op`,
        ).not.toThrow();
        allowed += 1;
      } else {
        let caught: unknown;
        try {
          assertPolicyChange({ from, to, windowOpened: true });
        } catch (err) {
          caught = err;
        }
        expect(caught, `${from} → ${to} must be refused`).toBeInstanceOf(HttpError);
        expect((caught as HttpError).status).toBe(409);
        expect((caught as HttpError).code).toBe("POLICY_LOCKED");
        refused += 1;
      }
    }
    // 3 no-ops + 3 downgrades allowed, 3 upgrades refused.
    expect(allowed, "allowed pairs").toBe(6);
    expect(refused, "refused pairs").toBe(3);
    expect(allowed + refused, "anti-vacuity: every pair judged").toBe(9);
  });

  it("the two named attacks D9 exists for: erasing a flag, and stranding the field", () => {
    // required → off after the round opens is a RELAXATION the organiser may
    // need (a vendor outage), so it is allowed — and audited by the caller.
    expect(() => assertPolicyChange({ from: "required", to: "off", windowOpened: true })).not.toThrow();
    // off → required at T−5 strands a field that has no camera ready.
    expect(() => assertPolicyChange({ from: "off", to: "required", windowOpened: true })).toThrow(
      /relax/i,
    );
  });
});

describe("camera policy value readers", () => {
  it("empty case: an absent column value reads as null (INHERIT, not off)", () => {
    // null vs "off" is the whole point: "off" is an organiser's explicit
    // choice and overrides what it inherits; null falls through. Collapsing
    // them would stop a stage opting out of a division's `required`.
    expect(readCameraPolicy(null)).toBeNull();
    expect(readCameraPolicy(undefined)).toBeNull();
  });

  it("reads each of the three values, and nothing else", () => {
    let checked = 0;
    for (const p of CAMERA_POLICIES) {
      expect(readCameraPolicy(p)).toBe(p);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every declared policy read back").toBe(3);
    expect(readCameraPolicy("REQUIRED")).toBeNull();
    expect(readCameraPolicy(true)).toBeNull();
    expect(readCameraPolicy("")).toBeNull();
  });

  it("assertCameraPolicyValue accepts the three values, keeps null, and refuses junk", () => {
    let checked = 0;
    for (const p of CAMERA_POLICIES) {
      expect(assertCameraPolicyValue(p)).toBe(p);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(3);
    expect(assertCameraPolicyValue(null), "null clears the division's own value ⇒ inherit").toBeNull();
    expect(assertCameraPolicyValue(undefined), "undefined is null, never 'off'").toBeNull();
    for (const junk of ["mandatory", "", "OFF", 1, true, {}]) {
      let caught: unknown;
      try {
        assertCameraPolicyValue(junk);
      } catch (err) {
        caught = err;
      }
      expect(caught, `junk ${JSON.stringify(junk)}`).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(422);
      expect((caught as HttpError).code).toBe("CAMERA_POLICY_INVALID");
    }
  });
});
