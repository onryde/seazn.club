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
    // (not a Task still owed here). F3 round-3 review correction
    // (2026-08-18): this comment used to say qualifierCount falls back to
    // its `|| 4` default for a topNPerGroup-only take (progressionSize's own
    // deliberate 0 for that kind) — that was true before commit 6351fd2ce's
    // same-session follow-up fix (stages.ts's qualifierCount now expands a
    // topNPerGroup take against the PREVIOUS stage's real shape via
    // expandTake + previewSourceShape) and is no longer what the code does.
    // Re-verified against the CURRENT code (F3 Tasks 1-2: setup timing +
    // groups_ko's topNPerGroup/bestNth draw) that neither change moves this
    // snapshot's numbers, for two SEPARATE reasons: previewDivisionFixtures
    // never reads `.timing` at all (the setup-timing flip is structurally
    // invisible to it — this snapshot can prove the stage graph and round
    // titles are unchanged, never that day-one fixtures exist); and
    // groups_ko's knockout entrantCount below (qualified:4, poolCount:2)
    // computes to 4 via the real expandTake path (2 pools x
    // topNPerGroup(n:2) = 4 qualifiers, genuinely counted, not a fallback)
    // — coincidentally the SAME number the old picks-based shape produced
    // (picks.length was 4) and the same number the `|| 4` guard would have
    // produced anyway. Re-verify by rerunning this test before trusting that
    // coincidence for any OTHER knob combination — a different
    // qualified/poolCount pair would move this snapshot today, now that
    // qualifierCount counts topNPerGroup for real instead of falling back.
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
