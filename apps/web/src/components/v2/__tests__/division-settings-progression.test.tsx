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

// A3 (round-4 review, MAJOR): groups_ko emits topNPerGroup (+ a bestNth
// remainder), never `picks`, since ruling 11's F3 conversion — this function
// still only recognised rankRange/picks/roundLosers, so it fell through the
// `for` loop untouched and hit the `return 4` fallback for EVERY groups_ko
// division. Settings then showed "4" regardless of the real qualifier count,
// and one unrelated edit + Apply (applyStructure, division-settings.tsx)
// would silently rewrite the stored progression down to a 4-qualifier
// knockout — destroying a draw the organiser may have already shared.
describe("currentQualifiedFromStages — topNPerGroup / bestNth (groups_ko, A3 fix)", () => {
  it("topNPerGroup alone: n × the group stage's pool count — the exact 8-qualifiers/4-pools shape the review reported reading back as 4", () => {
    expect(
      currentQualifiedFromStages([
        { kind: "group", config: { pools: { count: 4 } }, progression: null },
        {
          kind: "knockout",
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ]),
    ).toBe(8);
  });

  it("bestNth alone (the n===0 collapse: fewer qualifiers than pools): just its count", () => {
    expect(
      currentQualifiedFromStages([
        { kind: "group", config: { pools: { count: 8 } }, progression: null },
        {
          kind: "knockout",
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 1, count: 2 }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ]),
    ).toBe(2);
  });

  it("topNPerGroup + bestNth remainder SUM to the real qualifier count — groups_ko's actual cross-pool shape", () => {
    expect(
      currentQualifiedFromStages([
        { kind: "group", config: { pools: { count: 6 } }, progression: null },
        {
          kind: "knockout",
          progression: {
            sources: [
              {
                stage: "previous",
                take: [
                  { kind: "topNPerGroup", n: 2 },
                  { kind: "bestNth", nth: 3, count: 4 },
                ],
              },
            ],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ]),
    ).toBe(16); // 2*6 + 4 — matches the qualified:16, poolCount:6 template fixture exactly.
  });

  // F3 ultrareview finding 8 — the pool count feeding topNPerGroup came from
  // `stages.find((st) => st.kind === "group")`, the first group stage in the
  // division, not the one this progression reads. A qualifying pool round in
  // front of a main group stage therefore sized the knockout off the WRONG
  // phase, and the number the organiser sees in Settings is the number they
  // trust when deciding how many advance.
  it("takes the pool count from the group stage the progression sources, not the first one in the division", () => {
    expect(
      currentQualifiedFromStages([
        // Qualifying pools — 8 groups, nothing to do with the KO's size.
        { kind: "group", config: { pools: { count: 8 } }, progression: null },
        // The main group stage: 4 pools, and the one "previous" names.
        { kind: "group", config: { pools: { count: 4 } }, progression: null },
        {
          kind: "knockout",
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ]),
    ).toBe(8); // 2 x 4 pools. The old rule read 8 pools and answered 16.
  });

  it("still reads a single group stage the same way (the shape every shipped template has)", () => {
    expect(
      currentQualifiedFromStages([
        { kind: "group", config: { pools: { count: 4 } }, progression: null },
        {
          kind: "knockout",
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ]),
    ).toBe(8);
  });
});
