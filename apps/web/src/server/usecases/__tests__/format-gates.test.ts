// Pure unit tests for the shared stage-format gates (P4 review 2026-08-13,
// finding 5) — the ONE definition createStages (usecases/stages.ts) and
// createFromTemplate (usecases/templates.ts, D1a) both call. This file pins
// every branch directly; templates.test.ts additionally exercises the
// template path end-to-end with an edge case (config.placements) the
// pre-existing americano-night regression test doesn't cover, so a future
// re-duplication in either call site is caught two ways.
import { describe, expect, it } from "vitest";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "../format-gates";

describe("stageNeedsDoubleElimGate", () => {
  it.each(["double_elim", "page_playoff"])("gates on kind '%s'", (kind) => {
    expect(stageNeedsDoubleElimGate(kind)).toBe(true);
  });

  it.each(["knockout", "group", "league", "swiss", "americano", "ladder", "stepladder"])(
    "does not gate on kind '%s'",
    (kind) => {
      expect(stageNeedsDoubleElimGate(kind)).toBe(false);
    },
  );
});

describe("stageNeedsAdvancedFormatsGate", () => {
  it.each(["americano", "ladder"])("gates on kind '%s' regardless of config", (kind) => {
    expect(stageNeedsAdvancedFormatsGate({ kind })).toBe(true);
  });

  it.each(["knockout", "group", "league", "swiss", "double_elim", "page_playoff", "stepladder"])(
    "does not gate on kind '%s' with no config",
    (kind) => {
      expect(stageNeedsAdvancedFormatsGate({ kind })).toBe(false);
    },
  );

  it.each([
    ["byes", { byes: ["e1"] }],
    ["cross_feeds", { cross_feeds: [{ to_stage_seq: 2 }] }],
    ["placements", { placements: [{ from: 1, to: 2 }] }],
  ] as const)("gates on a basic kind ('group') when config.%s is set", (_key, config) => {
    expect(stageNeedsAdvancedFormatsGate({ kind: "group", config })).toBe(true);
  });

  it("does not gate a basic kind with an empty/unrelated config", () => {
    expect(stageNeedsAdvancedFormatsGate({ kind: "knockout", config: {} })).toBe(false);
    expect(stageNeedsAdvancedFormatsGate({ kind: "knockout", config: { thirdPlace: true } })).toBe(
      false,
    );
    expect(stageNeedsAdvancedFormatsGate({ kind: "knockout", config: undefined })).toBe(false);
  });
});
