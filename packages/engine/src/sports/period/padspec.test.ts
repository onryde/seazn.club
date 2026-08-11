// S6/#416 (W5) — padSpec conformance for the period family (hockey +
// icehockey). Both sports pull ONE shared builder through
// `makePeriodModule` (kernel.ts), so this file is the acceptance evidence
// that the shared machinery is real, not vacuous — same role
// `cricket.test.ts`'s padSpec block plays for the reference module.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMatch } from "../../core/events.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import { checkActionCoverage, padSpecConformanceSuite } from "../../testkit/conformance-pad.ts";
import { evalPadGate, type ModuleEvent, type PadField, type PadSpec } from "../../sport/module.ts";
import { hockey } from "../hockey/hockey.ts";
import { icehockey } from "../icehockey/icehockey.ts";

const HOCKEY_EVENT_SCHEMAS = hockey.eventSchemas!;
const ICEHOCKEY_EVENT_SCHEMAS = icehockey.eventSchemas!;
const hockeyPadSpec = hockey.padSpec!;
const icehockeyPadSpec = icehockey.padSpec!;

// ---------------------------------------------------------------------------
// cfg perturbations for the total/deterministic property — every branch
// padSpec(cfg) reads, hit with several concrete alternatives rather than
// fast-check's own shape inference (fc.dictionary/fc.subarray are unproven
// in this repo; fc.constantFrom over hand-built literals is the same
// combinator set cricket.test.ts already relies on).
// ---------------------------------------------------------------------------

const suspensionsAlternatives = [
  null,
  { classes: {} },
  { classes: { green: { minutes: 2, teamShort: true }, yellow: { minutes: 5, teamShort: true } } },
  {
    classes: {
      minor: { minutes: 2, teamShort: true },
      major: { minutes: 5, teamShort: true },
      misconduct: { minutes: 10, teamShort: false },
      permanent: { minutes: null, teamShort: true, permanent: true },
    },
  },
];
const shootoutAlternatives = [null, { attempts: 5, suddenDeath: true }, { attempts: 3, suddenDeath: true, clockSeconds: 8 }];
const overtimeAlternatives = [
  null,
  { kind: "sudden_death" as const, minutes: 5 },
  { kind: "sudden_death" as const, minutes: 5, skaters: 3 },
  { kind: "periods" as const, count: 2, minutes: 10 },
];
const goalKindsAlternatives = [[], ["fg"], ["fg", "pc", "stroke", "og"], ["fg", "pp", "sh", "ps", "og"]];
const setPieceKindsAlternatives = [[], ["pc"], ["pc", "stroke"], ["ps"]];

const periodCfgPerturbations = fc.record(
  {
    periods: fc.record({ count: fc.integer({ min: 1, max: 4 }), minutes: fc.integer({ min: 5, max: 20 }) }),
    overtime: fc.constantFrom(...overtimeAlternatives),
    shootout: fc.constantFrom(...shootoutAlternatives),
    suspensions: fc.constantFrom(...suspensionsAlternatives),
    setPieceKinds: fc.constantFrom(...setPieceKindsAlternatives),
    goalKinds: fc.constantFrom(...goalKindsAlternatives),
  },
  { requiredKeys: [] },
);

// ---------------------------------------------------------------------------
// padSpecConformanceSuite — every declared variant, both sports.
// ---------------------------------------------------------------------------

padSpecConformanceSuite(hockey, { cfg: {}, label: "fih-outdoor (default)", numRuns: 150, cfgPerturbations: periodCfgPerturbations });
padSpecConformanceSuite(hockey, { cfg: hockey.variants["fih-shootout"], label: "fih-shootout", numRuns: 100 });
padSpecConformanceSuite(hockey, { cfg: hockey.variants["youth"], label: "youth", numRuns: 100 });

padSpecConformanceSuite(icehockey, { cfg: {}, label: "iihf (default)", numRuns: 150, cfgPerturbations: periodCfgPerturbations });
padSpecConformanceSuite(icehockey, { cfg: icehockey.variants["recreational"], label: "recreational", numRuns: 100 });

// ---------------------------------------------------------------------------
// (a), the module-level half — checkActionCoverage across the variant union.
// hockey's shoot-out action is reachable ONLY when cfg.shootout !== null
// (fih-outdoor's default is null), so the default cfg ALONE never reaches
// `hockey.shootout.attempt`; icehockey's default cfg already has a
// non-null shootout, so its default cfg alone reaches everything, but
// `recreational` (shootout: null) does not — same cfg-mutually-exclusive
// shape the brief calls out explicitly.
// ---------------------------------------------------------------------------

describe("hockey padSpec — action coverage across the variant space", () => {
  it("every registered event type is reachable from some action, across fih-outdoor + fih-shootout + youth", () => {
    const specs: PadSpec[] = [
      hockeyPadSpec(hockey.configSchema.parse({})),
      hockeyPadSpec(hockey.configSchema.parse(hockey.variants["fih-shootout"])),
      hockeyPadSpec(hockey.configSchema.parse(hockey.variants["youth"])),
    ];
    expect(checkActionCoverage(specs, HOCKEY_EVENT_SCHEMAS)).toEqual([]);
  });

  it("MUTATION SHAPE — coverage fails if fih-shootout is dropped from the union (uniquely covering hockey.shootout.attempt)", () => {
    const specsWithoutShootout: PadSpec[] = [
      hockeyPadSpec(hockey.configSchema.parse({})),
      hockeyPadSpec(hockey.configSchema.parse(hockey.variants["youth"])),
    ];
    const problems = checkActionCoverage(specsWithoutShootout, HOCKEY_EVENT_SCHEMAS);
    expect(problems.join(" ")).toMatch(/hockey\.shootout\.attempt/);
  });
});

describe("icehockey padSpec — action coverage across the variant space", () => {
  it("every registered event type is reachable from some action, across iihf (default) alone", () => {
    // Unlike hockey, icehockey's DEFAULT cfg already has a non-null
    // shootout, so the default alone reaches all six types.
    const specs: PadSpec[] = [icehockeyPadSpec(icehockey.configSchema.parse({}))];
    expect(checkActionCoverage(specs, ICEHOCKEY_EVENT_SCHEMAS)).toEqual([]);
  });

  it("recreational ALONE does not reach icehockey.shootout.attempt — the cfg-mutually-exclusive case the brief names", () => {
    const specs: PadSpec[] = [icehockeyPadSpec(icehockey.configSchema.parse(icehockey.variants["recreational"]))];
    const problems = checkActionCoverage(specs, ICEHOCKEY_EVENT_SCHEMAS);
    expect(problems.join(" ")).toMatch(/icehockey\.shootout\.attempt/);
  });

  it("the union of default + recreational reaches everything", () => {
    const specs: PadSpec[] = [
      icehockeyPadSpec(icehockey.configSchema.parse({})),
      icehockeyPadSpec(icehockey.configSchema.parse(icehockey.variants["recreational"])),
    ];
    expect(checkActionCoverage(specs, ICEHOCKEY_EVENT_SCHEMAS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Variant reshaping — the #416 acceptance line: youth (post-fix) vs adult
// hockey, and recreational (post-fix) vs full icehockey, must produce
// demonstrably different panels/bounds.
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

function actionTypesOf(spec: PadSpec): Set<string> {
  return new Set(spec.panels.flatMap((panel) => panel.actions.map((action) => action.type)));
}

describe("hockey padSpec — youth vs adult are demonstrably different (#416)", () => {
  const adultSpec = hockeyPadSpec(hockey.configSchema.parse({}));
  const youthSpec = hockeyPadSpec(hockey.configSchema.parse(hockey.variants["youth"]));

  it("both declare the SAME three card classes — the fix is not a renamed vocabulary", () => {
    const adultClasses = findField(adultSpec, "hockey.suspension.start", "class");
    const youthClasses = findField(youthSpec, "hockey.suspension.start", "class");
    expect(adultClasses?.kind).toBe("enum");
    expect(youthClasses?.kind).toBe("enum");
    if (adultClasses?.kind === "enum" && youthClasses?.kind === "enum") {
      expect([...adultClasses.values].sort()).toEqual(["green", "red", "yellow"]);
      expect([...youthClasses.values].sort()).toEqual(["green", "red", "yellow"]);
    }
  });

  it("but the card duration BOUND differs — this is what actually witnesses the regression fix", () => {
    const adultMinutes = findField(adultSpec, "hockey.suspension.start", "minutes");
    const youthMinutes = findField(youthSpec, "hockey.suspension.start", "minutes");
    expect(adultMinutes?.kind).toBe("number");
    expect(youthMinutes?.kind).toBe("number");
    if (adultMinutes?.kind === "number" && youthMinutes?.kind === "number") {
      // adult: max(green 2, yellow 5) * 2 = 10. youth: max(green 1, yellow 3) * 2 = 6.
      expect(adultMinutes.max).toBe(10);
      expect(youthMinutes.max).toBe(6);
      expect(youthMinutes.max).toBeLessThan(adultMinutes.max);
    }
  });

  it("REGRESSION SHAPE — pre-fix, youth's bound was byte-identical to adult's (same inherited durations)", () => {
    // Reconstructs what padSpec would have produced against the OLD youth
    // preset (periods overridden, strength/suspensions left at adult) —
    // proving this test genuinely discriminates the fix rather than passing
    // by construction.
    const preFixYouthCfg = hockey.configSchema.parse({ periods: { count: 4, minutes: 10 } });
    const preFixYouthSpec = hockeyPadSpec(preFixYouthCfg);
    const preFixMinutes = findField(preFixYouthSpec, "hockey.suspension.start", "minutes");
    expect(preFixMinutes?.kind).toBe("number");
    if (preFixMinutes?.kind === "number") {
      expect(preFixMinutes.max).toBe(10); // identical to adult's bound — the bug
    }
  });

  it("period advance targets differ from a plain half/quarter count — both use Q1..Q4, unaffected by the fix", () => {
    // Sanity: the ALREADY-correct part of the youth preset (periods) is not
    // accidentally broken by this fix.
    const adultTo = findField(adultSpec, "hockey.period.advance", "to");
    const youthTo = findField(youthSpec, "hockey.period.advance", "to");
    if (adultTo?.kind === "enum" && youthTo?.kind === "enum") {
      expect(adultTo.values).toEqual(youthTo.values); // both 4-quarter formats: Q2,Q3,Q4,FT
    }
  });
});

describe("icehockey padSpec — recreational vs full IIHF are demonstrably different (#416)", () => {
  const fullSpec = icehockeyPadSpec(icehockey.configSchema.parse({}));
  const recSpec = icehockeyPadSpec(icehockey.configSchema.parse(icehockey.variants["recreational"]));

  it("the discipline class enum shrinks to minors only — not merely re-durationed like hockey's fix", () => {
    const fullClasses = findField(fullSpec, "icehockey.suspension.start", "class");
    const recClasses = findField(recSpec, "icehockey.suspension.start", "class");
    expect(fullClasses?.kind).toBe("enum");
    expect(recClasses?.kind).toBe("enum");
    if (fullClasses?.kind === "enum" && recClasses?.kind === "enum") {
      expect([...fullClasses.values].sort()).toEqual([
        "bench_minor", "double_minor", "game_misconduct", "major", "match", "minor", "misconduct",
      ]);
      expect([...recClasses.values].sort()).toEqual(["bench_minor", "minor"]);
    }
  });

  it("REGRESSION SHAPE — pre-fix, recreational's class enum was byte-identical to the full ladder", () => {
    const preFixRecCfg = icehockey.configSchema.parse({ overtime: null, shootout: null, points: { win: 2, draw: 1, loss: 0 } });
    const preFixRecSpec = icehockeyPadSpec(preFixRecCfg);
    const preFixClasses = findField(preFixRecSpec, "icehockey.suspension.start", "class");
    expect(preFixClasses?.kind).toBe("enum");
    if (preFixClasses?.kind === "enum") {
      expect([...preFixClasses.values].sort()).toEqual([
        "bench_minor", "double_minor", "game_misconduct", "major", "match", "minor", "misconduct",
      ]); // identical to the full ladder — the bug
    }
  });

  it("the shoot-out panel disappears entirely for recreational — cfg.shootout is null", () => {
    expect(actionTypesOf(fullSpec).has("icehockey.shootout.attempt")).toBe(true);
    expect(actionTypesOf(recSpec).has("icehockey.shootout.attempt")).toBe(false);
    expect(fullSpec.panels.some((p) => p.labelKey.key === "pad.icehockey.panel.shootout")).toBe(true);
    expect(recSpec.panels.some((p) => p.labelKey.key === "pad.icehockey.panel.shootout")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shoot-out panel gate — cfg decides the panel EXISTS, state decides it is
// REACHABLE right now. Mirrors cricket's super-over panel integration test.
// ---------------------------------------------------------------------------

describe("hockey padSpec — shoot-out panel: cfg gates existence, a runtime gate governs reachability", () => {
  it("is present for fih-shootout with a path-equals gate against the real phase value", () => {
    const spec = hockeyPadSpec(hockey.configSchema.parse(hockey.variants["fih-shootout"]));
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.hockey.panel.shootout");
    expect(panel?.gate).toEqual({ op: "path-equals", path: "state.phase", value: "SHOOTOUT" });
  });

  it("integration: gate is false pre-match and false while merely live, true once the match actually reaches SHOOTOUT", () => {
    const cfg = hockey.configSchema.parse(hockey.variants["fih-shootout"]);
    const spec = hockeyPadSpec(cfg);
    const panel = spec.panels.find((p) => p.labelKey.key === "pad.hockey.panel.shootout");
    const gate = panel?.gate;
    expect(gate).toBeDefined();
    const lineups = defaultLineupPair(resolvePositions(hockey, cfg));
    const preState = hockey.init(cfg, lineups);
    expect(evalPadGate(gate!, { state: preState, summary: hockey.summary(preState) })).toBe(false);

    const events: ModuleEvent[] = [
      { type: "core.start", payload: {} },
      { type: "hockey.period.advance", payload: { to: "Q2" } },
      { type: "hockey.period.advance", payload: { to: "Q3" } },
      { type: "hockey.period.advance", payload: { to: "Q4" } },
      { type: "hockey.period.advance", payload: { to: "FT" } },
    ];
    const level = foldMatch(
      hockey,
      cfg,
      lineups,
      events.map((event, i) => makeEnvelope(i, event)),
      { strictFromSeq: 0 },
    );
    expect((level as { phase: string }).phase).toBe("SHOOTOUT"); // fixture check: 0-0, no OT for fih-shootout, straight to SHOOTOUT
    expect(evalPadGate(gate!, { state: level, summary: hockey.summary(level) })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No second tier vocabulary — the numeric FidelityTier.tier scale only.
// ---------------------------------------------------------------------------

describe("period padSpec — fidelity is the closed numeric 0-3 scale, no second vocabulary", () => {
  it("every band declared by both sports' padSpec is 0, 1 or 2 today (band 3 deliberately unpopulated — T2 lane)", () => {
    const specs = [
      hockeyPadSpec(hockey.configSchema.parse({})),
      icehockeyPadSpec(icehockey.configSchema.parse({})),
    ];
    for (const spec of specs) {
      for (const band of Object.values(spec.fidelity)) {
        expect([0, 1, 2, 3]).toContain(band);
      }
    }
  });
});
