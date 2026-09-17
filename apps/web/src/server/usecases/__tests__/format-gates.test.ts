// Pure unit tests for the shared stage-format gates (P4 review 2026-08-13,
// finding 5) — the ONE definition createStages (usecases/stages.ts) and
// createFromTemplate (usecases/templates.ts, D1a) both call. This file pins
// every branch directly; templates.test.ts additionally exercises the
// template path end-to-end with an edge case (config.placements) the
// pre-existing americano-night regression test doesn't cover, so a future
// re-duplication in either call site is caught two ways.
import { describe, expect, it } from "vitest";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "../format-gates";
import { buildTemplateStages } from "@/components/v2/format-templates";

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

// Swiss Knockout ships WITHOUT a `pro` badge (product decision: both halves
// are free kinds, same as league_ko). A badge and a gate that disagree is a
// defect either way round, so this asserts the gates against the template's
// REAL stage drafts rather than against a kind list typed in by hand — if a
// later edit gives the swiss stage a `byes`/`cross_feeds`/`placements` key,
// or swaps the plain knockout for a page_playoff, this reds instead of
// silently paywalling a format the catalogue advertises as free.
describe("swiss_knockout is free at the server gate, and swiss_playoff is not", () => {
  const KNOBS = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 };

  it("no swiss_knockout stage trips either gate, at any Top N the knob offers", () => {
    for (const qualified of [2, 3, 4, 8, 32]) {
      const stages = buildTemplateStages("swiss_knockout", { ...KNOBS, qualified });
      // buildTemplateStages falls back to STAGE_TEMPLATES[0] (league) for an
      // unknown key, which would make every gate assertion below true of the
      // wrong format. Pin the shape first so this cannot pass vacuously.
      expect(stages.map((s) => s.kind)).toEqual(["swiss", "knockout"]);
      for (const stage of stages) {
        expect(stageNeedsDoubleElimGate(stage.kind), `${stage.kind} @ N=${qualified}`).toBe(false);
        expect(stageNeedsAdvancedFormatsGate(stage), `${stage.kind} @ N=${qualified}`).toBe(false);
      }
    }
  });

  it("swiss_playoff still trips the double_elim gate on its page_playoff half", () => {
    const stages = buildTemplateStages("swiss_playoff", KNOBS);
    expect(stages.some((s) => stageNeedsDoubleElimGate(s.kind))).toBe(true);
  });
});
