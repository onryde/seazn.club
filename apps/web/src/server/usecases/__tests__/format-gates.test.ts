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

// Bug fix 2026-08-18 (gate-copy): the "League + Playoffs" template's Pro
// gate read "Double-elimination brackets are a Pro format." for a
// page_playoff stage — no double elimination in that template at all. The
// fix (feature-copy.ts's doubleElimFormatReason, wired through
// template-gallery.tsx and upgrade-gate.tsx) is copy-only and must never
// change WHICH kinds this gate fires on — that set is pinned here so a
// future "fix" cannot quietly narrow the shared entitlement instead of just
// the wording.
describe("stageNeedsDoubleElimGate — gated kind set is unchanged by the gate-copy fix", () => {
  it("still gates on exactly double_elim and page_playoff, sharing one entitlement on purpose", () => {
    expect(stageNeedsDoubleElimGate("double_elim")).toBe(true);
    expect(stageNeedsDoubleElimGate("page_playoff")).toBe(true);
    expect(stageNeedsDoubleElimGate("knockout")).toBe(false);
  });
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
