// view-model.ts — the pure PadSpec -> PadView projection (S10/#419 W8).
// Real modules throughout (generic + cricket + tennis), never a hand-rolled
// spec, so a gate/band/entitlement test doubles as proof the wiring survives
// contact with an actual padSpec() — see _hook-harness's own documented
// gotcha about hand-abbreviated state shapes crashing a downstream
// `summary()`/`fold` read in ways that silently discard the assertion.
import { describe, expect, it } from "vitest";
import { foldMatch } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { cricket } from "@seazn/engine/sports/cricket";
import { tennis } from "@seazn/engine/sports/tennis";
import { foldClient, resolveModuleClient } from "../module-client";
import { createSkinDispatch } from "../v3/skin-dispatch";
import {
  allActionViews,
  buildActionPayload,
  buildPadView,
  checkActionValidity,
  deriveFieldPathLabel,
  summaryHeadline,
  type PadViewCtx,
} from "../view-model";

describe("buildPadView — phase scoping", () => {
  const generic = resolveModuleClient("generic", "1.0.0");
  const cfg = { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
  const spec = generic.padSpec!(cfg);
  const lineups = defaultLineupPair(generic.positions);
  const state = generic.init(cfg, lineups);
  const baseCtx: PadViewCtx = {
    state,
    summary: generic.summary(state),
    phase: "live",
    band: 3,
  };

  it("only returns panels declared at the requested phase", () => {
    const view = buildPadView(spec, baseCtx);
    expect(view.phase).toBe("live");
    for (const panel of view.panels) expect(panel.phase).toBe("live");
    expect(view.panels.length).toBeGreaterThan(0);
  });

  it("reports every phase the spec declares at least one panel for, structurally (not gate/band filtered)", () => {
    const view = buildPadView(spec, baseCtx);
    // R7 defect fix (`everyPhase`, generic.ts): every panel generic declares
    // is now reachable at "pre" as well as "live" — never "post".
    expect(view.phases).toEqual(["pre", "live"]);
  });

  it("returns an empty panels array for a phase the spec never declares", () => {
    // "post" — not "pre" — is generic's genuinely undeclared phase since the
    // R7 defect fix: `everyPhase` (generic.ts) expands every panel to both
    // "pre" and "live", so "pre" no longer proves this property.
    const view = buildPadView(spec, { ...baseCtx, phase: "post" });
    expect(view.panels).toEqual([]);
  });
});

// R7 defect fix — the "pad offers what the engine refuses" class R2c closed
// three instances of. Before `everyPhase` (generic.ts), `createSkinDispatch`
// (v3/skin-dispatch.ts, migrated from skins/types.ts in R8) refused every
// generic.score/generic.result tap in "pre"
// phase with "skin dispatched an action the spec does not declare at this
// phase... Declared here: (none)", even though `applyScore`/`applyResult`
// (generic.ts) both accept "pre" — the FOLD and the PAD disagreed.
//
// Drives the REAL dispatch chain (`buildPadView` -> `createSkinDispatch`),
// not just padSpec's own shape in isolation: that gap is exactly what a
// padSpec-only assertion cannot see, and IS what let the original defect
// ship past the shared conformance suite — `padSpecConformanceSuite`'s
// coverage checks (`checkActionCoverage`) walk every panel regardless of
// phase, so a type reachable ONLY at "live" still reads as "reachable",
// with no criterion that ever asks "reachable at every phase the fold
// itself accepts". This test is the phase-aware check that gap left open.
describe("generic in \"pre\" phase — the pad must not offer what the engine refuses (R7)", () => {
  const generic = resolveModuleClient("generic", "1.0.0");
  const cfg = { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
  const spec = generic.padSpec!(cfg);
  const lineups = defaultLineupPair(generic.positions);
  const state = generic.init(cfg, lineups); // phase: "pre" — no core.start folded yet
  const preCtx: PadViewCtx = { state, summary: generic.summary(state), phase: "pre", band: 3 };

  it("generic.score (the running tally) dispatches before Start match, matching what applyScore accepts", async () => {
    const view = buildPadView(spec, preCtx);
    const dispatch = createSkinDispatch(view, async () => {});
    await expect(dispatch("generic.score", { by: lineups.home.entrantId, points: 1 })).resolves.toBeUndefined();
  });

  it("generic.result (settling a fixture that was never started) dispatches before Start match, matching what applyResult accepts", async () => {
    const view = buildPadView(spec, preCtx);
    const dispatch = createSkinDispatch(view, async () => {});
    await expect(dispatch("generic.result", { p1Score: 3, p2Score: 1 })).resolves.toBeUndefined();
  });
});

describe("buildPadView — gate evaluation is delegated to the engine's evalPadGate, against REAL folded state", () => {
  // generic's "settle from tally" panel: `{op:"path-truthy", path:"state.running"}`
  // — undefined pre-score, set once a real generic.score event folds.
  const generic = resolveModuleClient("generic", "1.0.0");
  const cfg = { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
  const spec = generic.padSpec!(cfg);
  const lineups = defaultLineupPair(generic.positions);

  it("hides the gated panel before any score event (state.running is unset)", () => {
    const state = generic.init(cfg, lineups);
    const view = buildPadView(spec, { state, summary: generic.summary(state), phase: "live", band: 3 });
    expect(view.panels.some((p) => p.labelKey.key === "pad.generic.panel.settle")).toBe(false);
  });

  it("shows the gated panel once a real score event has folded (state.running is set)", () => {
    const events = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "generic.score", payload: { by: "H", points: 3 } }),
    ];
    const state = foldClient(generic, cfg, lineups, events);
    const view = buildPadView(spec, { state, summary: generic.summary(state), phase: "live", band: 3 });
    expect(view.panels.some((p) => p.labelKey.key === "pad.generic.panel.settle")).toBe(true);
  });

  // tennis's award-game panel: a REAL "and"/"not" composite gate — proves
  // buildPadView does not special-case simple gates and skip composites.
  it("and/not composite: tennis's award-game panel is visible before any tie-break", () => {
    const tennisCfg = tennis.configSchema.parse({});
    const spec2 = tennis.padSpec!(tennisCfg);
    const catalog = resolvePositions(tennis, tennisCfg);
    const lineups2 = defaultLineupPair(catalog);
    const state = tennis.init(tennisCfg, lineups2);
    const view = buildPadView(spec2, {
      state,
      summary: tennis.summary(state),
      phase: "live",
      band: 3,
    });
    expect(view.panels.some((p) => p.labelKey.key === "pad.tennis.panel.gameAward")).toBe(true);
  });

  it("and/not composite: hidden once real folded state reaches a tie-break (6-6 under tiebreakAt:6)", () => {
    const tennisCfg = tennis.configSchema.parse({});
    const spec2 = tennis.padSpec!(tennisCfg);
    const catalog = resolvePositions(tennis, tennisCfg);
    const lineups2 = defaultLineupPair(catalog);
    const H = lineups2.home.entrantId;
    const A = lineups2.away.entrantId;
    const events = [makeEnvelope(0, { type: "core.start", payload: {} })];
    let seq = 1;
    for (let g = 0; g < 12; g++) {
      const side = g % 2 === 0 ? H : A;
      for (let p = 0; p < 4; p++) events.push(makeEnvelope(seq++, { type: "tennis.point", payload: { by: side } }));
    }
    const state = foldMatch(tennis, tennisCfg, lineups2, events, { strictFromSeq: 0 });
    expect((state as { points: { kind: string } }).points.kind).toBe("tiebreak");
    const view = buildPadView(spec2, {
      state,
      summary: tennis.summary(state),
      phase: "live",
      band: 3,
    });
    expect(view.panels.some((p) => p.labelKey.key === "pad.tennis.panel.gameAward")).toBe(false);
  });
});

describe("buildPadView — fidelity band filtering (W1: a band is a UX filter, never a price)", () => {
  const lineups = defaultLineupPair(resolvePositions(cricket, cricket.configSchema.parse({})));

  function viewAt(band: 0 | 1 | 2 | 3) {
    const cfg = cricket.configSchema.parse({});
    const spec = cricket.padSpec!(cfg);
    const state = cricket.init(cfg, lineups);
    return buildPadView(spec, { state, summary: cricket.summary(state), phase: "live", band });
  }

  function actionTypes(view: ReturnType<typeof viewAt>): string[] {
    return view.panels.flatMap((p) => p.actions.map((a) => a.type));
  }

  it("an action banded above the chosen band is ABSENT, not merely disabled", () => {
    const view = viewAt(1);
    // cricket.ball is band 3 — must not appear at all at band 1.
    expect(actionTypes(view)).not.toContain("cricket.ball");
    // ...and a band-1 live action IS present, or "absent" would be satisfied
    // by a view that resolved nothing at all.
    expect(actionTypes(view)).toContain("cricket.powerplay");
  });

  it("raising the band to the top brings that same action back — nothing else changed", () => {
    expect(actionTypes(viewAt(3))).toContain("cricket.ball");
  });

  // W1 / Task 4 replaced three cases here that asserted an in-band action
  // could still be LOCKED for want of an entitlement, with a worded reason
  // (`scorepad.locked.reason`). Tasks 1-3 deleted that model from the engine
  // and this task deleted `ActionAvailability` with it: within the band an
  // action is resolved, above it there is nothing. There is no third state
  // left to assert, so the assertions are gone rather than weakened into
  // always-true ones.
  it("every action within the chosen band resolves — there is no paid tier left to withhold one", () => {
    // `allActionViews` is phase-independent by design, which is what makes it
    // the right tool here: this says nothing about phase, only that band 3
    // holds nothing back.
    const cfg = cricket.configSchema.parse({});
    const spec = cricket.padSpec!(cfg);
    const actions = allActionViews(spec, { band: 3 });
    const declared = spec.panels.flatMap((panel) => panel.actions.map((a) => a.type));
    expect(new Set(actions.map((a) => a.type))).toEqual(new Set(declared));
  });
});

describe("checkActionValidity — required fields", () => {
  it("ok when every declared field has a value", () => {
    const action = { fields: [{ kind: "number" as const, path: "over", min: 0, max: 10 }], attribution: [] };
    expect(checkActionValidity(action, { over: 3 })).toEqual({ ok: true });
  });

  it("not ok, with a renderable reason, when a declared field is unset", () => {
    const action = { fields: [{ kind: "number" as const, path: "over", min: 0, max: 10 }], attribution: [] };
    const result = checkActionValidity(action, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing.map((f) => f.path)).toEqual(["over"]);
      expect(typeof result.reason.key).toBe("string");
      expect(result.reason.label.length).toBeGreaterThan(0);
    }
  });

  it("an action with zero declared fields is always valid", () => {
    expect(checkActionValidity({ fields: [], attribution: [] }, {})).toEqual({ ok: true });
  });

  it("a toggle field counts as set even when its value is `false` (must check `undefined`, not falsy)", () => {
    const action = { fields: [{ kind: "toggle" as const, path: "freeHit" }], attribution: [] };
    expect(checkActionValidity(action, { freeHit: false })).toEqual({ ok: true });
  });

  // R8 branch review, finding 5 — `attribution` was OPTIONAL on this
  // parameter (`Partial<Pick<PadAction, "attribution">>`), so a caller
  // passing `{ fields }` alone silently disabled the whole attribution gate
  // with no type error: the exact inert-seam shape this wave exists to
  // close, sitting on the guard that closes it. Now required.
  //
  // A COMPILE-TIME guard, deliberately: vitest never typechecks (the runtime
  // call below still works fine), so nothing at runtime can witness this.
  // `@ts-expect-error` is what makes it enforceable — if the parameter is
  // ever loosened back, this directive stops matching an error and tsc fails
  // the file with TS2578 "Unused '@ts-expect-error' directive". Same
  // mechanic, and same reasoning, as v3/__tests__/types.test.ts's own proofs.
  it("a fields-only caller no longer type-checks — the gate cannot be dropped by omission", () => {
    // @ts-expect-error — `attribution` is required; omitting it must not compile.
    const disabled = checkActionValidity({ fields: [] }, {});
    // Runtime is deliberately unchanged (view-model.ts keeps a `?? []` so a
    // cast cannot crash the live Confirm path). The TYPE is the fix: the seam
    // was that this call compiled, not that it returned something odd.
    expect(disabled).toEqual({ ok: true });
  });
});

// R8/WS-B2 — `PadAttributionItem.required` now exists (engine, d4c8ddbfb),
// so `checkActionValidity` must gate on it too, closing the dead-end tap: a
// scorer could confirm cricket.toss with `wonBy` unset and the engine's own
// z.strictObject silently rejected the payload. Derives "which item is
// required" from the REAL padSpec output for a real action (cricket.toss),
// never a hand-typed required list (memory rule #19) — a change to the
// engine's own schema-derived stamp moves this test with it.
describe("checkActionValidity — required attribution (R8/WS-B2)", () => {
  const cricketCfg = cricket.configSchema.parse({});
  const cricketSpec = cricket.padSpec!(cricketCfg);
  const tossAction = allActionViews(cricketSpec, { band: 3, entitlements: {} }).find(
    (a) => a.type === "cricket.toss",
  )!;
  const wonByItem = tossAction.attribution.find((item) => item.path === "wonBy")!;

  it("the fixture actually proves the engine stamped wonBy as required (else this suite proves nothing)", () => {
    expect(wonByItem.required).toBe(true);
  });

  it("not ok when a required attribution item is unfilled, even with every declared FIELD filled", () => {
    // cricket.toss also declares a `fields` entry (`elected`) — fill it, so
    // this isolates the attribution gate rather than re-proving the
    // pre-existing fields check above.
    const result = checkActionValidity(tossAction, { elected: "bat" });
    expect(result.ok).toBe(false);
  });

  it("ok once the required attribution item AND every declared field are filled", () => {
    expect(checkActionValidity(tossAction, { elected: "bat", wonBy: "home-1" })).toEqual({ ok: true });
  });

  it("an OPTIONAL attribution item left unfilled does not block validity", () => {
    const reviewAction = allActionViews(cricketSpec, { band: 3, entitlements: {} }).find(
      (a) => a.type === "cricket.review",
    )!;
    // cricket.review's two fields (kind/outcome) plus its required `by` item
    // filled; its OPTIONAL person/against items left unfilled.
    const personItem = reviewAction.attribution.find((item) => item.path === "person")!;
    expect(personItem.required).toBeFalsy(); // fixture proof: person really is optional
    const values = Object.fromEntries([
      ...reviewAction.fields.map((f) => [f.path, f.kind === "toggle" ? false : "x"]),
      ["by", "home-1"],
    ]);
    expect(checkActionValidity(reviewAction, values).ok).toBe(true);
  });
});

describe("deriveFieldPathLabel — the renderer's own fallback caption for a labelKey-less field (S10 fix 1)", () => {
  it.each([
    ["wickets", "Wickets"],
    ["runs.bat", "Runs bat"],
    ["extras.kind", "Extras kind"],
    ["bowling.legalBalls", "Bowling legal balls"],
    ["batting.out", "Batting out"],
    ["ownGoal", "Own goal"],
  ])("derives %j as %j", (path, expected) => {
    expect(deriveFieldPathLabel(path)).toBe(expected);
  });

  it("never prints the raw dotted path verbatim for a multi-segment field", () => {
    // The exact defect this replaces: printing `path` at a scorer instead of
    // a human-readable word.
    expect(deriveFieldPathLabel("bowling.legalBalls")).not.toBe("bowling.legalBalls");
    expect(deriveFieldPathLabel("bowling.legalBalls")).not.toContain(".");
  });
});

describe("summaryHeadline — the fold's own ScoreSummary.headline, read defensively (S10 fix 3)", () => {
  it("reads a real ScoreSummary-shaped object's headline", () => {
    expect(summaryHeadline({ headline: "252/8 (50) — 253/4 (48.2)", perSide: [] })).toBe(
      "252/8 (50) — 253/4 (48.2)",
    );
  });

  it.each([
    ["an undefined summary (pre-fold caller)", undefined],
    ["a null summary", null],
    ["a non-object summary", "not an object"],
    ["an object with no headline field", {}],
    ["a headline that isn't a string", { headline: 42 }],
    ["an explicitly empty headline", { headline: "" }],
  ])("degrades to null for %s — never a crash, never the literal 'undefined'", (_label, input) => {
    expect(summaryHeadline(input)).toBeNull();
  });
});

describe("buildActionPayload — thin wrapper over buildPathObject, fields + attribution together", () => {
  it("nests dotted paths from both fields and attribution, omitting unset values", () => {
    const action = {
      fields: [
        { kind: "number" as const, path: "over", min: 0, max: 10 },
        { kind: "number" as const, path: "runs.bat", min: 0, max: 6 },
      ],
      attribution: [{ kind: "person" as const, path: "striker" }, { kind: "person" as const, path: "wicket.fielder" }],
    };
    const payload = buildActionPayload(action, { over: 2, "runs.bat": 4, striker: "p1" });
    expect(payload).toEqual({ over: 2, runs: { bat: 4 }, striker: "p1" });
    // wicket.fielder was never supplied — genuinely absent, not `undefined`.
    expect(Object.prototype.hasOwnProperty.call(payload, "wicket")).toBe(false);
  });
});
