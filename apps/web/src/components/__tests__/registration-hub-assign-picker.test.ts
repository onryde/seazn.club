// RS009 — the two pure decisions behind the assign sheet.
//
// `mixedRuleBlocks` is a deliberate SECOND copy of a server rule
// (`compositionRefusal`, registration-assign.ts) and that is the risk this
// file exists to hold down. The server stays authoritative — it refuses
// regardless of what the sheet drew — but if the two drift, the organiser is
// told a team is pickable and then told it is not, which is worse than
// either answer alone. The cases below are written to mirror the server
// tests in registration-assign.test.ts one for one.
//
// Only the pure functions are covered here. The sheet's DOM behaviour (Esc,
// focus return, the disabled state actually preventing a click) is not
// unit-testable in this repo — asserting on it without a DOM would pass in
// both states — so it belongs to the e2e walkthrough, not to a mirror test
// that cannot fail.
import { describe, expect, it } from "vitest";
import {
  mixedRuleBlocks,
  orderTargets,
  type AssignTarget,
} from "@/components/registration-hub-assign-picker";

function team(over: Partial<AssignTarget> & { display_name: string }): AssignTarget {
  return {
    registration_id: over.display_name.toLowerCase().replace(/\s+/g, "-"),
    roster_count: 0,
    roster_cap: 7,
    is_full: false,
    genders: [],
    ...over,
  };
}

describe("mixedRuleBlocks", () => {
  it("blocks the placement that would close a mixed team on one gender", () => {
    const t = team({ display_name: "Team A", roster_count: 6, roster_cap: 7, genders: ["m", "m", "m", "m", "m", "m"] });
    expect(mixedRuleBlocks("mixed", t, "m")).toBe(true);
  });

  it("allows the placement that satisfies the rule instead of breaking it", () => {
    const t = team({ display_name: "Team A", roster_count: 6, roster_cap: 7, genders: ["m", "m", "m", "m", "m", "m"] });
    expect(mixedRuleBlocks("mixed", t, "f")).toBe(false);
  });

  it("stays quiet while the team still has room to become mixed", () => {
    // Two men and five places left is a team still filling, not a problem.
    // Blocking here would stop an organiser at the very first placement.
    const t = team({ display_name: "Team A", roster_count: 2, roster_cap: 7, genders: ["m", "m"] });
    expect(mixedRuleBlocks("mixed", t, "m")).toBe(false);
  });

  it("ignores divisions that carry no composition rule", () => {
    const t = team({ display_name: "Team A", roster_count: 6, roster_cap: 7, genders: ["m", "m", "m", "m", "m", "m"] });
    expect(mixedRuleBlocks("mens", t, "m")).toBe(false);
    expect(mixedRuleBlocks(null, t, "m")).toBe(false);
  });

  it("never blocks an unlimited roster — there is no closing placement", () => {
    const t = team({ display_name: "Team A", roster_count: 6, roster_cap: null, genders: ["m", "m"] });
    expect(mixedRuleBlocks("mixed", t, "m")).toBe(false);
  });

  it("does not guess when the registrant's gender is unknown", () => {
    // A null gender cannot complete a mixed roster, so the honest prediction
    // is "cannot tell" — and the sheet must not disable a team the server
    // may well accept. The server still has the final word.
    const t = team({ display_name: "Team A", roster_count: 6, roster_cap: 7, genders: ["m", "f", "m", "m", "m", "m"] });
    expect(mixedRuleBlocks("mixed", t, null)).toBe(false);
  });
});

describe("orderTargets", () => {
  it("puts the team with the most room first — that is the decision being made", () => {
    const ordered = orderTargets(
      [
        team({ display_name: "Nearly full", roster_count: 6, roster_cap: 7 }),
        team({ display_name: "Half", roster_count: 3, roster_cap: 7 }),
        team({ display_name: "Empty", roster_count: 0, roster_cap: 7 }),
      ],
      null,
      null,
    );
    expect(ordered.map((t) => t.display_name)).toEqual(["Empty", "Half", "Nearly full"]);
  });

  it("sinks full and blocked teams below every pickable one", () => {
    const ordered = orderTargets(
      [
        team({ display_name: "Full", roster_count: 7, roster_cap: 7, is_full: true }),
        team({ display_name: "Nearly full", roster_count: 6, roster_cap: 7 }),
      ],
      null,
      null,
    );
    expect(ordered.map((t) => t.display_name)).toEqual(["Nearly full", "Full"]);
  });

  it("sinks a mixed-blocked team even though it still has a free place", () => {
    // The distinction a plain room-sort cannot make: this team has room and
    // is still unpickable, so room alone would float it to the top.
    const ordered = orderTargets(
      [
        team({
          display_name: "Blocked",
          roster_count: 6,
          roster_cap: 7,
          genders: ["m", "m", "m", "m", "m", "m"],
        }),
        team({ display_name: "Open", roster_count: 6, roster_cap: 7, genders: ["m", "f", "m", "m", "m", "m"] }),
      ],
      "mixed",
      "m",
    );
    expect(ordered.map((t) => t.display_name)).toEqual(["Open", "Blocked"]);
  });

  it("treats an unlimited roster as the roomiest", () => {
    const ordered = orderTargets(
      [
        team({ display_name: "Capped", roster_count: 0, roster_cap: 7 }),
        team({ display_name: "Unlimited", roster_count: 4, roster_cap: null }),
      ],
      null,
      null,
    );
    expect(ordered.map((t) => t.display_name)).toEqual(["Unlimited", "Capped"]);
  });

  it("breaks ties on name so the list cannot reshuffle under the cursor", () => {
    const ordered = orderTargets(
      [
        team({ display_name: "Zulu", roster_count: 2, roster_cap: 7 }),
        team({ display_name: "Alpha", roster_count: 2, roster_cap: 7 }),
        team({ display_name: "Mike", roster_count: 2, roster_cap: 7 }),
      ],
      null,
      null,
    );
    expect(ordered.map((t) => t.display_name)).toEqual(["Alpha", "Mike", "Zulu"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [
      team({ display_name: "Nearly full", roster_count: 6, roster_cap: 7 }),
      team({ display_name: "Empty", roster_count: 0, roster_cap: 7 }),
    ];
    orderTargets(input, null, null);
    expect(input.map((t) => t.display_name)).toEqual(["Nearly full", "Empty"]);
  });
});
