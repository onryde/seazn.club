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
            timing: "on_complete",
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
            timing: "on_complete",
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
    // shape drift. This ONE line is fixed so the marker stays meaningful;
    // the test as a whole stays red (snapshot mismatch) until Task 6
    // converts previewDivisionFixtures/qualifierCount to read
    // `.progression` — every later-stage entrant count currently falls
    // back to qualifierCount's `|| 4` default regardless of the real
    // take-rule count, which is a real (if silent) behaviour gap this file
    // cannot close on its own. Do not regenerate this snapshot until then.
    const summary = STAGE_TEMPLATES.map((t) => {
      const stages = t.build(4);
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
