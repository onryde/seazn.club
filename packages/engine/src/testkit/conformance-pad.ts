// PadSpec conformance — S6/#416 (W5). Generic over any module: proves a
// declared `padSpec` hides nothing that `eventSchema` accepts, never throws,
// and is deterministic. Design problem this solves: `eventSchema` is a bare
// `z.union([...])` whose member payload schemas carry no literal `type`
// discriminant (the type string lives only on the envelope), and the ONLY
// place that ever paired a type string to its schema was the hand-written
// `apply()` dispatch switch — imperative code, not introspectable data. This
// file is what makes "every eventSchema union branch is reachable from some
// action" a checkable property instead of a hand-maintained claim, purely
// additively: nothing here touches a module's fold logic, so goldens cannot
// move.
//
// Touches node:fs (criterion (e), DOMAIN.md presence), so — like `golden.ts`
// — this file is deliberately NOT in `testkit/index.ts`'s barrel. Import it
// directly: `import { padSpecConformanceSuite } from "../../testkit/conformance-pad.ts"`.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { CoreEv, EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import {
  buildPathObject,
  type FidelityBand,
  type PadAction,
  type PadAttribution,
  type PadField,
  type PadFieldValue,
  type PadSpec,
  type SportModule,
} from "../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";

// ---------------------------------------------------------------------------
// (e) DOMAIN.md presence. Reuses `golden.ts`'s key -> directory table rather
// than a second copy: eight sports own `sports/<key>/DOMAIN.md`, three
// (volleyball/badminton/tabletennis) share `sports/setbased/` and are
// disambiguated by FILE name, `DOMAIN.<key>.md` — the same split `SPORT_DIRS`
// already encodes for goldens (`goldenPath`), just a different filename
// convention on top of the same directory.
// ---------------------------------------------------------------------------

// Local copy of golden.ts's key -> directory table. NOT re-exported from
// there: golden.ts is itself deliberately excluded from testkit/index.ts (it
// touches node:fs), and importing a testkit disk-reading module from another
// testkit disk-reading module for one lookup table is a needless coupling —
// this table is small, stable (module keys are pinned at 1.0.0, no new sport
// lands without a session that would touch this file anyway) and is asserted
// against the real `sports/` directory listing in this file's own test.
export const SPORT_DIRS: Record<string, string> = {
  football: "football",
  cricket: "cricket",
  boardgame: "boardgame",
  carrom: "carrom",
  generic: "generic",
  volleyball: "setbased",
  badminton: "setbased",
  tabletennis: "setbased",
  tennis: "tennis",
  icehockey: "icehockey",
  hockey: "hockey",
};

const HERE = dirname(fileURLToPath(import.meta.url));

export function domainMdPath(key: string): string {
  const dir = SPORT_DIRS[key];
  if (dir === undefined) {
    throw new Error(`no sport directory registered for module "${key}" (testkit/conformance-pad.ts SPORT_DIRS)`);
  }
  const filename = dir === "setbased" ? `DOMAIN.${key}.md` : "DOMAIN.md";
  return join(HERE, "..", "sports", dir, filename);
}

export function checkDomainMdPresent(key: string): string[] {
  const path = domainMdPath(key);
  return existsSync(path) ? [] : [`missing DOMAIN.md for module "${key}": ${path}`];
}

// ---------------------------------------------------------------------------
// (a) Bijection between `eventSchema`'s union branches and `eventSchemas`.
// Closes the set BOTH ways, by reference, deduped on both sides — a schema
// object registered under two type strings (cricket.ball/superover.ball
// share one payload shape) is one branch, not two, so raw key-count would be
// the wrong invariant; set cardinality plus double-containment is not.
// ---------------------------------------------------------------------------

function unionOptionsOf(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const options = (schema as unknown as { options?: unknown }).options;
  if (!Array.isArray(options)) {
    throw new Error("module.eventSchema must be a z.union(...) for padSpec conformance to introspect its branches");
  }
  return options as z.ZodTypeAny[];
}

export function checkEventSchemasBijection(
  eventSchema: z.ZodTypeAny,
  eventSchemas: Readonly<Record<string, z.ZodTypeAny>>,
): string[] {
  const problems: string[] = [];
  const options = new Set(unionOptionsOf(eventSchema));
  const registered = new Set(Object.values(eventSchemas));
  if (options.size !== registered.size) {
    problems.push(
      `eventSchema has ${options.size} distinct union branch(es) but eventSchemas registers ${registered.size} ` +
        `distinct schema object(s) by reference — every branch must be registered under at least one type ` +
        `string, and every registered schema must be one of eventSchema's actual branches (the SAME object, ` +
        `not a freshly-built equivalent shape)`,
    );
  }
  for (const option of options) {
    if (!registered.has(option)) {
      problems.push("an eventSchema union branch is not present in eventSchemas by reference — unreachable from any action");
    }
  }
  for (const schema of registered) {
    if (!options.has(schema)) {
      problems.push("an eventSchemas entry is not one of eventSchema's union branches by reference — points at a schema object eventSchema never accepts");
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// (a) Coverage — every registered type reached by >=1 action, and no action
// names a type outside the registry. This is the check the MUTATION PROOF
// (deleting one action from a real module's spec) is expected to fail.
// ---------------------------------------------------------------------------

export function checkActionCoverage(spec: PadSpec, eventSchemas: Readonly<Record<string, z.ZodTypeAny>>): string[] {
  const problems: string[] = [];
  const actionTypes = new Set<string>();
  for (const panel of spec.panels) for (const action of panel.actions) actionTypes.add(action.type);
  for (const type of Object.keys(eventSchemas)) {
    if (!actionTypes.has(type)) {
      problems.push(`eventSchemas["${type}"] is reachable from no action in padSpec`);
    }
  }
  for (const type of actionTypes) {
    if (!(type in eventSchemas)) {
      problems.push(`an action declares type "${type}", which is not a key in eventSchemas`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// (a) Behavioral proof — for every REGISTERED type, feed a bare envelope
// through the module's real apply(), from init, and confirm dispatch
// recognises the type string. Catches the reverse drift a purely structural
// bijection cannot: a registry key that is a typo, pointing at an otherwise
// legitimate schema object some OTHER real type also uses, so it would pass
// the reference bijection above yet never actually dispatch. The payload is
// deliberately the emptiest possible ({}) — this check is not about whether
// the payload is VALID (property test (b) owns that), only about whether the
// TYPE STRING is real. A domain-specific refusal (wrong phase, invalid
// payload shape) is expected and not flagged; only the dispatch switch's own
// "unknown event type" fallthrough is.
// ---------------------------------------------------------------------------

const UNKNOWN_EVENT_TYPE = /unknown\s+(?:\S+\s+)?event type/i;

export function checkRegisteredTypesDispatch<Cfg, Ev, State>(
  module: SportModule<Cfg, Ev, State>,
  cfg: Cfg,
  lineups: LineupPair,
  eventSchemas: Readonly<Record<string, z.ZodTypeAny>>,
): string[] {
  const problems: string[] = [];
  for (const type of Object.keys(eventSchemas)) {
    const state = module.init(cfg, lineups);
    const envelope = makeEnvelope(0, { type, payload: {} }) as EventEnvelope<Ev | CoreEv>;
    try {
      module.apply(state, envelope);
    } catch (err) {
      if (err instanceof EngineError && UNKNOWN_EVENT_TYPE.test(err.message)) {
        problems.push(
          `eventSchemas["${type}"] is registered but module.apply() rejects "${type}" as an unknown event type — a registry/dispatch drift`,
        );
      }
      // Any other throw (WRONG_PHASE, "invalid X payload", …) is a domain
      // refusal of the deliberately-empty sample payload, not a drift.
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// (b) Every action property-generates payloads eventSchema accepts, across
// its declared field bounds. `fields` + `attribution` are the SAME
// declaration `buildPathObject` (S10, eventually) turns collected form
// values into a real payload from — this property test is therefore proving
// the exact mechanism the renderer will use, not a parallel one.
// ---------------------------------------------------------------------------

function fieldArbitrary(field: PadField): fc.Arbitrary<PadFieldValue> {
  switch (field.kind) {
    case "enum":
      return fc.constantFrom(...field.values);
    case "number":
      return fc.integer({ min: field.min, max: field.max });
    case "toggle":
      return fc.boolean();
  }
}

function attributionArbitrary(
  attribution: PadAttribution,
  entrantIds: readonly [string, string],
  personPool: readonly string[],
): fc.Arbitrary<readonly (readonly [string, unknown])[]> {
  const persons = personPool.length > 0 ? personPool : ["p1"];
  switch (attribution.kind) {
    case "none":
      return fc.constant([]);
    case "side":
      return fc.constantFrom(...entrantIds).map((id) => [[attribution.path, id]] as const);
    case "person":
      return fc.constantFrom(...persons).map((id) => [[attribution.path, id]] as const);
    case "persons":
      return fc
        .tuple(...attribution.paths.map(() => fc.constantFrom(...persons)))
        .map((ids) => attribution.paths.map((path, i) => [path, ids[i]] as const));
  }
}

function actionPayloadArbitrary(
  action: PadAction,
  entrantIds: readonly [string, string],
  personPool: readonly string[],
): fc.Arbitrary<unknown> {
  const shape: Record<string, fc.Arbitrary<PadFieldValue>> = {};
  for (const field of action.fields) shape[field.path] = fieldArbitrary(field);
  return fc
    .tuple(fc.record(shape), attributionArbitrary(action.attribution, entrantIds, personPool))
    .map(([values, attrEntries]) => buildPathObject([...Object.entries(values), ...attrEntries]));
}

/** Throws (via `fc.assert`) rather than returning a violation list, so a
 *  failure keeps fast-check's shrunk counterexample and issue detail. */
export function checkActionPayloadsAccepted(
  spec: PadSpec,
  eventSchemas: Readonly<Record<string, z.ZodTypeAny>>,
  entrantIds: readonly [string, string],
  personPool: readonly string[],
  numRuns: number,
): void {
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      const schema = eventSchemas[action.type];
      if (schema === undefined) continue; // reported by checkActionCoverage
      const arb = actionPayloadArbitrary(action, entrantIds, personPool);
      fc.assert(
        fc.property(arb, (payload) => {
          const result = schema.safeParse(payload);
          if (!result.success) {
            throw new Error(
              `action "${action.type}" (${action.labelKey.key}) built a payload eventSchemas rejects: ` +
                `${JSON.stringify(payload)} — ${result.error.issues.map((issue) => issue.message).join("; ")}`,
            );
          }
        }),
        { numRuns },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// (c) Label keys unique within the module — across BOTH panels and actions,
// since both render from the same dictionary namespace.
// ---------------------------------------------------------------------------

export function checkLabelKeysUnique(spec: PadSpec): string[] {
  const seen = new Map<string, number>();
  for (const panel of spec.panels) {
    seen.set(panel.labelKey.key, (seen.get(panel.labelKey.key) ?? 0) + 1);
    for (const action of panel.actions) {
      seen.set(action.labelKey.key, (seen.get(action.labelKey.key) ?? 0) + 1);
    }
  }
  const problems: string[] = [];
  for (const [key, count] of seen) {
    if (count > 1) problems.push(`labelKey "${key}" is declared ${count} times — label keys must be unique within a module's padSpec`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// (d) Fidelity — every registered type has exactly one band on the closed
// 0-3 scale, and nesting holds BY CONSTRUCTION (a lower band's event set is
// always a subset of a higher band's), asserted generically rather than as
// hardcoded pairs so a module declaring only bands 0/1 (carrom, later) is
// exercised the same way as one declaring 0-3 (cricket).
// ---------------------------------------------------------------------------

const VALID_BANDS: readonly FidelityBand[] = [0, 1, 2, 3];

/** Every event type at or below `band`. Exported: this IS the "nesting is
 *  structural" property the S6 fidelity-model redesign exists to guarantee —
 *  callers (and this file's own test) can assert monotonicity generically
 *  rather than trusting a comment. */
export function eventsAtOrBelowBand(fidelity: Readonly<Record<string, FidelityBand>>, band: FidelityBand): Set<string> {
  return new Set(Object.entries(fidelity).filter(([, b]) => b <= band).map(([type]) => type));
}

export function checkFidelityMap(spec: PadSpec, eventSchemas: Readonly<Record<string, z.ZodTypeAny>>): string[] {
  const problems: string[] = [];
  const registered = new Set(Object.keys(eventSchemas));
  const banded = new Set(Object.keys(spec.fidelity));
  for (const type of registered) {
    if (!banded.has(type)) problems.push(`event type "${type}" has no fidelity band — every registered type needs exactly one`);
  }
  for (const type of banded) {
    if (!registered.has(type)) problems.push(`fidelity bands "${type}", which is not a registered event type`);
  }
  for (const [type, band] of Object.entries(spec.fidelity)) {
    if (!VALID_BANDS.includes(band)) {
      problems.push(`event type "${type}" declares fidelity band ${String(band)}, outside the closed 0-3 scale`);
    }
  }
  for (const bandKey of Object.keys(spec.fidelityEntitlements)) {
    if (!VALID_BANDS.includes(Number(bandKey) as FidelityBand) || String(Number(bandKey)) !== bandKey) {
      problems.push(`fidelityEntitlements declares a key outside the closed 0-3 scale: "${bandKey}"`);
    }
  }
  if (problems.length > 0) return problems; // nesting is meaningless over a malformed map

  // Nesting — structural by construction (band <= i implies band <= j for
  // i <= j), so this can only ever fail if the bookkeeping above regresses.
  // Asserted anyway, generically over whichever bands this module actually
  // declares, as the property the redesign exists to guarantee rather than
  // merely a comment's claim.
  const declaredBands = [...new Set(Object.values(spec.fidelity))].sort((a, b) => a - b);
  for (let i = 1; i < declaredBands.length; i++) {
    const lowerBand = declaredBands[i - 1] as FidelityBand;
    const upperBand = declaredBands[i] as FidelityBand;
    const lower = eventsAtOrBelowBand(spec.fidelity, lowerBand);
    const upper = eventsAtOrBelowBand(spec.fidelity, upperBand);
    for (const type of lower) {
      if (!upper.has(type)) {
        problems.push(`fidelity nesting broken: "${type}" is at or below band ${lowerBand} but not at or below band ${upperBand}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// padSpec is total and deterministic — never throws for any cfg its own
// `configSchema` accepts (not just the named variant presets), and two calls
// with the same cfg produce byte-identical output. The JSON round-trip
// equality is not redundant with the determinism check: it is what proves
// PadSpec really is pure data — a function value anywhere in the tree would
// vanish silently under `JSON.stringify` and this would catch it even if
// both calls "agreed" (both missing the same key).
// ---------------------------------------------------------------------------

export function checkTotalDeterministicAndPureData<Cfg>(
  padSpecFn: (cfg: Cfg) => PadSpec,
  configSchema: z.ZodType<Cfg>,
  baseCfg: Record<string, unknown>,
  variants: Record<string, Partial<Cfg>>,
  cfgPerturbations: fc.Arbitrary<Record<string, unknown>>,
  numRuns: number,
): void {
  const presets: readonly (readonly [string, Partial<Cfg>])[] = [["default", {}], ...Object.entries(variants)];
  fc.assert(
    fc.property(fc.constantFrom(...presets), cfgPerturbations, ([, preset], override) => {
      const raw = { ...baseCfg, ...preset, ...override };
      const parsed = configSchema.safeParse(raw);
      if (!parsed.success) return; // not a cfg this module accepts — not padSpec's problem
      const a = padSpecFn(parsed.data);
      const b = padSpecFn(parsed.data);
      expect(a).toEqual(b);
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }),
    { numRuns },
  );
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

/** Whether a module has wired both S6 fields — a TS type predicate, so the
 *  `if (!isPadReady(module))` guard below actually narrows `module.padSpec`/
 *  `module.eventSchemas` to non-optional for the rest of the function, with
 *  no redundant second check. Pulled out of the guard clause so it is also
 *  directly unit-testable on its own: `padSpecConformanceSuite` itself
 *  registers real vitest tests as a side effect, including a deliberately
 *  FAILING one for an unwired module, which makes IT the wrong thing to
 *  invoke from inside this file's own tests (a permanent suite has no room
 *  for an expected-red test). */
export function isPadReady<Cfg, Ev, State>(
  module: SportModule<Cfg, Ev, State>,
): module is SportModule<Cfg, Ev, State> & {
  padSpec: (cfg: Cfg) => PadSpec;
  eventSchemas: Readonly<Record<string, z.ZodTypeAny>>;
} {
  return module.padSpec !== undefined && module.eventSchemas !== undefined;
}

export interface PadConformanceOpts {
  cfg?: unknown;
  lineups?: LineupPair;
  numRuns?: number;
  label?: string;
  /** Cfg perturbations (raw, pre-parse), merged over each named variant
   *  preset, for the total/deterministic property. Default: the identity —
   *  every module gets baseline coverage from its presets alone; supply a
   *  richer generator when `padSpec` branches on more cfg than the named
   *  variants alone exercise. */
  cfgPerturbations?: fc.Arbitrary<Record<string, unknown>>;
  /** Overrides the person-id pool the action-payload property test draws
   *  attribution from. Default: every slot in `lineups`. */
  personPool?: readonly string[];
}

export function padSpecConformanceSuite<Cfg, Ev, State>(
  module: SportModule<Cfg, Ev, State>,
  opts: PadConformanceOpts = {},
): void {
  const suiteName = `padSpec conformance — ${module.key}@${module.version}${opts.label ? ` (${opts.label})` : ""}`;

  // A module that has not wired padSpec/eventSchemas yet must fail LOUDLY —
  // one named, readable test — rather than throw during collection (which
  // reads as `total: 0, failed: 0`, this repo's own documented false-green
  // shape) or silently register nothing.
  if (!isPadReady(module)) {
    describe(suiteName, () => {
      it("declares padSpec and eventSchemas", () => {
        expect({
          padSpec: module.padSpec !== undefined,
          eventSchemas: module.eventSchemas !== undefined,
        }).toEqual({ padSpec: true, eventSchemas: true });
      });
    });
    return;
  }

  const padSpecFn = module.padSpec;
  const eventSchemas = module.eventSchemas;
  const rawCfg = (opts.cfg ?? {}) as Record<string, unknown>;
  const cfg = module.configSchema.parse(rawCfg);
  const catalog = resolvePositions(module, cfg);
  const lineups = opts.lineups ?? defaultLineupPair(catalog);
  const entrantIds: readonly [string, string] = [lineups.home.entrantId, lineups.away.entrantId];
  const personPool = opts.personPool ?? [...lineups.home.slots, ...lineups.away.slots].map((slot) => slot.personId);
  const numRuns = opts.numRuns ?? 200;
  const spec = padSpecFn(cfg);

  describe(suiteName, () => {
    it("(a) every eventSchema union branch is registered and reachable from some action", () => {
      const problems = [
        ...checkEventSchemasBijection(module.eventSchema, eventSchemas),
        ...checkActionCoverage(spec, eventSchemas),
        ...checkRegisteredTypesDispatch(module, cfg, lineups, eventSchemas),
      ];
      expect(problems).toEqual([]);
    });

    it("(b) every action property-generates payloads eventSchema accepts", () => {
      checkActionPayloadsAccepted(spec, eventSchemas, entrantIds, personPool, numRuns);
    });

    it("(c) label keys are unique within the module", () => {
      expect(checkLabelKeysUnique(spec)).toEqual([]);
    });

    it("(d) fidelity bands cover every registered type and nest by construction", () => {
      expect(checkFidelityMap(spec, eventSchemas)).toEqual([]);
    });

    it("(e) DOMAIN.md is present for this module", () => {
      expect(checkDomainMdPresent(module.key)).toEqual([]);
    });

    it("padSpec is total, deterministic and pure data across variants and cfg perturbations", () => {
      checkTotalDeterministicAndPureData(
        padSpecFn,
        module.configSchema,
        rawCfg,
        module.variants,
        opts.cfgPerturbations ?? fc.constant({}),
        numRuns,
      );
    });
  });
}
