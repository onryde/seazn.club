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
  type PadPhase,
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
// (a) Coverage — every registered type reached by >=1 action across the
// checked spec(s), and no action names a type outside the registry. This is
// the check the MUTATION PROOF (deleting one action from a real module's
// spec) is expected to fail.
//
// Takes one spec OR a LIST of specs, on purpose, and is NOT wired into
// `padSpecConformanceSuite`'s own automatic per-cfg "(a)" test below —
// found while wiring cricket's real spec: `cricket.superOver` requires
// `inningsPerSide === 1` and `cricket.followOn`/`.declare` require
// `inningsPerSide === 2` (`CricketCfg`'s own `.refine()`s), so
// `cricket.superover.ball` and `cricket.innings.declare` can NEVER both be
// reachable from one legal cfg — "every branch reachable from some action"
// is a property of the module across its variant space, not of any single
// `padSpec(cfg)` call in isolation. A module's own test file unions the
// specs from the variants it actually tests and calls this once; that is
// what "the full tier hides nothing" (design doc) means in practice.
// ---------------------------------------------------------------------------

export function checkActionCoverage(
  specs: PadSpec | readonly PadSpec[],
  eventSchemas: Readonly<Record<string, z.ZodTypeAny>>,
): string[] {
  // Explicit annotation: `Array.isArray`'s built-in type predicate is
  // `arg is any[]`, which otherwise leaks `any` into the inferred type of
  // `specList` (and every field access below it) rather than narrowing to
  // `readonly PadSpec[]`.
  const specList: readonly PadSpec[] = Array.isArray(specs) ? specs : [specs];
  const problems: string[] = [];
  const actionTypes = new Set<string>();
  for (const spec of specList) {
    for (const panel of spec.panels) for (const action of panel.actions) actionTypes.add(action.type);
  }
  for (const type of Object.keys(eventSchemas)) {
    if (!actionTypes.has(type)) {
      problems.push(`eventSchemas["${type}"] is reachable from no action across the checked padSpec(s)`);
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

function attributionItemArbitrary(
  item: PadAttribution[number],
  entrantIds: readonly [string, string],
  persons: readonly string[],
): fc.Arbitrary<readonly [string, unknown]> {
  const pool = item.kind === "side" ? entrantIds : persons;
  return fc.constantFrom(...pool).map((id) => [item.path, id] as const);
}

/** Every item independently resolved — `fc.tuple` over a LIST of
 *  arbitraries, one per attribution item, so an action needing a side AND
 *  two persons (`cricket.review`) gets all three, each at its own path. */
function attributionArbitrary(
  attribution: PadAttribution,
  entrantIds: readonly [string, string],
  personPool: readonly string[],
): fc.Arbitrary<readonly (readonly [string, unknown])[]> {
  const persons = personPool.length > 0 ? personPool : ["p1"];
  if (attribution.length === 0) return fc.constant([]);
  return fc.tuple(...attribution.map((item) => attributionItemArbitrary(item, entrantIds, persons)));
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
// (c) Label keys unique within the module — across panels, actions AND (S7/
// #427) the optional per-field / per-attribution-item labels, since all four
// render from the same dictionary namespace. Extending the SAME check rather
// than adding a second, weaker one: a field key that collides with an action
// key is the identical defect (one dictionary entry, two meanings, and the
// translator sees one string).
//
// R7/generic — ONE narrow exception, added when `generic`'s padSpec started
// declaring the same panel/action once per phase (`everyPhase`,
// sports/generic/generic.ts, closing the "pad offers what the engine
// refuses" defect for "pre"): a key may recur ONLY as the byte-identical
// declaration restated for a DIFFERENT phase. Two occurrences of one key
// that disagree on what they label, or that repeat for the SAME phase, are
// still exactly the collision this check has always caught — see
// `checkLabelKeysUnique` below for the precise rule.
// ---------------------------------------------------------------------------

/** Every declared label on a spec, tagged by where it sits. `undefined`
 *  labels (an unlabelled field — the common case, see `PadFieldEnum`'s doc
 *  comment) are simply absent from the result, never a hole. */
export interface PadLabelRef {
  key: string;
  label: string;
  where: "panel" | "action" | "field" | "attribution";
  /** The owning action's event type; absent for a panel's own label. */
  type?: string;
  /** The owning field's / attribution item's payload path. */
  path?: string;
}

/** `collectPadLabels`'s own refs, plus the phase of the panel each was
 *  declared under. INTERNAL to this file — `checkLabelKeysUnique` is the
 *  only reader, so the phase never leaks into the public `PadLabelRef`
 *  shape `padItemLabelKey` callers already assert on exactly (adding a
 *  field there would break every existing `toEqual` on its result). */
interface PhasedPadLabelRef extends PadLabelRef {
  phase: PadPhase;
}

function collectPhasedPadLabels(spec: PadSpec): PhasedPadLabelRef[] {
  const out: PhasedPadLabelRef[] = [];
  for (const panel of spec.panels) {
    out.push({ ...panel.labelKey, where: "panel", phase: panel.phase });
    for (const action of panel.actions) {
      out.push({ ...action.labelKey, where: "action", type: action.type, phase: panel.phase });
      for (const field of action.fields) {
        if (field.labelKey) {
          out.push({ ...field.labelKey, where: "field", type: action.type, path: field.path, phase: panel.phase });
        }
      }
      for (const item of action.attribution) {
        if (item.labelKey) {
          out.push({ ...item.labelKey, where: "attribution", type: action.type, path: item.path, phase: panel.phase });
        }
      }
    }
  }
  return out;
}

export function collectPadLabels(spec: PadSpec): PadLabelRef[] {
  return collectPhasedPadLabels(spec).map(({ phase: _phase, ...ref }) => ref);
}

/** The label a given action declares for one of its fields or attribution
 *  items, by payload path. `undefined` = that item carries no label (legal)
 *  or the action/path pair does not exist (which the caller's own coverage
 *  assertions catch). Exported so each sport's padspec test asks the question
 *  the same way instead of re-walking the tree four times. */
export function padItemLabelKey(spec: PadSpec, type: string, path: string): PadLabelRef | undefined {
  return collectPadLabels(spec).find(
    (ref) => ref.type === type && ref.path === path && (ref.where === "field" || ref.where === "attribution"),
  );
}

export function checkLabelKeysUnique(spec: PadSpec): string[] {
  const byKey = new Map<string, PhasedPadLabelRef[]>();
  for (const ref of collectPhasedPadLabels(spec)) {
    const bucket = byKey.get(ref.key) ?? [];
    bucket.push(ref);
    byKey.set(ref.key, bucket);
  }
  const problems: string[] = [];
  for (const [key, refs] of byKey) {
    if (refs.length <= 1) continue;
    // R7/generic — a key may now legitimately recur, but ONLY as the exact
    // same declaration restated once per phase (`everyPhase` in
    // sports/generic/generic.ts: the same panel/action offered at both
    // "pre" and "live", so a scorer who never taps "Start match" still
    // reaches everything a started fixture reaches). Every occurrence must
    // agree on what it labels (`label`/`where`/`type`/`path`) AND no two
    // occurrences may share a phase — two panels re-declaring one key for
    // the SAME phase is still the original copy-paste collision this check
    // exists to catch, not a phase pairing. Anything else stays exactly as
    // strict as before.
    const first = refs[0]!;
    const phases = new Set(refs.map((ref) => ref.phase));
    const isPhasePairing =
      phases.size === refs.length &&
      refs.every(
        (ref) => ref.label === first.label && ref.where === first.where && ref.type === first.type && ref.path === first.path,
      );
    if (!isPhasePairing) {
      problems.push(`labelKey "${key}" is declared ${refs.length} times — label keys must be unique within a module's padSpec`);
    }
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
    // (a), cfg-independent half: the registry is a true bijection onto
    // eventSchema's branches, and every registered type is a real dispatch
    // case. Deliberately does NOT also assert action-coverage for THIS one
    // cfg — see `checkActionCoverage`'s own comment for why that is a
    // module-level property (some branches are mutually exclusive by format,
    // cricket's superOver vs 2-innings cfgs being the discovered case) that
    // the calling module's test file checks once, across its variants.
    it("(a) eventSchemas is a bijection onto eventSchema's branches, and every registered type really dispatches", () => {
      const problems = [
        ...checkEventSchemasBijection(module.eventSchema, eventSchemas),
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
