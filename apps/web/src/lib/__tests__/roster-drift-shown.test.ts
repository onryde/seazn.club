// W4 B2 fix round 2 (item 1): `rosterDriftShown` — the ONE test of whether a stage's board no longer matches its roster,
// read by the drift banner and by Update draw's offer (stages-panel.tsx). The empty case first: no drift at all, and a
// drift payload whose every direction is empty, answer no.
import { describe, expect, it } from "vitest";
import { rosterDriftShown } from "@/lib/roster-drift-eligibility";

const E = { id: "e1", display_name: "Ann" };

describe("rosterDriftShown", () => {
  it("no drift, an all-empty drift, and a payload that predates `vacantLines`: not shown", () => {
    expect(rosterDriftShown(undefined)).toBe(false);
    expect(rosterDriftShown({ ghosts: [], unplaced: [], vacantLines: 0 })).toBe(false);
    expect(rosterDriftShown({ ghosts: [], unplaced: [] })).toBe(false);
  });

  it("each direction alone shows it: a ghost, an unplaced entrant, an empty first-round place", () => {
    const cases: [string, Parameters<typeof rosterDriftShown>[0]][] = [
      ["ghost", { ghosts: [E], unplaced: [], vacantLines: 0 }],
      ["unplaced", { ghosts: [], unplaced: [E], vacantLines: 0 }],
      ["empty place", { ghosts: [], unplaced: [], vacantLines: 1 }],
    ];
    let checked = 0;
    for (const [why, drift] of cases) {
      expect(rosterDriftShown(drift), why).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
