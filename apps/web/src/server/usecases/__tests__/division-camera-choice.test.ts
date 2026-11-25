// Task 15 fix m2: `cameraChoiceTarget`, the receipt's "Fair-play camera: Yes / No" turned into what the division's OWN camera setting
// must become - swept over every own setting × every competition floor × both answers (4 × 3 × 2 = 24), purely. The DB sweep in
// online-package/__tests__/pay.test.ts proves the write (row, audit, package) on one floor; this proves the rule on all of them, the
// INHERITED floors included: a division that stores nothing over an Optional or Required competition already has the camera on.
//
// Not a registry sweep: the function takes no sport (the camera setting exists only for online chess; `assertCameraPolicyForSport`
// refuses the rest at the writer, upstream of this rule). The stage level is not this function's either: it writes the division's own
// column, and a stage's own policy is refused before it (`assertCameraChoiceFits`, 409 online_camera_set_by_stage).
//
// Expected values from the rulebook, never from the code:
//   * nearest level wins (spec 2026-10-09 §5.1): the division's own setting, else the competition's - typed out below as a table;
//   * P19 (Task 15): Yes on a division whose camera is off writes Required; No on one whose camera is on writes Off; an answer the
//     division already says writes nothing.
//
// Mutant (run once from a `cp` backup): FR9, the floor dropped (`competition: null`) -> both cases.
import { describe, expect, it } from "vitest";
import type { CameraPolicy } from "@/server/external-play/camera-policy";
import { cameraChoiceTarget } from "../division-camera-policy";

const OWN: (CameraPolicy | null)[] = [null, "off", "optional", "required"];
/** `competitions.camera_policy` is NOT NULL: these are its legal values. */
const FLOORS: CameraPolicy[] = ["off", "optional", "required"];

/** §5.1, typed out: is the camera on for players of this division (own setting over the competition's)? */
const CAMERA_ON: Record<string, Record<CameraPolicy, boolean>> = {
  null: { off: false, optional: true, required: true },
  off: { off: false, optional: false, required: false },
  optional: { off: true, optional: true, required: true },
  required: { off: true, optional: true, required: true },
};

describe("cameraChoiceTarget: the receipt's answer as the division's own setting (P19, §5.1)", () => {
  it("every own setting × floor × answer", () => {
    let checked = 0;
    let written = 0;
    for (const own of OWN) {
      for (const floor of FLOORS) {
        const on = CAMERA_ON[String(own)]![floor];
        for (const cameras of [true, false]) {
          const label = `own ${own}, floor ${floor}, answer ${cameras ? "Yes" : "No"}`;
          const want = on === cameras ? undefined : cameras ? "required" : "off";
          expect(cameraChoiceTarget({ stored: own, floor, cameras }), label).toBe(want);
          checked += 1;
          if (want !== undefined) written += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: 4 own settings × 3 floors × 2 answers").toBe(24);
    expect(written, "both kinds ran: a write, and an answer the division already says").toBe(12);
  });

  it("the inherited floors: an own setting of null over an Optional or Required competition already says Yes (nothing written), and No writes Off", () => {
    for (const floor of ["optional", "required"] as CameraPolicy[]) {
      expect(cameraChoiceTarget({ stored: null, floor, cameras: true }), `Yes over ${floor}`).toBeUndefined();
      expect(cameraChoiceTarget({ stored: null, floor, cameras: false }), `No over ${floor}`).toBe("off");
    }
    // ...and an own Off over a Required competition is OFF (nearest wins): Yes writes Required, No writes nothing.
    expect(cameraChoiceTarget({ stored: "off", floor: "required", cameras: true })).toBe("required");
    expect(cameraChoiceTarget({ stored: "off", floor: "required", cameras: false })).toBeUndefined();
  });
});
