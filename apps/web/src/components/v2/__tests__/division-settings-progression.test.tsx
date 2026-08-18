// F2 (unified progression field): division-settings.tsx reverse-derives the
// picker's "how many qualify" knob from the division's STORED stages, to
// pre-fill the Top-N-advance control when editing an existing format. It
// used to read `.qualification` (`topN` | `take.length`); now it must read
// `.progression.sources[].take[]`, matching whichever TakeRule kind
// format-templates.ts's real specs emit (rankRange -> to-from+1, picks ->
// picks.length, roundLosers -> count).
//
// currentQualifiedFromStages is a pure extraction (same reasoning as
// stages-panel.tsx's addStageProgression): the control that shows this
// value lives inside the "Format" Group, which defaults CLOSED
// (defaultOpen not passed, Group's own `{open && children}`) — a nested
// stateful component, opaque to both renderToStaticMarkup (children never
// render while closed) and the interactive hook-harness's one-level-deep
// expansion. Pure extraction sidesteps needing to open it at all.
import { describe, expect, it } from "vitest";
import { currentQualifiedFromStages } from "../division-settings";

describe("currentQualifiedFromStages — pre-fills Top-N-advance from progression, not qualification", () => {
  it("reads rankRange(1,6) as 6 — the topN replacement", () => {
    expect(
      currentQualifiedFromStages([
        { progression: null },
        {
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 6 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ]),
    ).toBe(6);
  });

  it("reads a picks take-rule's length — the take.length replacement", () => {
    expect(
      currentQualifiedFromStages([
        { progression: null },
        {
          progression: {
            sources: [
              {
                stage: "previous",
                take: [
                  {
                    kind: "picks",
                    picks: [
                      { pool: "A", rank: 1 },
                      { pool: "B", rank: 1 },
                      { pool: "A", rank: 2 },
                      { pool: "B", rank: 2 },
                      { pool: "A", rank: 3 },
                      { pool: "B", rank: 3 },
                    ],
                  },
                ],
              },
            ],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ]),
    ).toBe(6);
  });

  it("reads a roundLosers take-rule's count", () => {
    expect(
      currentQualifiedFromStages([
        { progression: null },
        {
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 3 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ]),
    ).toBe(3);
  });

  it("falls back to 4 when no stage carries a progression spec, same default as before", () => {
    expect(currentQualifiedFromStages([{ progression: null }, { progression: null }])).toBe(4);
    expect(currentQualifiedFromStages([])).toBe(4);
  });

  it("uses the FIRST stage with a progression spec, matching the old find() semantics", () => {
    expect(
      currentQualifiedFromStages([
        { progression: null },
        {
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
        {
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 8 }] }],
            placement: "rank_order",
            timing: "on_complete",
          },
        },
      ]),
    ).toBe(2);
  });
});
