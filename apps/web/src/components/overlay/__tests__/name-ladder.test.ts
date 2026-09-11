// `_THEMES.md` §1's size step, as arithmetic (W2-F45).
//
// Only `pickNameRung` is testable here: `apps/web` vitest is
// `environment: "node"`, so `availableNameWidth` — which reads boxes — is
// covered by `stream-overlay.spec.ts`'s ladder block in a real browser
// instead. Splitting them is what makes this file mean anything.
//
// Widths are in the order the ladder is: LONGEST FIRST. Every case below uses
// three rungs whose middle one DIFFERS from the last, so a picker that
// collapsed the ladder to "full or code" cannot pass.
import { describe, expect, it } from "vitest";
import { NAME_RUNG_HYSTERESIS_PX, pickNameRung } from "../name-ladder";

// "Riverside Athletic Club" / "Riverside" / "RIV" at 45px Barlow Condensed,
// rounded from the measured frame — the shape of a real ladder, not a scale.
const LADDER = [520, 210, 72];

describe("pickNameRung", () => {
  it("takes the FULL name when it fits", () => {
    expect(pickNameRung(LADDER, 600)).toBe(0);
    // Exactly on the boundary still fits: the cell is the space the name may
    // have, not the space it must leave.
    expect(pickNameRung(LADDER, 520)).toBe(0);
  });

  it("falls to the SHORT NAME — not straight to the code — when only it fits", () => {
    // The rung that tells a two-rung ladder from a three-rung one. A picker
    // that skipped the middle would answer 2 here and still satisfy every
    // "the name got smaller" assertion.
    expect(pickNameRung(LADDER, 519)).toBe(1);
    expect(pickNameRung(LADDER, 210)).toBe(1);
  });

  it("falls to the three-letter code when the short name does not fit either", () => {
    expect(pickNameRung(LADDER, 209)).toBe(2);
    expect(pickNameRung(LADDER, 72)).toBe(2);
  });

  it("holds the LAST rung when nothing fits, rather than answering -1", () => {
    // Reachable in a degenerate frame — a cell mid-resize. The code clips
    // there; painting the full name across the brand mark is the defect this
    // ladder exists to end, so the floor must be the SHORTEST rung.
    expect(pickNameRung(LADDER, 10)).toBe(2);
    expect(pickNameRung(LADDER, 0)).toBe(2);
  });

  it("a single-rung ladder is always rung 0", () => {
    expect(pickNameRung([72], 1000)).toBe(0);
    expect(pickNameRung([72], 4)).toBe(0);
  });

  describe("stepping UP costs the hysteresis, stepping DOWN does not", () => {
    it("a rung that only JUST fits is not taken from below", () => {
      // The team cell is `flex: 1 1 auto`, so the space a name gets grows with
      // the name rendered. Taking rung 0 at exactly its own width — measured
      // while rung 2 is on screen and the cell is therefore narrow — is the
      // move that un-fits it the moment it lands, and the two then alternate
      // for the length of the broadcast.
      expect(pickNameRung(LADDER, 520, 2)).toBe(1);
      expect(pickNameRung(LADDER, 520 + NAME_RUNG_HYSTERESIS_PX - 1, 2)).toBe(1);
    });

    it("and IS taken once there is room to spare", () => {
      // The positive pair: without it the case above passes for a picker that
      // never steps up at all.
      expect(pickNameRung(LADDER, 520 + NAME_RUNG_HYSTERESIS_PX, 2)).toBe(0);
    });

    it("stepping DOWN is immediate — a name that no longer fits is never held", () => {
      // Asymmetric on purpose. An overflowing name is on air wrong NOW; a name
      // that could grow is merely smaller than it might be.
      expect(pickNameRung(LADDER, 519, 0)).toBe(1);
      expect(pickNameRung(LADDER, 209, 0)).toBe(2);
    });

    it("staying PUT costs nothing — the current rung is not charged the margin", () => {
      // `i < current` is the guard, not `i !== current`: charging the rung
      // already on screen would make a name that exactly fills its cell flicker
      // one rung down and back.
      expect(pickNameRung(LADDER, 210, 1)).toBe(1);
    });
  });
});
