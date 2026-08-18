// F1 Task 5 — a bye's phantom opponent must read "Bye", not "TBD" ("TBD"
// tells an organiser to wait for something that is not coming), plus a
// catalogue regression: every shipped format's day-one preview shape
// (stage graph, round titles) is snapshotted so a future change to what a
// format produces has to be a deliberate, reviewed diff.
import { describe, expect, it } from "vitest";
import { previewDivisionFixtures } from "../stages";
import { STAGE_TEMPLATES } from "@/components/v2/format-templates";

describe("previewDivisionFixtures — bye label (F1 Task 5)", () => {
  it("labels an unfilled first-round slot in a bye pairing as Bye, not TBD", () => {
    // League (12 entrants) -> knockout of 6 qualifiers: 6 is not a power of
    // two, so buildSingleElim pads to 8 slots and awards 2 byes in round 0.
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, progression: null },
        {
          kind: "knockout",
          name: "KO",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 6 }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ],
      12,
    );
    const first = phases[1]!.sections[0]!.matches;
    expect(first.some((m) => m.away === "Bye" || m.home === "Bye")).toBe(true);
    expect(first.some((m) => m.away === "TBD" || m.home === "TBD")).toBe(false);
  });

  it("never renders a bye's real side as Bye (only the phantom opponent)", () => {
    const phases = previewDivisionFixtures(
      [
        { kind: "league", name: "League", config: {}, progression: null },
        {
          kind: "knockout",
          name: "KO",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 6 }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ],
      12,
    );
    const first = phases[1]!.sections[0]!.matches;
    const byeMatches = first.filter((m) => m.away === "Bye" || m.home === "Bye");
    expect(byeMatches.length).toBeGreaterThan(0);
    // A bye row's OTHER side is always a real seed label, never itself "Bye".
    for (const m of byeMatches) {
      expect(m.home === "Bye" && m.away === "Bye").toBe(false);
    }
  });
});

describe("format catalogue — shape regression (F1 Task 5)", () => {
  // The 25-format sweep that found the naming defect (§2.3). Locks stage
  // graph, progression mode, and each phase's round titles — a future
  // change to what a format produces (a new round namer, a reordered
  // stage) has to update this snapshot deliberately, not drift silently.
  it("every shipped format produces its known shape", () => {
    // F2 T5b collateral fix (not a task-owned file — see stages: line
    // below): format-templates.ts's StageDraft carries `progression` now,
    // never `qualification` — reading the old field here would silently
    // read undefined for every stage and always emit "-", masking real
    // shape drift. This ONE line is fixed so the marker stays meaningful.
    // previewDivisionFixtures/qualifierCount already read `.progression`
    // (not a Task still owed here) — but qualifierCount's progressionSize()
    // call treats `topNPerGroup` as group-count-dependent and contributes 0
    // to the count (a real shape needs expandTake + a SourceShape, which
    // qualifierCount doesn't have), so a later stage fed BY a
    // topNPerGroup-only take (no bestNth remainder) falls back to
    // qualifierCount's `|| 4` default regardless of the real qualifier
    // count. Real, if silent, and this file cannot close it on its own
    // (previewDivisionFixtures is out of scope for F3's format-templates.ts
    // change) — verified (2026-08-18, F3 Tasks 1-2: setup timing +
    // groups_ko's topNPerGroup/bestNth draw) that it does NOT move this
    // snapshot's numbers: previewDivisionFixtures never reads `.timing`,
    // and groups_ko's knockout entrantCount stays 4 either way for the
    // qualified:4/poolCount:2 knobs below (old picks.length was 4; new
    // topNPerGroup(n:2) contributes 0 to progressionSize and falls back to
    // the same `|| 4`). Re-verify by rerunning this test before trusting
    // that coincidence for any OTHER knob combination.
    const summary = STAGE_TEMPLATES.map((t) => {
      const stages = t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
      const phases = previewDivisionFixtures(stages, 8);
      return {
        key: t.key,
        stages: stages.map((s) => `${s.kind}:${s.progression ? "Q" : "-"}`).join(">"),
        rounds: phases.map((p) => p.sections.map((sec) => sec.title)),
      };
    });
    expect(summary).toMatchSnapshot();
  });
});
