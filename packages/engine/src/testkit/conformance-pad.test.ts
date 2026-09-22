// S6/#416 (W5) — unit tests for the padSpec conformance harness itself,
// against tiny synthetic modules rather than a real sport, so each of
// acceptance criteria (a)-(e) plus the never-throws/determinism property can
// be proven to both PASS a correct spec and FAIL a broken one. TDD: this file
// is written before `conformance-pad.ts` exists, so the first run is a
// collection-time red (no such module) — the real proof of the harness's own
// correctness. `sports/cricket/cricket.test.ts` wires the real thing.
import { z } from "zod";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { LineupPair, MatchOutcome, ScoreSummary, StandingsDelta } from "../core/types.ts";
import { type FidelityBand, type PadField, type PadSpec, type SportModule } from "../sport/module.ts";
import {
  checkActionCoverage,
  checkActionPayloadsAccepted,
  checkDomainMdPresent,
  checkEventSchemasBijection,
  checkFidelityMap,
  checkLabelKeysUnique,
  checkRegisteredTypesDispatch,
  checkTotalDeterministicAndPureData,
  collectPadLabels,
  domainMdPath,
  eventsAtOrBelowBand,
  isPadReady,
  padItemLabelKey,
  padSpecConformanceSuite,
  SPORT_DIRS,
} from "./conformance-pad.ts";
import { defaultLineupPair } from "./helpers.ts";
import { resolvePositions } from "../sport/catalog.ts";

// ---------------------------------------------------------------------------
// A tiny synthetic module — two event types, one shared schema alias (mirrors
// cricket.ball / cricket.superover.ball sharing CricketBall), one panel per
// phase, one gate. Good enough to exercise every check without cricket's
// bulk.
// ---------------------------------------------------------------------------

const FakeCfg = z.object({ n: z.number().int().min(1).max(6).default(3) });
type FakeCfg = z.infer<typeof FakeCfg>;

const FakeRun = z.strictObject({ runs: z.number().int().min(0).max(3) });
const FakeReset = z.strictObject({});
const FakeEv = z.union([FakeRun, FakeReset]);
type FakeEv = z.infer<typeof FakeEv>;

const FAKE_EVENT_SCHEMAS = { "fake.run": FakeRun, "fake.reset": FakeReset };

interface FakeState {
  total: number;
  resets: number;
}

function fakePadSpec(_cfg: FakeCfg): PadSpec {
  return {
    panels: [
      {
        labelKey: { key: "pad.fake.panel.live", label: "Live" },
        phase: "live",
        layout: "primary",
        actions: [
          {
            type: "fake.run",
            labelKey: { key: "pad.fake.action.run", label: "Run" },
            fields: [{ kind: "number", path: "runs", min: 0, max: 3 }],
            attribution: [],
          },
        ],
      },
      {
        labelKey: { key: "pad.fake.panel.reset", label: "Reset" },
        phase: "live",
        layout: "drawer",
        actions: [
          {
            type: "fake.reset",
            labelKey: { key: "pad.fake.action.reset", label: "Reset" },
            fields: [],
            attribution: [],
          },
        ],
      },
    ],
    fidelity: { "fake.run": 3, "fake.reset": 1 },
  };
}

function makeFakeModule(over: Partial<SportModule<FakeCfg, FakeEv, FakeState>> = {}): SportModule<FakeCfg, FakeEv, FakeState> {
  return {
    key: "cricket", // deliberately a REAL SPORT_DIRS key so (e) can prove positive
    version: "1.0.0",
    configSchema: FakeCfg,
    eventSchema: FakeEv,
    eventSchemas: FAKE_EVENT_SCHEMAS,
    positions: { groups: [], lineup: { size: 1 } },
    variants: { big: { n: 6 } },
    init: () => ({ total: 0, resets: 0 }),
    apply: (state, ev): FakeState => {
      switch (ev.type) {
        case "fake.run":
          return { ...state, total: state.total + (ev.payload as z.infer<typeof FakeRun>).runs };
        case "fake.reset":
          return { ...state, resets: state.resets + 1 };
        default:
          throw new EngineError("INVALID_EVENT", `unknown event type "${ev.type}"`);
      }
    },
    outcome: (): MatchOutcome | null => null,
    summary: (): ScoreSummary => ({ headline: "", perSide: [] }),
    standingsDelta: (): [StandingsDelta, StandingsDelta] => [
      { entrantId: "H", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
      { entrantId: "A", played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} },
    ],
    metrics: [],
    defaultTiebreakers: ["points"],
    supportsDraws: () => true,
    declaredPointsSets: () => [0],
    matchPointsBounds: () => ({ max: 0, min: 0, winFloor: 0, lossCeil: 0 }),
    officialLabel: { scorer: "Scorer" },
    padSpec: fakePadSpec,
    ...over,
  };
}

const goodModule = makeFakeModule();
const goodCfg: FakeCfg = FakeCfg.parse({});
const goodSpec = fakePadSpec(goodCfg);
const catalog = resolvePositions(goodModule, goodCfg);
const lineups: LineupPair = defaultLineupPair(catalog);
const entrantIds: readonly [string, string] = [lineups.home.entrantId, lineups.away.entrantId];
const personPool = [...lineups.home.slots, ...lineups.away.slots].map((s) => s.personId);

// --------------------------------------------------------------- (a) bijection

describe("checkEventSchemasBijection", () => {
  it("passes when every union branch is registered by reference and vice versa", () => {
    expect(checkEventSchemasBijection(FakeEv, FAKE_EVENT_SCHEMAS)).toEqual([]);
  });

  it("tolerates two type strings sharing one schema object (cricket.ball/superover.ball shape)", () => {
    const shared = { "fake.run": FakeRun, "fake.run.alias": FakeRun, "fake.reset": FakeReset };
    expect(checkEventSchemasBijection(FakeEv, shared)).toEqual([]);
  });

  it("fails when a union branch is missing from the registry", () => {
    const incomplete = { "fake.run": FakeRun }; // fake.reset never registered
    expect(checkEventSchemasBijection(FakeEv, incomplete)).not.toEqual([]);
  });

  it("fails when the registry references a schema that is not a real union branch", () => {
    const Bogus = z.strictObject({ made: z.literal("up") });
    const withExtra = { "fake.run": FakeRun, "fake.reset": FakeReset, "fake.bogus": Bogus };
    expect(checkEventSchemasBijection(FakeEv, withExtra)).not.toEqual([]);
  });

  it("fails when the registry rebuilds an equivalent-shaped schema instead of reusing the reference", () => {
    const RebuiltRun = z.strictObject({ runs: z.number().int().min(0).max(3) }); // same shape, different object
    const wrongRef = { "fake.run": RebuiltRun, "fake.reset": FakeReset };
    expect(checkEventSchemasBijection(FakeEv, wrongRef)).not.toEqual([]);
  });
});

// --------------------------------------------------------------- (a) coverage

describe("checkActionCoverage", () => {
  it("passes when every registered type is reachable from some action", () => {
    expect(checkActionCoverage(goodSpec, FAKE_EVENT_SCHEMAS)).toEqual([]);
  });

  it("fails when an action was deleted for a registered type — THE MUTATION SHAPE", () => {
    const broken: PadSpec = { ...goodSpec, panels: [goodSpec.panels[0] as PadSpec["panels"][number]] }; // drop the reset panel/action
    const problems = checkActionCoverage(broken, FAKE_EVENT_SCHEMAS);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/fake\.reset/);
  });

  it("fails when an action names a type absent from eventSchemas", () => {
    const withGhost: PadSpec = {
      ...goodSpec,
      panels: [
        ...goodSpec.panels,
        {
          labelKey: { key: "pad.fake.panel.ghost", label: "Ghost" },
          phase: "live",
          layout: "grid",
          actions: [
            {
              type: "fake.ghost",
              labelKey: { key: "pad.fake.action.ghost", label: "Ghost" },
              fields: [],
              attribution: [],
            },
          ],
        },
      ],
    };
    expect(checkActionCoverage(withGhost, FAKE_EVENT_SCHEMAS)).not.toEqual([]);
  });
});

// --------------------------------------------------- (a) behavioral dispatch

describe("checkRegisteredTypesDispatch", () => {
  it("passes when every registered type is a real dispatch case", () => {
    expect(checkRegisteredTypesDispatch(goodModule, goodCfg, lineups, FAKE_EVENT_SCHEMAS)).toEqual([]);
  });

  it("fails when a registry key has no matching dispatch case — registry/switch drift", () => {
    const drifted = { ...FAKE_EVENT_SCHEMAS, "fake.orphan": FakeReset };
    const problems = checkRegisteredTypesDispatch(goodModule, goodCfg, lineups, drifted);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/fake\.orphan/);
  });

  it("does not flag a type that dispatches but rejects the (empty) sample payload for a different reason", () => {
    // fake.run's real schema requires `runs`; apply() still recognises the
    // type (parsePayload would throw INVALID_EVENT "invalid ... payload", a
    // different message than "unknown event type") — must not be flagged.
    expect(checkRegisteredTypesDispatch(goodModule, goodCfg, lineups, { "fake.run": FakeRun })).toEqual([]);
  });
});

// --------------------------------------------------------------- (b) payloads

describe("checkActionPayloadsAccepted", () => {
  it("does not throw when every action's declared bounds only produce schema-valid payloads", () => {
    expect(() =>
      checkActionPayloadsAccepted(goodSpec, FAKE_EVENT_SCHEMAS, entrantIds, personPool, 50),
    ).not.toThrow();
  });

  it("throws when a field's declared bounds can produce a payload the schema rejects", () => {
    const overBound: PadSpec = {
      ...goodSpec,
      panels: [
        {
          ...(goodSpec.panels[0] as PadSpec["panels"][number]),
          actions: [
            {
              type: "fake.run",
              labelKey: { key: "pad.fake.action.run", label: "Run" },
              // schema caps runs at 3; declaring up to 9 must be catchable.
              fields: [{ kind: "number", path: "runs", min: 0, max: 9 }],
              attribution: [],
            },
          ],
        },
      ],
    };
    expect(() =>
      checkActionPayloadsAccepted(overBound, FAKE_EVENT_SCHEMAS, entrantIds, personPool, 50),
    ).toThrow();
  });

  it("assembles attribution into the payload via buildPathObject, and a wrong path is catchable", () => {
    const PersonEv = z.strictObject({ scorer: z.string().min(1) });
    const spec: PadSpec = {
      panels: [
        {
          labelKey: { key: "pad.fake.panel.person", label: "Person" },
          phase: "live",
          layout: "grid",
          actions: [
            {
              type: "fake.person",
              labelKey: { key: "pad.fake.action.person", label: "Score" },
              fields: [],
              attribution: [{ kind: "person", path: "scorer" }],
            },
          ],
        },
      ],
      fidelity: { "fake.person": 3 },
    };
    expect(() =>
      checkActionPayloadsAccepted(spec, { "fake.person": PersonEv }, entrantIds, personPool, 30),
    ).not.toThrow();

    const wrongPath: PadSpec = {
      ...spec,
      panels: [
        {
          ...(spec.panels[0] as PadSpec["panels"][number]),
          actions: [
            {
              type: "fake.person",
              labelKey: { key: "pad.fake.action.person", label: "Score" },
              fields: [],
              attribution: [{ kind: "person", path: "wrongKey" }], // PersonEv is strict — rejects unrecognised keys, and `scorer` becomes missing/required
            },
          ],
        },
      ],
    };
    expect(() =>
      checkActionPayloadsAccepted(wrongPath, { "fake.person": PersonEv }, entrantIds, personPool, 30),
    ).toThrow();
  });

  it("handles an action needing a SIDE and TWO persons together — the shape a single discriminated attribution.kind could not express (cricket.review: `by` + optional `person`/`against`)", () => {
    const ReviewLikeEv = z.strictObject({
      by: z.string().min(1),
      caller: z.string().min(1),
      against: z.string().min(1),
    });
    const spec: PadSpec = {
      panels: [
        {
          labelKey: { key: "pad.fake.panel.review", label: "Review" },
          phase: "live",
          layout: "drawer",
          actions: [
            {
              type: "fake.review",
              labelKey: { key: "pad.fake.action.review", label: "Review" },
              fields: [],
              attribution: [
                { kind: "side", path: "by" },
                { kind: "person", path: "caller" },
                { kind: "person", path: "against" },
              ],
            },
          ],
        },
      ],
      fidelity: { "fake.review": 1 },
    };
    expect(() =>
      checkActionPayloadsAccepted(spec, { "fake.review": ReviewLikeEv }, entrantIds, personPool, 40),
    ).not.toThrow();
  });
});

// --------------------------------------------------------------- (c) labels

/** `goodSpec` with the run action's field list swapped — the one shape every
 *  S7 field-label case below needs, built once. */
function withRunFields(fields: readonly PadField[]): PadSpec {
  const live = goodSpec.panels[0] as PadSpec["panels"][number];
  return {
    ...goodSpec,
    panels: [
      { ...live, actions: [{ ...(live.actions[0] as PadSpec["panels"][number]["actions"][number]), fields }] },
      goodSpec.panels[1] as PadSpec["panels"][number],
    ],
  };
}

describe("checkLabelKeysUnique", () => {
  it("passes when every labelKey.key is unique", () => {
    expect(checkLabelKeysUnique(goodSpec)).toEqual([]);
  });

  it("fails on a duplicate labelKey between two actions", () => {
    const dup: PadSpec = {
      ...goodSpec,
      panels: [
        goodSpec.panels[0] as PadSpec["panels"][number],
        {
          ...(goodSpec.panels[1] as PadSpec["panels"][number]),
          actions: [
            {
              type: "fake.reset",
              labelKey: { key: "pad.fake.action.run", label: "Reset" }, // collides with the run action's key
              fields: [],
              attribution: [],
            },
          ],
        },
      ],
    };
    expect(checkLabelKeysUnique(dup)).not.toEqual([]);
  });

  it("fails on a duplicate labelKey between a panel and an action", () => {
    const dup: PadSpec = {
      ...goodSpec,
      panels: [{ ...(goodSpec.panels[0] as PadSpec["panels"][number]), labelKey: { key: "pad.fake.action.reset", label: "Live" } }, goodSpec.panels[1] as PadSpec["panels"][number]],
    };
    expect(checkLabelKeysUnique(dup)).not.toEqual([]);
  });

  // S7/#427 — the SAME check now covers field / attribution labels. Written
  // as three cases because the interesting one is the third: a field key that
  // collides with an ACTION key would previously have been invisible to every
  // check in this file, and it is the collision a translator actually sees
  // (one dictionary entry, two meanings).
  it("fails on a duplicate labelKey between two fields of one action", () => {
    const dup = withRunFields([
      { kind: "number", path: "runs", min: 0, max: 3, labelKey: { key: "pad.fake.action.run.field.runs", label: "Runs" } },
      { kind: "toggle", path: "wide", labelKey: { key: "pad.fake.action.run.field.runs", label: "Wide" } },
    ]);
    expect(checkLabelKeysUnique(dup)).not.toEqual([]);
  });

  it("fails on a duplicate labelKey between a field and an action", () => {
    const dup = withRunFields([
      { kind: "number", path: "runs", min: 0, max: 3, labelKey: { key: "pad.fake.action.run", label: "Runs" } },
    ]);
    expect(checkLabelKeysUnique(dup)).not.toEqual([]);
  });

  it("passes when field labels are present and distinct", () => {
    const ok = withRunFields([
      { kind: "number", path: "runs", min: 0, max: 3, labelKey: { key: "pad.fake.action.run.field.runs", label: "Runs" } },
    ]);
    expect(checkLabelKeysUnique(ok)).toEqual([]);
  });
});

// R7/generic — the narrow phase-pairing exception: a key may recur ONLY as
// the byte-identical declaration restated for a DIFFERENT phase (the shape
// `everyPhase`, sports/generic/generic.ts, produces). Every other repeat
// stays exactly as forbidden as `checkLabelKeysUnique`'s block above proves.
describe("checkLabelKeysUnique — the phase-pairing exception", () => {
  const live = goodSpec.panels[0] as PadSpec["panels"][number]; // "pad.fake.panel.live" / "pad.fake.action.run"
  const reset = goodSpec.panels[1] as PadSpec["panels"][number];

  it("passes when the identical panel+action are restated once for \"pre\" and once for \"live\"", () => {
    const pre: PadSpec["panels"][number] = { ...live, phase: "pre" };
    const spec: PadSpec = { ...goodSpec, panels: [pre, live, reset] };
    expect(checkLabelKeysUnique(spec)).toEqual([]);
  });

  it("still fails when one key is declared twice for the SAME phase, even with identical content", () => {
    const spec: PadSpec = { ...goodSpec, panels: [live, { ...live }, reset] };
    expect(checkLabelKeysUnique(spec)).not.toEqual([]);
  });

  it("still fails when a key repeats across two phases but its content drifts", () => {
    const driftedPre: PadSpec["panels"][number] = {
      ...live,
      phase: "pre",
      labelKey: { key: live.labelKey.key, label: "Different text" }, // same key, different label
    };
    const spec: PadSpec = { ...goodSpec, panels: [driftedPre, live, reset] };
    expect(checkLabelKeysUnique(spec)).not.toEqual([]);
  });

  it("still fails when only the ACTION content drifts between the two phase copies", () => {
    const driftedPre: PadSpec["panels"][number] = {
      ...live,
      phase: "pre",
      actions: [{ ...(live.actions[0] as PadSpec["panels"][number]["actions"][number]), type: "fake.reset" }],
    };
    const spec: PadSpec = { ...goodSpec, panels: [driftedPre, live, reset] };
    expect(checkLabelKeysUnique(spec)).not.toEqual([]);
  });

  // Review finding 1 — the three drifts the FIRST version of this exception
  // could not see. It compared `label`/`where`/`type`/`path` only, which are
  // the four fields `PadLabelRef` happens to carry; a `PadAction`'s real
  // content (`fields`, `attribution`) and a `PadPanel`'s (`layout`, `gate`)
  // are absent from that ref entirely, so each case below was waved through
  // as a "byte-identical restatement" while genuinely disagreeing about what
  // the shared key means. The pre-existing "ACTION content drifts" case above
  // varies `type`, which the shallow compare DID catch — so it passed both
  // before and after, and proved nothing about this hole.

  it("still fails when the two phase copies disagree on a FIELD's bounds", () => {
    const action = live.actions[0] as PadSpec["panels"][number]["actions"][number];
    const driftedPre: PadSpec["panels"][number] = {
      ...live,
      phase: "pre",
      actions: [{ ...action, fields: [{ kind: "number", path: "runs", min: 0, max: 6 }] }], // max 3 -> 6
    };
    const spec: PadSpec = { ...goodSpec, panels: [driftedPre, live, reset] };
    expect(checkLabelKeysUnique(spec)).not.toEqual([]);
  });

  it("still fails when one phase copy carries ATTRIBUTION the other omits", () => {
    const action = live.actions[0] as PadSpec["panels"][number]["actions"][number];
    const driftedPre: PadSpec["panels"][number] = {
      ...live,
      phase: "pre",
      actions: [{ ...action, attribution: [{ kind: "person", path: "person" }] }], // [] on the live copy
    };
    const spec: PadSpec = { ...goodSpec, panels: [driftedPre, live, reset] };
    expect(checkLabelKeysUnique(spec)).not.toEqual([]);
  });

  it("still fails when the two phase copies disagree on the PANEL's layout or gate", () => {
    const driftedLayout: PadSpec["panels"][number] = { ...live, phase: "pre", layout: "grid" }; // "primary" on live
    expect(checkLabelKeysUnique({ ...goodSpec, panels: [driftedLayout, live, reset] })).not.toEqual([]);

    const driftedGate: PadSpec["panels"][number] = { ...live, phase: "pre", gate: { op: "path-truthy", path: "state.total" } };
    expect(checkLabelKeysUnique({ ...goodSpec, panels: [driftedGate, live, reset] })).not.toEqual([]);
  });

  it("passes a pairing whose two copies are identical but written with their keys in a different ORDER", () => {
    // The fingerprint sorts keys, so a cosmetic reordering is still a pairing.
    // Without that, `everyPhase`'s twins would be safe only because they share
    // one object reference, and any hand-written pair would flake.
    const reordered = { actions: live.actions, layout: live.layout, labelKey: live.labelKey, phase: "pre" as const };
    const spec: PadSpec = { ...goodSpec, panels: [reordered, live, reset] };
    expect(checkLabelKeysUnique(spec)).toEqual([]);
  });

  it("collectPadLabels itself never exposes phase — the public ref shape is unchanged", () => {
    const pre: PadSpec["panels"][number] = { ...live, phase: "pre" };
    const spec: PadSpec = { ...goodSpec, panels: [pre, live, reset] };
    for (const ref of collectPadLabels(spec)) {
      expect(ref).not.toHaveProperty("phase");
      expect(ref).not.toHaveProperty("decl"); // the fingerprint is internal too
    }
  });
});

// S7/#427 — `collectPadLabels` is what the extended (c) check and every
// per-sport field-label assertion read. Vacuity guard first: a walker that
// returned nothing would make all three cases above pass while proving
// nothing.
describe("collectPadLabels / padItemLabelKey", () => {
  it("returns every panel and action label, and omits unlabelled fields", () => {
    const refs = collectPadLabels(goodSpec);
    expect(refs.filter((r) => r.where === "panel").map((r) => r.key)).toEqual([
      "pad.fake.panel.live",
      "pad.fake.panel.reset",
    ]);
    expect(refs.filter((r) => r.where === "action").map((r) => r.key)).toEqual([
      "pad.fake.action.run",
      "pad.fake.action.reset",
    ]);
    // `goodSpec`'s one field carries no labelKey — absent, not a hole.
    expect(refs.filter((r) => r.where === "field" || r.where === "attribution")).toEqual([]);
    expect(padItemLabelKey(goodSpec, "fake.run", "runs")).toBeUndefined();
  });

  it("finds a field label by (action type, payload path), tagged with both", () => {
    const spec = withRunFields([
      { kind: "number", path: "runs", min: 0, max: 3, labelKey: { key: "pad.fake.action.run.field.runs", label: "Runs" } },
    ]);
    expect(padItemLabelKey(spec, "fake.run", "runs")).toEqual({
      key: "pad.fake.action.run.field.runs",
      label: "Runs",
      where: "field",
      type: "fake.run",
      path: "runs",
    });
    expect(padItemLabelKey(spec, "fake.reset", "runs")).toBeUndefined();
  });

  it("finds an attribution-item label the same way", () => {
    const spec: PadSpec = {
      ...goodSpec,
      panels: [
        {
          ...(goodSpec.panels[0] as PadSpec["panels"][number]),
          actions: [
            {
              type: "fake.run",
              labelKey: { key: "pad.fake.action.run", label: "Run" },
              fields: [],
              attribution: [
                { kind: "person", path: "striker", labelKey: { key: "pad.fake.action.run.field.striker", label: "Striker" } },
              ],
            },
          ],
        },
        goodSpec.panels[1] as PadSpec["panels"][number],
      ],
    };
    expect(padItemLabelKey(spec, "fake.run", "striker")?.where).toBe("attribution");
    expect(padItemLabelKey(spec, "fake.run", "striker")?.key).toBe("pad.fake.action.run.field.striker");
  });
});

// --------------------------------------------------------------- (d) fidelity

describe("eventsAtOrBelowBand", () => {
  it("is monotone by construction: a lower band's set is always a subset of a higher one", () => {
    const fidelity: Record<string, FidelityBand> = { a: 0, b: 1, c: 2, d: 3 };
    fc.assert(
      fc.property(
        fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
        fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
        (i, j) => {
          if (i > j) return;
          const lower = eventsAtOrBelowBand(fidelity, i);
          const upper = eventsAtOrBelowBand(fidelity, j);
          for (const type of lower) expect(upper.has(type)).toBe(true);
        },
      ),
    );
  });

  it("includes exactly the types at or below the given band", () => {
    const fidelity: Record<string, FidelityBand> = { a: 0, b: 1, c: 2, d: 3 };
    expect(eventsAtOrBelowBand(fidelity, 1)).toEqual(new Set(["a", "b"]));
  });
});

describe("checkFidelityMap", () => {
  it("passes on a well-formed, fully-covered map", () => {
    expect(checkFidelityMap(goodSpec, FAKE_EVENT_SCHEMAS)).toEqual([]);
  });

  it("fails when a registered type has no band", () => {
    const missingBand: PadSpec = { ...goodSpec, fidelity: { "fake.run": 3 } }; // fake.reset uncovered
    expect(checkFidelityMap(missingBand, FAKE_EVENT_SCHEMAS)).not.toEqual([]);
  });

  it("fails when the map bands a type that is not registered", () => {
    const phantomBand: PadSpec = { ...goodSpec, fidelity: { ...goodSpec.fidelity, "fake.phantom": 2 } };
    expect(checkFidelityMap(phantomBand, FAKE_EVENT_SCHEMAS)).not.toEqual([]);
  });
});

// --------------------------------------------------------------- (e) DOMAIN.md

describe("domainMdPath / checkDomainMdPresent", () => {
  it("resolves a solo-directory sport to sports/<key>/DOMAIN.md", () => {
    expect(domainMdPath("cricket")).toMatch(/sports[\\/]cricket[\\/]DOMAIN\.md$/);
  });

  it("resolves a setbased-family sport to sports/setbased/DOMAIN.<key>.md", () => {
    expect(domainMdPath("volleyball")).toMatch(/sports[\\/]setbased[\\/]DOMAIN\.volleyball\.md$/);
  });

  it("throws for a key with no SPORT_DIRS entry", () => {
    expect(() => domainMdPath("not-a-real-sport")).toThrow();
  });

  it("passes for cricket, which really has one", () => {
    expect(checkDomainMdPresent("cricket")).toEqual([]);
  });

  it("fails for a registered key whose file does not exist on disk", () => {
    SPORT_DIRS.__test_missing__ = "__nonexistent_dir_for_conformance_pad_test__";
    try {
      expect(checkDomainMdPresent("__test_missing__")).not.toEqual([]);
    } finally {
      delete SPORT_DIRS.__test_missing__;
    }
  });
});

// ------------------------------------------------ never-throws / determinism

describe("checkTotalDeterministicAndPureData", () => {
  it("passes for a padSpec that is total, deterministic and pure data", () => {
    expect(() =>
      checkTotalDeterministicAndPureData(
        fakePadSpec,
        FakeCfg,
        {},
        { big: { n: 6 } },
        fc.constant({}),
        30,
      ),
    ).not.toThrow();
  });

  it("fails for a padSpec that throws for some cfg", () => {
    const throwing = (cfg: FakeCfg): PadSpec => {
      if (cfg.n === 6) throw new Error("boom");
      return fakePadSpec(cfg);
    };
    expect(() =>
      checkTotalDeterministicAndPureData(throwing, FakeCfg, {}, { big: { n: 6 } }, fc.constant({}), 30),
    ).toThrow();
  });

  it("fails for a padSpec that is not deterministic", () => {
    let call = 0;
    const flaky = (cfg: FakeCfg): PadSpec => {
      call += 1;
      return { ...fakePadSpec(cfg), fidelity: { ...fakePadSpec(cfg).fidelity, "fake.run": call % 2 === 0 ? 3 : 2 } };
    };
    expect(() =>
      checkTotalDeterministicAndPureData(flaky, FakeCfg, {}, {}, fc.constant({}), 10),
    ).toThrow();
  });
});

// ------------------------------------------------------------- full wiring

// Mirrors how a real module's own test file calls this at module scope
// (`conformanceSuite(cricket, {...})` in cricket.test.ts): registers real
// vitest `it()`s and trusts the runner to report them. A broken module here
// would show up as a FAILING test below, not as an exception this file can
// catch — this is the integration proof that the pieces above wire together
// correctly, on top of each piece's own direct unit tests.
padSpecConformanceSuite(goodModule, { cfg: {}, lineups, label: "synthetic", numRuns: 30 });

// The "unwired module fails loudly" behaviour is the guard clause's decision
// (`isPadReady`), tested directly below. It is deliberately NOT proven by
// calling `padSpecConformanceSuite` on an unwired module here: that function
// registers real vitest tests as a side effect, and the whole point of this
// path is that one of them FAILS — which is correct behaviour for a caller
// that forgot to wire a module, but would leave a permanently-red test in
// THIS file, which is supposed to be green. Confirmed instead by mutating
// `isPadReady`'s own inputs directly (see below) and, at verification time,
// by actually calling `padSpecConformanceSuite(unwired-real-module, ...)`
// from a scratch file and reading the one expected failure — not committed.
describe("isPadReady — the guard padSpecConformanceSuite's loud-failure path uses", () => {
  it("is false when padSpec is missing", () => {
    expect(isPadReady(makeFakeModule({ padSpec: undefined }))).toBe(false);
  });

  it("is false when eventSchemas is missing", () => {
    expect(isPadReady(makeFakeModule({ eventSchemas: undefined }))).toBe(false);
  });

  it("is false when both are missing", () => {
    expect(isPadReady(makeFakeModule({ padSpec: undefined, eventSchemas: undefined }))).toBe(false);
  });

  it("is true for a fully wired module", () => {
    expect(isPadReady(goodModule)).toBe(true);
  });
});
