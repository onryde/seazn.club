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
  padItemLabelKey,
  padSpecConformanceSuite,
} from "../../testkit/conformance-pad.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import {
  SetBasedExpediteStart,
  SetBasedRally,
  SetBasedSanction,
  SetBasedSanctionLevel,
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
// so there is no CFG-MUTUAL-EXCLUSIVITY case the way volleyball's
// indoor/beach split needs a union across specs. That does NOT mean
// `checkActionCoverage` has nothing to check here: a single cfg's action set
// still needs to cover exactly "the types this sport can ever record" —
// review finding (S6/#416 gap list): the identical-across-variants check
// below proves internal self-consistency, but a flipped `records.X` flag
// (e.g. reading `records.timeouts` where `records.sanctions` was meant)
// would be WRONG THE SAME WAY on every variant and still pass it, since
// `records` itself never varies. `checkActionCoverage` against the sport's
// own recordable-type dict is the check that actually catches that shape —
// added below, not skipped.
//
// Each dict is "the types this sport can ever record", i.e. the base
// (rally + set summary) plus whichever `records.*` flags this SPECIFIC
// sport declares `true` (badminton.ts:37, tabletennis.ts:37) — mirrors
// `VOLLEYBALL_RECORDABLE_SCHEMAS` above, sized to what each sport actually
// turns on rather than volleyball's own set.
const BADMINTON_RECORDABLE_SCHEMAS = {
  "badminton.rally": SetBasedRally,
  "badminton.game.summary": SetBasedSummary, // badminton.ts coarseEventType: "game.summary", not "set.summary"
  "badminton.sanction": SetBasedSanction, // records.sanctions: true; timeouts/substitutions/expedite all false
};

const TABLETENNIS_RECORDABLE_SCHEMAS = {
  "tabletennis.rally": SetBasedRally,
  "tabletennis.game.summary": SetBasedSummary, // tabletennis.ts coarseEventType: "game.summary" too
  "tabletennis.timeout": SetBasedTimeout,
  "tabletennis.sanction": SetBasedSanction,
  "tabletennis.expedite.start": SetBasedExpediteStart, // records.timeouts/sanctions/expedite: true; substitutions: false
};

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

  it("badminton's single action-type set covers every type badminton can ever record", () => {
    const spec = badminton.padSpec!(badminton.configSchema.parse({}));
    expect(checkActionCoverage(spec, BADMINTON_RECORDABLE_SCHEMAS)).toEqual([]);
  });

  it("table tennis's single action-type set covers every type table tennis can ever record", () => {
    const spec = tabletennis.padSpec!(tabletennis.configSchema.parse({}));
    expect(checkActionCoverage(spec, TABLETENNIS_RECORDABLE_SCHEMAS)).toEqual([]);
  });

  it("MUTATION SHAPE — coverage fails if a recordable type is missing from badminton's declared set", () => {
    const spec = badminton.padSpec!(badminton.configSchema.parse({}));
    const { "badminton.sanction": _dropped, ...missingSanction } = BADMINTON_RECORDABLE_SCHEMAS;
    const problems = checkActionCoverage(spec, { ...missingSanction, "badminton.bogus": SetBasedSanction });
    expect(problems.join(" ")).toMatch(/badminton\.bogus/);
  });
});

// ---------------------------------------------------------------------------
// S7/#427 — PER-SPORT SUBSETTING of the shared sanction ladder.
//
// The S7 prompt states this criterion as "ITTF sanctions are yellow/red only,
// BWF adds black". There is no colour FIELD anywhere on this kernel — the
// premise is false as written. What exists is `SetBasedSanctionLevel`, the
// FIVB's four-step SEVERITY ladder, shared verbatim by all three sports, plus
// a colour→step mapping written down separately in each dossier:
//
//   badminton  (DOMAIN.badminton.md:35)  yellow = warning, red = penalty,
//                                        BLACK = disqualification
//   tabletennis(DOMAIN.tabletennis.md:36) yellow = warning, red = penalty;
//                                        "a pad should probably surface just
//                                        those two" — expulsion and
//                                        disqualification are the REFEREE's
//                                        removal, not the umpire's card
//   volleyball (DOMAIN.volleyball.md:38)  the FIVB ladder verbatim, all four
//
// So the asymmetry the criterion names is real (badminton's umpire has a
// black card; table tennis's has no third card at all) and the kernel did NOT
// gate it: every sport's pad offered `SetBasedSanctionLevel.options` whole.
// Fixed here, through the SAME preset-data mechanism `coarseEventType` /
// `unitLabel` / `defaults.records` already use — not a second gating layer.
// `arbitraryEvent` and `discipline.colors` deliberately keep the full ladder:
// narrowing the generator would move frozen goldens, and `extractCards` must
// still project a referee removal that WAS recorded.
// ---------------------------------------------------------------------------

describe("setbased padSpec — the sanction ladder is subset per sport (S7/#427)", () => {
  function sanctionLevels(module: typeof volleyball): readonly string[] {
    const spec = module.padSpec!(module.configSchema.parse({}));
    const field = findField(spec, `${module.key}.sanction`, "level");
    if (field?.kind !== "enum") throw new Error(`${module.key}: no sanction level enum field`);
    return field.values;
  }

  it("badminton's pad offers disqualification (the BWF black card); table tennis's does not", () => {
    expect(sanctionLevels(badminton)).toContain("disqualification");
    expect(sanctionLevels(tabletennis)).not.toContain("disqualification");
  });

  it("table tennis offers exactly the two ITTF cards; badminton and volleyball keep the full ladder", () => {
    expect([...sanctionLevels(tabletennis)]).toEqual(["warning", "penalty"]);
    expect([...sanctionLevels(badminton)]).toEqual([...SetBasedSanctionLevel.options]);
    expect([...sanctionLevels(volleyball)]).toEqual([...SetBasedSanctionLevel.options]);
  });

  it("every sport's subset is a real subset of the shared enum, in the enum's own order", () => {
    // Guards the two ways a per-sport list goes wrong: a typo'd member the
    // schema would reject at append time, and a re-ordering that would make
    // one sport's pad list the ladder in a different sequence from another's.
    for (const module of [volleyball, badminton, tabletennis]) {
      const levels = sanctionLevels(module);
      for (const level of levels) expect(SetBasedSanctionLevel.options).toContain(level);
      expect([...levels]).toEqual(SetBasedSanctionLevel.options.filter((o) => levels.includes(o)));
      expect(levels.length).toBeGreaterThan(0);
    }
  });

  it("the narrowing does NOT touch what the schema accepts, only what the pad offers", () => {
    // The kernel-union schema stays permissive on purpose: a referee removal
    // recorded by an admin, or a golden corpus payload, must still parse.
    expect(SetBasedSanction.safeParse({ by: "H", level: "disqualification" }).success).toBe(true);
    expect(SetBasedSanctionLevel.options).toEqual([
      "warning",
      "penalty",
      "expulsion",
      "disqualification",
    ]);
  });
});

// ---------------------------------------------------------------------------
// S7/#427 — `rally.server` / `rally.scorer`, the two prompts all three
// dossiers list as owed. They are adjacent person pickers on ONE action
// ("Rally (server / scorer)") and they are NOT interchangeable: `server` is
// the player who served, `scorer` the player credited with the terminating
// action. A renderer with no copy for them would draw two identical pickers.
// ---------------------------------------------------------------------------

describe("setbased padSpec — rally server / scorer prompts carry label keys (S7/#427)", () => {
  const modules = [volleyball, badminton, tabletennis];

  for (const module of modules) {
    const key = module.key;
    const spec = module.padSpec!(module.configSchema.parse({}));

    it(`${key}: both rally person prompts are labelled, with the sport's own key`, () => {
      expect(padItemLabelKey(spec, `${key}.rally`, "server")).toMatchObject({
        key: `pad.${key}.action.rallyAttributed.field.server`,
        where: "attribution",
      });
      expect(padItemLabelKey(spec, `${key}.rally`, "scorer")).toMatchObject({
        key: `pad.${key}.action.rallyAttributed.field.scorer`,
        where: "attribution",
      });
    });

    it(`${key}: the two prompts do not share a key or an English fallback`, () => {
      const server = padItemLabelKey(spec, `${key}.rally`, "server");
      const scorer = padItemLabelKey(spec, `${key}.rally`, "scorer");
      expect(server?.key).not.toBe(scorer?.key);
      expect(server?.label).not.toBe(scorer?.label);
      expect(server?.label ?? "").not.toBe("");
      expect(scorer?.label ?? "").not.toBe("");
    });
  }

  it("all three sports get distinct keys off the shared kernel", () => {
    const keys = modules.map(
      (m) => padItemLabelKey(m.padSpec!(m.configSchema.parse({})), `${m.key}.rally`, "server")?.key,
    );
    expect(new Set(keys).size).toBe(3);
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
