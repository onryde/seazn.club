import { describe, it, expect } from "vitest";
import { assertScorebugSpec } from "../types";
import type { GuidedSheetSpec, PadHostView, SheetPersonStep, SkinDefV3 } from "../types";
import type { MessageKey } from "@/lib/messages";

// Fixture-only title, never resolved through i18n in this file's checks.
const T_KEY = "t" as MessageKey;

const half = (over: Partial<import("../types").ScorebugHalf> = {}) => ({
  who: [{ name: "A" }], big: "0", ...over,
});

describe("assertScorebugSpec", () => {
  it("accepts a passive spec", () => {
    expect(assertScorebugSpec({ context: "c", phase: "live", halves: [half(), half()], strip: [] })).toEqual([]);
  });
  it("rejects tappable without hintKey or tapEvent", () => {
    const v = assertScorebugSpec({ context: "c", phase: "live", halves: [half({ tappable: true }), half()], strip: [] });
    expect(v).toContain("halves[0]: tappable requires hintKey");
    expect(v).toContain("halves[0]: tappable requires tapEvent");
  });
  it("rejects an empty who array", () => {
    // Task 5 follow-up: this branch (types.ts:74, `who must be non-empty`)
    // shipped in Task 1 with no test — a mutant deleting the check
    // survived. Deliberately non-tappable here so the other two checks
    // stay unfired and this assertion is isolated to the one message.
    const v = assertScorebugSpec({
      context: "c",
      phase: "live",
      halves: [{ who: [], big: "0" }, half()],
      strip: [],
    });
    expect(v).toEqual(["halves[0]: who must be non-empty"]);
  });

  // Task 8 fix round 2 (review re-review round 1, Important I1(b), ruling
  // R43) — the SHAPE half of ScorebugHalf.side's contract, holding across
  // every skin including cricket.
  it("accepts a spec where NEITHER half carries side — cricket's shape", () => {
    expect(assertScorebugSpec({ context: "c", phase: "live", halves: [half(), half()], strip: [] })).toEqual([]);
  });
  it("accepts a spec where BOTH halves carry side, and the values differ — every other skin's shape", () => {
    const v = assertScorebugSpec({
      context: "c",
      phase: "live",
      halves: [half({ side: "home" }), half({ side: "away" })],
      strip: [],
    });
    expect(v).toEqual([]);
  });
  it("rejects side set on only ONE half — kills a mutant that drops it from a single producer", () => {
    const v = assertScorebugSpec({
      context: "c",
      phase: "live",
      halves: [half({ side: "home" }), half()],
      strip: [],
    });
    expect(v).toEqual(["halves: side must be set on every half or none — found it on some but not all"]);
  });
  it("rejects BOTH halves carrying the SAME side — kills a mutant that sets \"home\" on both", () => {
    const v = assertScorebugSpec({
      context: "c",
      phase: "live",
      halves: [half({ side: "home" }), half({ side: "home" })],
      strip: [],
    });
    expect(v).toEqual([`halves: side values must all differ — found ${JSON.stringify(["home", "home"])}`]);
  });
});

// G4 (controller ruling 2026-08-16, docs/superpowers/plans/2026-08-16-
// scorepad-v3-r2-cricket.md): `SkinDefV3.sheets` is a METHOD of the view,
// not a static record — the whole point being that a sheet's `buildPayload`
// can close over live match state (cricket's wicket needs over/ballInOver/
// striker/nonStriker/bowler, none of which the wizard itself asks for).
describe("SkinDefV3.sheets — G4 (method of view, closes over live state)", () => {
  type ViewT = { tag: string };
  type SheetsType = SkinDefV3<ViewT>["sheets"];

  it("a function of view is assignable, and its result reflects the view it was called with", () => {
    const sheets: SheetsType = (view) => ({
      wicket: { event: `cricket.ball.${view.tag}`, steps: [], buildPayload: () => ({}) },
    });
    const a = sheets?.({ tag: "a" });
    const b = sheets?.({ tag: "b" });
    expect(a?.wicket.event).toBe("cricket.ball.a");
    expect(b?.wicket.event).toBe("cricket.ball.b");
    // Different views must produce genuinely different closed-over output —
    // proves this is read fresh per view, not a fixed value the view
    // parameter happens to be ignored by.
    expect(a?.wicket.event).not.toBe(b?.wicket.event);
  });

  it("a bare static record — the pre-G4 shape — is no longer assignable", () => {
    const staticSheets: Record<string, GuidedSheetSpec> = {
      wicket: { event: "cricket.ball", steps: [], buildPayload: () => ({}) },
    };
    // @ts-expect-error G4: `sheets` is now `(view) => Record<...>`, a
    // function type — a plain Record no longer satisfies it. If this stops
    // erroring (e.g. someone reverts the G4 type change), tsc reports
    // TS2578 "Unused '@ts-expect-error' directive" and this file fails to
    // typecheck — the real assertion runs in `npm run typecheck`, not vitest.
    const bad: SheetsType = staticSheets;
    void bad;
  });
});

// G5 (controller ruling 2026-08-16, same plan doc): PadHostView.contextOverrides
// is a REQUIRED field — the host must always supply it (an omitted field
// would silently read as `undefined` at every resolvePeople(state, overrides)
// call site cricket.tsx makes, defeating the whole mechanism).
describe("PadHostView.contextOverrides — G5 (required, not optional)", () => {
  const base: Omit<PadHostView, "contextOverrides"> = {
    cfg: {},
    state: {},
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: { home: { entrantId: "h", members: [], subsUsed: 0, exemptUsed: {} }, away: { entrantId: "a", members: [], subsUsed: 0, exemptUsed: {} } },
    events: [],
    stageKind: null,
    canOrganise: true,
  };

  it("a full object with contextOverrides is assignable", () => {
    const v: PadHostView = { ...base, contextOverrides: { striker: "h1" } };
    expect(v.contextOverrides.striker).toBe("h1");
  });

  it("omitting contextOverrides is a type error — it is required, not optional", () => {
    // @ts-expect-error G5: contextOverrides has no `?`, so a PadHostView
    // literal missing it must fail to typecheck. If this stops erroring
    // (e.g. someone widens the field back to optional), tsc reports TS2578
    // and this file fails `npm run typecheck` — the real assertion.
    const bad: PadHostView = base;
    void bad;
  });
});

// G6 (controller ruling 2026-08-16, same plan doc): SheetPersonStep.candidates
// is additive/optional — every step shape from before G6 (pool/side only)
// must stay assignable with zero change.
describe("SheetPersonStep.candidates — G6 (additive, optional)", () => {
  it("a step with no candidates at all is still assignable — pre-G6 shape unchanged", () => {
    const step: SheetPersonStep = { id: "who", kind: "person", title: T_KEY, pool: "onfield", side: "home" };
    expect(step.candidates).toBeUndefined();
  });

  it("a step declaring an explicit candidates list is assignable", () => {
    const step: SheetPersonStep = { id: "out", kind: "person", title: T_KEY, pool: "onfield", side: "home", candidates: ["h1", "h2"] };
    expect(step.candidates).toEqual(["h1", "h2"]);
  });
});
