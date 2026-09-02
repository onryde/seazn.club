// S6/#416 (W5) — padSpec conformance for the nested kernel (tennis is its
// sole preset today). Wired like cricket (sports/cricket/cricket.test.ts):
// `padSpecConformanceSuite` per variant, PLUS a module-level
// `checkActionCoverage` — see the "action coverage" describe near the bottom
// of this file, which also records why this file's original "deliberately
// NOT called" note was wrong.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch } from "../../core/events.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { evalPadGate, type PadAction, type PadField, type PadSpec } from "../../sport/module.ts";
import { checkActionCoverage, padSpecConformanceSuite } from "../../testkit/conformance-pad.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { tennis } from "../tennis/tennis.ts";
import type { NestedCfg } from "./kernel.ts";

// Perturbs the numeric knobs padSpec's own bounds read (`gamesFieldBound`,
// `tbFieldBound`). Combinations `configSchema` rejects (even `bestOf`,
// `tiebreakAt > gamesTo`) are silently skipped by
// `checkTotalDeterministicAndPureData` — not padSpec's problem.
const nestedCfgPerturbations = fc.record(
  {
    bestOf: fc.integer({ min: 1, max: 7 }).map((n) => (n % 2 === 0 ? n + 1 : n)),
    set: fc.record({
      gamesTo: fc.integer({ min: 3, max: 8 }),
      winBy: fc.constant(2),
      tiebreakAt: fc.option(fc.integer({ min: 3, max: 8 }), { nil: null }),
      tiebreakTo: fc.integer({ min: 5, max: 12 }),
    }),
  },
  { requiredKeys: [] },
);

padSpecConformanceSuite(tennis, {
  cfg: {},
  label: "tour",
  numRuns: 150,
  cfgPerturbations: nestedCfgPerturbations,
});
padSpecConformanceSuite(tennis, {
  cfg: tennis.variants["grand-slam"],
  label: "grand-slam",
  numRuns: 100,
});
padSpecConformanceSuite(tennis, {
  cfg: tennis.variants.fast4,
  label: "fast4",
  numRuns: 100,
});
padSpecConformanceSuite(tennis, {
  cfg: tennis.variants["doubles-noad-mtb10"],
  label: "doubles-noad-mtb10",
  numRuns: 100,
});

// ---------------------------------------------------------------------------
// No cfg-mutual-exclusivity: unlike volleyball's beach/indoor split, NOTHING
// on this kernel gates an event TYPE by preset or by variant — every
// `apply()` case dispatches unconditionally (see the module-level note in
// nested/kernel.ts above `nestedPadSpec`). A UNION across variants therefore
// adds nothing a single cfg's own action set does not already reach; this
// test checks that claim directly rather than leaving it as an unverified
// comment.
//
// CFG VARIANCE IS ALL IT SHOWS. This file originally drew a second
// conclusion from it — that `checkActionCoverage` "has nothing to prove" and
// could be skipped for tennis — and that inference is wrong; see the action
// coverage describe below, which now calls it.
// ---------------------------------------------------------------------------

describe("tennis padSpec — no cfg-mutual-exclusivity (asserted, not merely claimed)", () => {
  it("every named variant produces the identical action-type set", () => {
    const variantNames = Object.keys(tennis.variants);
    const typeSets = variantNames.map(
      (name) =>
        new Set(
          tennis
            .padSpec!(tennis.configSchema.parse(tennis.variants[name]))
            .panels.flatMap((panel) => panel.actions.map((action) => action.type)),
        ),
    );
    const [first, ...rest] = typeSets;
    for (const set of rest) expect([...set].sort()).toEqual([...first!].sort());
    // And every one of tennis's 5 registered types is in that set.
    expect([...first!].sort()).toEqual(
      [
        "tennis.game.award",
        "tennis.interruption",
        "tennis.point",
        "tennis.sanction",
        "tennis.set_summary",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// (a), the module-level half — R8 BRANCH REVIEW. Tennis was the ONLY sport
// spec test in the repo with no `checkActionCoverage` call (boardgame,
// carrom, cricket, football, generic, hockey, icehockey, volleyball,
// badminton and tabletennis all have one). The note that justified the
// omission argued from CFG VARIANCE — true, and re-proven directly by the
// describe above — but coverage's other half is TYPE REGISTRATION, which cfg
// invariance says nothing about, and which every arm of R8's `required`
// machinery silently no-ops on:
//
//   - `stampAttributionRequired` returns an action whose `type` is not a key
//     in `eventSchemas` UNTOUCHED (sport/module.ts) — by design, since
//     flagging it is exactly this check's job;
//   - conformance checks (b), (f) and (g) each `continue` past it
//     (testkit/conformance-pad.ts).
//
// So a tennis action whose type drifted out of the registry would ship
// `required: undefined` on every attribution item, which the pad's
// `checkActionValidity` (apps/web view-model.ts) reads as NOT required —
// reopening, for tennis alone, the dead-end tap R8 exists to close.
//
// Not merely theoretical: the describe above DOES red on a bare drift, but
// only via its hand-typed type list, and "fix" that literal to match the
// drift (the obvious repair, and precisely the rule-#19 failure mode) and the
// whole engine suite returns to a clean 4278/4265/0 with `required` unstamped.
// Verified by mutation before this block was written. `checkActionCoverage`
// derives the expectation from `tennis.eventSchemas` itself, so it cannot be
// silenced that way, and it also catches the reverse drift the literal list
// cannot see at all: a 6th type registered with no action to reach it.
// ---------------------------------------------------------------------------

describe("tennis padSpec — action coverage against the type registry (R8 branch review)", () => {
  const variantSpecs = Object.keys(tennis.variants).map((name) =>
    tennis.padSpec!(tennis.configSchema.parse(tennis.variants[name])),
  );

  it("every registered event type is reachable from some action, and no action names an unregistered type", () => {
    expect(checkActionCoverage(variantSpecs, tennis.eventSchemas!)).toEqual([]);
  });

  it("MUTATION SHAPE — an action whose type drifts OUT of eventSchemas is flagged (the drift that un-stamps `required`)", () => {
    const problems = checkActionCoverage(driftFirstActionType(variantSpecs[0]!), tennis.eventSchemas!);
    expect(problems.join(" ")).toMatch(/tennis\.point_DRIFTED/);
  });

  it("MUTATION SHAPE — a registered type no action reaches is flagged too (the direction the hand-typed list above cannot see)", () => {
    const problems = checkActionCoverage(variantSpecs, {
      ...tennis.eventSchemas!,
      "tennis.unreached": tennis.eventSchemas!["tennis.point"]!,
    });
    expect(problems.join(" ")).toMatch(/tennis\.unreached/);
  });
});

/** Returns a copy of `spec` with its FIRST action's `type` drifted, standing in
 *  for a real edit to `nestedPadSpec` — the mutation the coverage check exists
 *  to catch, without a test that has to edit production source to run. */
function driftFirstActionType(spec: PadSpec): PadSpec {
  let drifted = false;
  const mutate = (action: PadAction): PadAction => {
    if (drifted) return action;
    drifted = true;
    return { ...action, type: "tennis.point_DRIFTED" };
  };
  return { ...spec, panels: spec.panels.map((panel) => ({ ...panel, actions: panel.actions.map(mutate) })) };
}

// ---------------------------------------------------------------------------
// Variant reshaping proof.
// ---------------------------------------------------------------------------

function findField(spec: PadSpec, type: string, path: string): PadField | undefined {
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      if (action.type !== type) continue;
      const field = action.fields.find((f) => f.path === path);
      if (field) return field;
    }
  }
  return undefined;
}

describe("tennis padSpec — variant reshaping: fast4's lower gamesTo tightens the set-score bound vs tour", () => {
  it("fast4 (gamesTo: 4) has a smaller bound than tour (gamesTo: 6)", () => {
    const tourSpec = tennis.padSpec!(tennis.configSchema.parse({}));
    const fast4Spec = tennis.padSpec!(tennis.configSchema.parse(tennis.variants.fast4));
    const tourField = findField(tourSpec, "tennis.set_summary", "home");
    const fast4Field = findField(fast4Spec, "tennis.set_summary", "home");
    expect(tourField?.kind).toBe("number");
    expect(fast4Field?.kind).toBe("number");
    if (tourField?.kind === "number" && fast4Field?.kind === "number") {
      expect(fast4Field.max).toBeLessThan(tourField.max);
    }
  });
});

describe("tennis padSpec — variant reshaping: doubles-noad-mtb10's larger MTB target widens the bound past tour's", () => {
  it("doubles-noad-mtb10 (MTB to 10) bounds home/away above tour's plain games ceiling", () => {
    const tourSpec = tennis.padSpec!(tennis.configSchema.parse({}));
    const mtbSpec = tennis.padSpec!(tennis.configSchema.parse(tennis.variants["doubles-noad-mtb10"]));
    const tourField = findField(tourSpec, "tennis.set_summary", "home");
    const mtbField = findField(mtbSpec, "tennis.set_summary", "home");
    expect(tourField?.kind).toBe("number");
    expect(mtbField?.kind).toBe("number");
    // tour: gamesTo 6 + winBy 2 + 2 = 10. doubles-noad-mtb10: MTB target
    // 10 + 2 = 12, which is what padSpec's own bound-widening exists for.
    if (tourField?.kind === "number" && mtbField?.kind === "number") {
      expect(mtbField.max).toBeGreaterThan(tourField.max);
    }
  });
});

describe("tennis padSpec — grand-slam honours its own deciding-set tie-break target (10), not tour's 7", () => {
  it("the tb field's bound widens to cover the slam decider", () => {
    const tourSpec = tennis.padSpec!(tennis.configSchema.parse({}));
    const slamSpec = tennis.padSpec!(tennis.configSchema.parse(tennis.variants["grand-slam"]));
    const tourTb = findField(tourSpec, "tennis.set_summary", "tb.home");
    const slamTb = findField(slamSpec, "tennis.set_summary", "tb.home");
    expect(tourTb?.kind).toBe("number");
    expect(slamTb?.kind).toBe("number");
    if (tourTb?.kind === "number" && slamTb?.kind === "number") {
      expect(slamTb.max).toBeGreaterThan(tourTb.max); // 7+2+2=11 vs 10+2+2=14
    }
  });
});

// ---------------------------------------------------------------------------
// tennis.game.award coverage — the S5 addition this session must expose.
// ---------------------------------------------------------------------------

describe("tennis padSpec covers tennis.game.award", () => {
  it("has an action for it, attributed by side (winner), in every variant", () => {
    for (const name of ["tour", ...Object.keys(tennis.variants)]) {
      const cfg =
        name === "tour" ? tennis.configSchema.parse({}) : tennis.configSchema.parse(tennis.variants[name]);
      const spec = tennis.padSpec!(cfg);
      const action = spec.panels
        .flatMap((p) => p.actions)
        .find((a) => a.type === "tennis.game.award");
      expect(action, name).toBeDefined();
      // R8/WS-B — `winner` is `EntrantId` (non-optional) on `NestedGameAward`,
      // so `stampAttributionRequired` (module.ts) derives `required: true`.
      expect(action?.attribution).toEqual([{ kind: "side", path: "winner", required: true }]);
    }
  });

  it("is banded at 3 (score-moving, maximum granularity — a game award is one level up from a point)", () => {
    const spec = tennis.padSpec!(tennis.configSchema.parse({}));
    expect(spec.fidelity["tennis.game.award"]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Gate integration — the award-game panel's runtime gate against real state
// (mirrors cricket's super-over integration test): reachable, not merely
// configured.
// ---------------------------------------------------------------------------

describe("tennis padSpec — award-game panel: hidden mid-tie-break, against REAL folded state", () => {
  const cfg: NestedCfg = tennis.configSchema.parse({});
  const spec = tennis.padSpec!(cfg);
  const panel = spec.panels.find((p) => p.labelKey.key === "pad.tennis.panel.gameAward");
  const lineups = defaultLineupPair(resolvePositions(tennis, cfg));

  it("is true before any tie-break (ordinary standard-play state)", () => {
    expect(panel?.gate).toBeDefined();
    const preState = tennis.init(cfg, lineups);
    expect(evalPadGate(panel!.gate!, { state: preState, summary: tennis.summary(preState) })).toBe(true);
  });

  it("is false once the score reaches a tie-break (6-6 under tour's tiebreakAt: 6)", () => {
    const H = lineups.home.entrantId;
    const A = lineups.away.entrantId;
    const events = [makeEnvelope(0, { type: "core.start", payload: {} })];
    // 12 alternating single games (H,A,H,A,...) reaches 6-6 without ever
    // crossing a hi>=gamesTo && hi-lo>=winBy bank threshold.
    let seq = 1;
    for (let g = 0; g < 12; g++) {
      const side = g % 2 === 0 ? H : A;
      for (let p = 0; p < 4; p++) events.push(makeEnvelope(seq++, { type: "tennis.point", payload: { by: side } }));
    }
    const tiebreakState = foldMatch(tennis, cfg, lineups, events, { strictFromSeq: 0 });
    expect(tiebreakState.points.kind).toBe("tiebreak");
    expect(
      evalPadGate(panel!.gate!, { state: tiebreakState, summary: tennis.summary(tiebreakState) }),
    ).toBe(false);
  });
});
