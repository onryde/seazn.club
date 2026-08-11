// S6/#416 (W5) — padSpec conformance for the racquet + setbased family
// (volleyball, badminton, table tennis). Wired exactly like cricket
// (sports/cricket/cricket.test.ts): `padSpecConformanceSuite` per module ×
// variant, plus the module-level `checkActionCoverage` call ONLY where a
// cfg-mutual-exclusivity genuinely exists.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch } from "../../core/events.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { evalPadGate, type PadField, type PadSpec } from "../../sport/module.ts";
import {
  checkActionCoverage,
  padSpecConformanceSuite,
} from "../../testkit/conformance-pad.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import {
  SetBasedRally,
  SetBasedSanction,
  SetBasedSub,
  SetBasedSummary,
  SetBasedTimeout,
  type SetBasedCfg,
} from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

// Reasonable perturbations of the numeric knobs padSpec's own bounds read
// (`summaryScoreBound`). Combinations `configSchema` itself rejects (odd
// `bestOf`, `cap < target`) are silently skipped by
// `checkTotalDeterministicAndPureData` — not padSpec's problem, per its own
// doc comment.
const setBasedCfgPerturbations = fc.record(
  {
    bestOf: fc.integer({ min: 1, max: 9 }).map((n) => (n % 2 === 0 ? n + 1 : n)),
    setTo: fc.integer({ min: 5, max: 30 }),
    finalSetTo: fc.integer({ min: 5, max: 30 }),
    cap: fc.option(fc.integer({ min: 30, max: 50 }), { nil: null }),
  },
  { requiredKeys: [] },
);

padSpecConformanceSuite(volleyball, {
  cfg: {},
  label: "indoor",
  numRuns: 150,
  cfgPerturbations: setBasedCfgPerturbations,
});
padSpecConformanceSuite(volleyball, {
  cfg: volleyball.variants.beach,
  label: "beach",
  numRuns: 150,
});

padSpecConformanceSuite(badminton, {
  cfg: {},
  label: "bwf",
  numRuns: 150,
  cfgPerturbations: setBasedCfgPerturbations,
});
padSpecConformanceSuite(badminton, {
  cfg: badminton.variants.short,
  label: "short",
  numRuns: 100,
});

padSpecConformanceSuite(tabletennis, {
  cfg: {},
  label: "bo5",
  numRuns: 150,
  cfgPerturbations: setBasedCfgPerturbations,
});
padSpecConformanceSuite(tabletennis, {
  cfg: tabletennis.variants["hardbat-21"],
  label: "hardbat-21",
  numRuns: 100,
});

// ---------------------------------------------------------------------------
// checkActionCoverage — MODULE-LEVEL, called only where a real
// cfg-mutual-exclusivity exists (conformance-pad.ts's own doc comment: the
// cricket superOver-vs-2-innings shape). Volleyball's `indoor` vs `beach` is
// exactly that shape for `volleyball.sub` — indoor records substitutions,
// beach never does, and NO volleyball cfg reaches both.
//
// The registry passed here is DELIBERATELY NOT `volleyball.eventSchemas`
// (the full 6-branch kernel-union registry `padSpecConformanceSuite`'s
// bijection check (a) needs — see the module-level note in kernel.ts above
// `setBasedPadSpec`). `volleyball.expedite.start` is registered there for
// bijection but is UNREACHABLE from every volleyball cfg, indoor or beach —
// table tennis's alone — so including it here would report a permanent,
// non-cfg-dependent absence as if it were the same kind of gap as the real
// substitution question. This dict is exactly "the types volleyball can ever
// legally record", i.e. `eventSchemas` minus the kernel-union branch it can
// never reach — the RIGHT set for what this check is asking.
// ---------------------------------------------------------------------------

const VOLLEYBALL_RECORDABLE_SCHEMAS = {
  "volleyball.rally": SetBasedRally,
  "volleyball.set.summary": SetBasedSummary,
  "volleyball.timeout": SetBasedTimeout,
  "volleyball.sanction": SetBasedSanction,
  "volleyball.sub": SetBasedSub,
};

describe("volleyball padSpec — action coverage across indoor vs beach (the real cfg-mutual-exclusivity case)", () => {
  it("every type volleyball can ever record is reachable from some action, unioning indoor + beach", () => {
    const specs = [
      volleyball.padSpec!(volleyball.configSchema.parse({})),
      volleyball.padSpec!(volleyball.configSchema.parse(volleyball.variants.beach)),
    ];
    expect(checkActionCoverage(specs, VOLLEYBALL_RECORDABLE_SCHEMAS)).toEqual([]);
  });

  it("MUTATION SHAPE — coverage fails if beach is dropped from the union (indoor alone still reaches everything, since beach adds nothing indoor lacks — dropping INDOOR is the real mutation shape)", () => {
    // Beach is the SUBSET (no substitutions) — dropping it from the union
    // loses nothing indoor didn't already cover. Dropping INDOOR is what
    // actually loses coverage of `volleyball.sub`, which is the shape this
    // check exists to catch (mirrors cricket's own mutation-shape test,
    // which drops the variant that UNIQUELY covers a branch).
    const specsWithoutIndoor = [
      volleyball.padSpec!(volleyball.configSchema.parse(volleyball.variants.beach)),
    ];
    const problems = checkActionCoverage(specsWithoutIndoor, VOLLEYBALL_RECORDABLE_SCHEMAS);
    expect(problems.join(" ")).toMatch(/volleyball\.sub/);
  });
});

// badminton and table tennis: `records` never varies across their named
// variants (`bwf`/`short`; `bo5`/`bo7`/`hardbat-21` — see records.test.ts),
// so a single cfg's action set already reaches every type each sport can
// ever record. No cfg-mutual-exclusivity exists for either, so
// `checkActionCoverage` is deliberately NOT called for them — asserted
// directly instead, so the "nothing to check" claim is itself checked.
describe("badminton / table tennis padSpec — no cfg-mutual-exclusivity (asserted, not merely claimed)", () => {
  it("every badminton variant produces the identical action-type set", () => {
    const variantNames = Object.keys(badminton.variants);
    const typeSets = variantNames.map(
      (name) =>
        new Set(
          badminton
            .padSpec!(badminton.configSchema.parse(badminton.variants[name]))
            .panels.flatMap((panel) => panel.actions.map((action) => action.type)),
        ),
    );
    const [first, ...rest] = typeSets;
    for (const set of rest) expect([...set].sort()).toEqual([...first!].sort());
  });

  it("every table tennis variant produces the identical action-type set", () => {
    const variantNames = Object.keys(tabletennis.variants);
    const typeSets = variantNames.map(
      (name) =>
        new Set(
          tabletennis
            .padSpec!(tabletennis.configSchema.parse(tabletennis.variants[name]))
            .panels.flatMap((panel) => panel.actions.map((action) => action.type)),
        ),
    );
    const [first, ...rest] = typeSets;
    for (const set of rest) expect([...set].sort()).toEqual([...first!].sort());
  });
});

// ---------------------------------------------------------------------------
// Variant reshaping proof.
// ---------------------------------------------------------------------------

function actionTypesOf(spec: PadSpec): Set<string> {
  return new Set(spec.panels.flatMap((panel) => panel.actions.map((action) => action.type)));
}

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

describe("volleyball padSpec — variant reshaping: beach demonstrably differs from indoor (post-fix)", () => {
  const indoorSpec = volleyball.padSpec!(volleyball.configSchema.parse({}));
  const beachSpec = volleyball.padSpec!(volleyball.configSchema.parse(volleyball.variants.beach));

  it("indoor has a substitution action; beach has none", () => {
    expect(actionTypesOf(indoorSpec).has("volleyball.sub")).toBe(true);
    expect(actionTypesOf(beachSpec).has("volleyball.sub")).toBe(false);
  });

  it("indoor has a Substitutions panel; beach has none", () => {
    expect(indoorSpec.panels.some((p) => p.labelKey.key === "pad.volleyball.panel.subs")).toBe(true);
    expect(beachSpec.panels.some((p) => p.labelKey.key === "pad.volleyball.panel.subs")).toBe(false);
  });

  it("bounds are cfg-derived: beach's lower setTo/finalSetTo tightens the set-score field's max", () => {
    const indoorMax = findField(indoorSpec, "volleyball.set.summary", "home");
    const beachMax = findField(beachSpec, "volleyball.set.summary", "home");
    expect(indoorMax?.kind).toBe("number");
    expect(beachMax?.kind).toBe("number");
    if (indoorMax?.kind === "number" && beachMax?.kind === "number") {
      expect(beachMax.max).toBeLessThan(indoorMax.max); // 21+20 vs 25+20
    }
  });
});

describe("badminton padSpec — variant reshaping: short honours its own lower cap, not bwf's 30", () => {
  it("the set-score bound tracks cfg.cap directly", () => {
    const bwfSpec = badminton.padSpec!(badminton.configSchema.parse({}));
    const shortSpec = badminton.padSpec!(badminton.configSchema.parse(badminton.variants.short));
    const bwfField = findField(bwfSpec, "badminton.game.summary", "home");
    const shortField = findField(shortSpec, "badminton.game.summary", "home");
    expect(bwfField?.kind).toBe("number");
    expect(shortField?.kind).toBe("number");
    if (bwfField?.kind === "number" && shortField?.kind === "number") {
      expect(bwfField.max).toBe(30); // cfg.cap
      expect(shortField.max).toBe(15); // cfg.cap
    }
  });
});

describe("table tennis padSpec — variant reshaping: hardbat-21 honours its own setTo, not the ITTF 11", () => {
  it("bo5's set-score bound is smaller than hardbat-21's (no cap on either, uses setTo+finalSetTo+20)", () => {
    const bo5Spec = tabletennis.padSpec!(tabletennis.configSchema.parse({}));
    const hardbatSpec = tabletennis.padSpec!(
      tabletennis.configSchema.parse(tabletennis.variants["hardbat-21"]),
    );
    const bo5Field = findField(bo5Spec, "tabletennis.game.summary", "home");
    const hardbatField = findField(hardbatSpec, "tabletennis.game.summary", "home");
    expect(bo5Field?.kind).toBe("number");
    expect(hardbatField?.kind).toBe("number");
    if (bo5Field?.kind === "number" && hardbatField?.kind === "number") {
      expect(hardbatField.max).toBeGreaterThan(bo5Field.max); // 21+20 vs 11+20
    }
  });

  it("only table tennis declares an expedite panel — volleyball and badminton never do, for any cfg", () => {
    const ttSpec = tabletennis.padSpec!(tabletennis.configSchema.parse({}));
    const vbSpec = volleyball.padSpec!(volleyball.configSchema.parse({}));
    const bmSpec = badminton.padSpec!(badminton.configSchema.parse({}));
    expect(ttSpec.panels.some((p) => p.labelKey.key === "pad.tabletennis.panel.expedite")).toBe(true);
    expect(vbSpec.panels.some((p) => p.labelKey.key.includes("expedite"))).toBe(false);
    expect(bmSpec.panels.some((p) => p.labelKey.key.includes("expedite"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate integration — the expedite scoring panel's runtime gate against real
// state (mirrors cricket's super-over integration test).
// ---------------------------------------------------------------------------

describe("table tennis padSpec — expedite scoring panel: cfg gates existence, a runtime gate governs reachability", () => {
  const cfg: SetBasedCfg = tabletennis.configSchema.parse({});
  const spec = tabletennis.padSpec!(cfg);
  const panel = spec.panels.find((p) => p.labelKey.key === "pad.tabletennis.panel.expediteRally");
  const lineups = defaultLineupPair(resolvePositions(tabletennis, cfg));

  it("declares the runtime gate against the real state.expedite path", () => {
    expect(panel?.gate).toEqual({ op: "path-truthy", path: "state.expedite" });
  });

  it("is false before expedite is declared, true once it is — against REAL folded state", () => {
    expect(panel?.gate).toBeDefined();
    const gate = panel!.gate!;
    const preState = tabletennis.init(cfg, lineups);
    expect(evalPadGate(gate, { state: preState, summary: tabletennis.summary(preState) })).toBe(false);

    const events = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "tabletennis.expedite.start", payload: {} }),
    ];
    const liveState = foldMatch(tabletennis, cfg, lineups, events, { strictFromSeq: 0 });
    expect(evalPadGate(gate, { state: liveState, summary: tabletennis.summary(liveState) })).toBe(true);
  });
});
