// F2 (unified progression field): stages-panel.tsx's "Add stage" form
// (AddStageForm) POSTs qualification: { topN } today. Task 5a already made
// CreateStage .strict() (schemas.ts), so that unknown key now 400s and the
// live "Add stage" flow is broken until this converts — dispatch's own
// framing: "Highest priority of your UI files."
//
// addStageProgression(topN) is a pure extraction of the POST body's
// progression shape, unit-testable without the interactive hook-harness —
// same reasoning as this file's own generatePreconditionMessage ("pure, no
// state, so this classification is unit-testable without a DOM/jsdom
// harness"). The harness can't reach it directly anyway: AddStageForm is a
// nested STATEFUL component inside StagesPanel, which stays opaque to
// walk()/renderIsland's one-level-deep expansion (component-ui-i18n /
// hook-harness memory).
import { describe, expect, it } from "vitest";
import { addStageProgression } from "../stages-panel";

describe("addStageProgression — the Add-stage form's POST body shape", () => {
  it("emits rankRange(1,topN), rank_order, on_complete — the qualification:{topN} replacement", () => {
    expect(addStageProgression(4)).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
  });

  it("threads the topN value through to rankRange.to, not a fixed constant", () => {
    expect(addStageProgression(8).sources[0]!.take[0]).toEqual({ kind: "rankRange", from: 1, to: 8 });
  });

  it("always on_complete — this form generates immediately, falling back to seed-on-completion only if the source isn't done (Decision 1)", () => {
    expect(addStageProgression(2).timing).toBe("on_complete");
    expect(addStageProgression(6).timing).toBe("on_complete");
  });
});
