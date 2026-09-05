// SportModule contract — spec 03 §3, extended by
// doc 13 §1 (officialLabel) and the conformance kit's needs (PROMPT-03 §4:
// declaredPointsSets; arbitraryEvent/coarsen hooks from spec 03 §6 + §9.6).
import { z } from "zod";
import type { CoreEv, EventEnvelope, FoldableModule, FoldContext } from "../core/events.ts";
import type { LineupPolicy, SquadState } from "../core/lineup.ts";
import type { MatchPosition } from "../core/position.ts";
import type { Rng } from "../core/rng.ts";
import type {
  DisciplineModel,
  LineupPair,
  MatchOutcome,
  MetricSpec,
  ScoreSummary,
  StageCtx,
  StageKind,
  StandingsDelta,
} from "../core/types.ts";
import type { PositionCatalog } from "./catalog.ts";
import type { DocSection } from "../exports/types.ts";
import { resolvePayloadPath, type PlayerStatsModel } from "../stats/stats.ts";
import type { EntrantModel } from "./entrant-model.ts";

// Jul3/06 §3 — what a print fragment gets to work with (display labels only;
// TBD feeds arrive pre-rendered as "Winner of QF1").
export interface ScoresheetInput {
  home: string;
  away: string;
  homeColor?: string;
  awayColor?: string;
  at?: string;
  court?: string;
  stageName?: string;
  /** Blank scoresheet for manual filling (Jul3/06 §7). */
  blank?: boolean;
}

// doc 05 §4.1 — comparator keys resolved by the competition engine's
// tiebreaker registry (lands in PROMPT-08); modules declare their official
// cascade with these.
export type TiebreakerKey =
  | "points"
  | "wins"
  | "h2h_points"
  | "h2h_diff"
  | "h2h_for"
  | "diff"
  | "for"
  | "nrr"
  | "set_ratio"
  | "game_ratio"
  | "board_ratio"
  | "point_ratio"
  | "buchholz"
  | "buchholz_cut1"
  | "sberger"
  | "direct"
  | "fair_play"
  | "seed"
  | "lots";

// A type + payload pair before persistence stamps the envelope fields
// (id/seq/recordedAt) — what generators and coarsen produce.
export interface ModuleEvent<Ev = unknown> {
  type: string;
  payload: Ev | CoreEv;
}

// ---------------------------------------------------------------------------
// S6/#416 (W5) — PadSpec: a pure, serialisable description of a sport's
// scoring surface. One universal renderer (S10) walks any module's spec
// without per-sport code; conformance (testkit/conformance-pad.ts) proves the
// spec hides nothing that `eventSchema` accepts.
//
// EVERYTHING BELOW IS DATA — no functions anywhere in the PadSpec tree. That
// is a deliberate, stronger reading of "PadSpec is data only, no React, no
// display strings" than the design doc states explicitly: a function value
// would (a) vanish silently under `JSON.stringify`, which is how this file's
// own conformance suite proves `padSpec(cfg)` is byte-identical for a
// repeated call, and (b) be exactly the un-serialisable closure the gate DSL
// below exists to avoid. `PadAction` therefore carries no payload-building
// callback: `buildPathObject` (below) is the ONE function — shared by the
// engine's own property test and S10's renderer — that turns declared
// fields + resolved attribution into a real event payload, so the two sides
// can never build a differently-shaped object from the same declaration
// (this repo's recurring placer/verifier fork, closed structurally).
// ---------------------------------------------------------------------------

/**
 * `fidelity` names ONE detail band (0–3) per event type. Since W1 of the
 * entitlements v18 programme (2026-09) it is a UX filter only — the scorer
 * picks how much detail to record, and the pad hides tiles above that band.
 * No band is paywalled and nothing in apps/web reads an entitlement from it.
 * The 0–3 scale is closed (v2 ruling); its semantics live in this file.
 */
export const FIDELITY = { 0: "result", 1: "card", 2: "timeline", 3: "detail" } as const;
export type FidelityBand = 0 | 1 | 2 | 3;

/**
 * Stable dictionary lookup key + English fallback — the SAME `{key, label}`
 * shape `PositionSegment` already established (`core/position.ts:62-74`),
 * reused rather than reinvented: `key` is what a web dictionary resolves (S7
 * translates exactly these — label keys are effectively API the moment they
 * ship), `label` is the English fallback so an engine-side test, or any
 * surface not yet wired to a dictionary, still has legible text. Unlike a
 * position segment's `label`, this one is NOT optional: an action or panel
 * has no self-naming "value" the way a clock reading "12:41" names itself.
 */
export interface PadLabel {
  key: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Gate predicates. S10 evaluates these IN THE BROWSER (spec: gate predicates
// over folded state/summary — "the super-over panel appears only when
// reachable"), so a predicate cannot be an arbitrary JS closure: it can
// neither cross the engine/web boundary as data nor be compared for the
// determinism property below. A tiny closed DSL plus ONE evaluator, shipped
// from the engine, is the structural fix for this repo's recurring
// placer/verifier fork — the engine's own conformance test and S10's
// renderer import and call the exact same `evalPadGate`, so "should this
// panel show right now" can never compute two different answers on the two
// sides of the wire.
//
// A cfg-only condition (the DLS panel existing at all when `cfg.dls.enabled`)
// needs NO gate: `padSpec(cfg)` is already a pure function of cfg, so the
// module simply omits the panel from the array it returns. Gates exist only
// for conditions that depend on how the match has actually folded so far —
// genuinely unknowable at `padSpec(cfg)` construction time.
// ---------------------------------------------------------------------------
export type PadGate =
  | { op: "always" }
  | { op: "path-truthy"; path: string }
  | { op: "path-equals"; path: string; value: string | number | boolean | null }
  | { op: "and"; of: readonly PadGate[] }
  | { op: "or"; of: readonly PadGate[] }
  | { op: "not"; of: PadGate };

export interface PadGateCtx {
  readonly state: unknown;
  readonly summary: unknown;
}

/**
 * The one evaluator both sides call. `path` is rooted at `{state, summary}`
 * (so `"state.phase"`, never a bare `"phase"`) and walked with
 * `resolvePayloadPath` (`stats/stats.ts`) — the SAME safe dotted-path reader
 * player-stat metrics already use, reused rather than duplicated: a path
 * that does not resolve reads as `undefined` (falsy, and equal to nothing
 * `path-equals` would sensibly compare against), never throws.
 */
export function evalPadGate(gate: PadGate, ctx: PadGateCtx): boolean {
  const root: Record<string, unknown> = { state: ctx.state, summary: ctx.summary };
  switch (gate.op) {
    case "always":
      return true;
    case "path-truthy":
      return Boolean(resolvePayloadPath(root, gate.path));
    case "path-equals":
      return resolvePayloadPath(root, gate.path) === gate.value;
    case "and":
      return gate.of.every((g) => evalPadGate(g, ctx));
    case "or":
      return gate.of.some((g) => evalPadGate(g, ctx));
    case "not":
      return !evalPadGate(gate.of, ctx);
  }
}

// ---------------------------------------------------------------------------
// Actions — each names exactly one `eventSchema` union branch, via the
// per-module `eventSchemas` registry below (`SportModule.eventSchemas`).
// "1:1" reads as "every action names one branch", not "every branch gets
// exactly one action": several actions may legitimately target the same
// branch (a bare runs field and a "wide" button both emit `cricket.ball`
// with different populated sub-fields) — conformance criterion (a) only
// requires that EVERY branch is reached by at least one action.
// ---------------------------------------------------------------------------

export type PadFieldValue = string | number | boolean;

/**
 * S7/#427 — what a control is CALLED. `PadAction`/`PadPanel` have carried a
 * required `labelKey` since S6; a field and an attribution item had none at
 * all, so a number input, a toggle and a person picker were nameless and
 * S10's renderer would have had exactly two options: invent English in the
 * web layer (the hardcoded-string defect `scoring-vocab.ts` exists to
 * prevent) or print the dotted `path` at a scorer.
 *
 * OPTIONAL, unlike the action/panel one, and the asymmetry is deliberate. An
 * action always needs a name — it is a button. A field frequently does not:
 * cricket's `runs.bat` sits inside a labelled "Ball" action whose whole
 * layout names it, and volleyball's `home`/`away` set-score pair are named by
 * the two entrants either side of them. Requiring a key everywhere would mint
 * dozens of dictionary entries no surface will ever draw, and translating
 * copy nothing renders is exactly the waste #427 exists to stop. So: label
 * the ones a scorer would otherwise have to guess at, leave the rest.
 *
 * KEY CONVENTION (extends S6's `pad.<sport>.action.<action>` /
 * `pad.<sport>.panel.<panel>`): `pad.<sport>.action.<action>.field.<name>`,
 * scoped by the ACTION rather than by the payload path, so two actions that
 * collect the same path can still word it differently and
 * `checkLabelKeysUnique` stays a real check rather than a false alarm.
 */
export interface PadFieldEnum {
  kind: "enum";
  /** Dotted path into the built payload (`buildPathObject`'s target). */
  path: string;
  /** Bounds — derived from cfg where the sport has one (never hardcoded from
   *  a single preset: the classic case is a dismissal-kind list that differs
   *  by variant). */
  values: readonly string[];
  labelKey?: PadLabel;
  /** Owner ruling 12, S18 — render this field's values as a chip row (one
   *  button per value, `data-value`, ≥44px) instead of the default `<select>`.
   *  Absent/false keeps every existing enum field's rendering byte-identical;
   *  this is data the module declares, never a renderer decision keyed off
   *  `path` (the renderer still has ZERO per-path branching — see
   *  action-form.tsx's own header). Cricket sets this on
   *  `batting.dismissal.kind` only. */
  chips?: boolean;
  /** Owner ruling 12, S18 — same meaning as `PadFieldNumber.optional` below,
   *  restated here because `PadField` is a discriminated union and each
   *  member carries its own copy of the flag. */
  optional?: boolean;
}
export interface PadFieldNumber {
  kind: "number";
  path: string;
  min: number;
  max: number;
  step?: number;
  labelKey?: PadLabel;
  /** Owner ruling 12, S18 — a DIFFERENT, hand-authored flag from anything
   *  schema-derived (mirrors `PadAttributionItem.optional`'s own doc comment
   *  below, which explains the pattern in full): `checkActionValidity`
   *  (view-model.ts) does not gate Confirm on this field being set. Absent
   *  means "required, same as every field before this flag existed" — no
   *  existing field changes behaviour. Cricket sets this on the six band-2
   *  enrichment fields `cricket.player.line` gained (S17): `batting.fours`,
   *  `.sixes`, `.dismissal.kind`, `bowling.maidens`, `.wides`, `.noBalls` —
   *  the ORIGINAL seven fields on that same action stay unmarked (still
   *  required), which is what keeps the legacy 7-field payload reachable
   *  from the pad with nothing new touched. */
  optional?: boolean;
}
export interface PadFieldToggle {
  kind: "toggle";
  path: string;
  labelKey?: PadLabel;
  /** See `PadFieldNumber.optional`. No shipped toggle field uses this yet —
   *  present for union symmetry, so `checkActionValidity` can read
   *  `field.optional` generically without a per-kind type narrow. */
  optional?: boolean;
}
export type PadField = PadFieldEnum | PadFieldNumber | PadFieldToggle;

/**
 * One person/side destination the renderer's attribution picker must collect
 * before an action can fire, and where the resolved id lands in the built
 * payload. `labelKey` is optional for the same reason a field's is — see
 * `PadFieldEnum` above.
 */
/**
 * R8/WS-B — whether the renderer must collect a value here before the
 * action can fire. `undefined` reads as "not yet stamped" (only a padSpec
 * that has NOT been run through `stampAttributionRequired` below, which is
 * a build-time bug — every module's `padSpec(cfg)` runs its whole spec
 * through the stamp before returning). ALWAYS derived from the action's
 * own payload schema (`isPathRequired`/`stampAttributionRequired`), never
 * hand-typed per sport — memory rule #19: a value typed into a table
 * drifts from the source of truth the moment the schema changes under it.
 *
 * `optional` (owner ruling 12, S17) is a DIFFERENT, hand-authored flag: a
 * sport declares it directly (never derived, never stamped) to mark an
 * attribution item the picker may skip even though the underlying payload
 * key happens to be optional in the schema too. It is not a restatement of
 * `!required` — a module could in principle attach `optional: true` to an
 * item whose path resolves required (the picker would then be wrong to
 * skip it; that is a sport-authoring bug, not something this type prevents)
 * — but every item the pad declares `optional` on today also resolves
 * `required: false`, e.g. cricket's `batting.dismissal.bowler`/`.fielder`.
 * Absent means "required, same as before this flag existed" — no existing
 * item changes behaviour.
 *
 * `requiresField` (owner ruling 12, S18) — ANOTHER hand-authored flag,
 * independent of `optional`/`required`: a dotted `PadField` path that must
 * also be set for this item's collected value to survive into the built
 * payload. `buildActionPayload` (view-model.ts) drops this item's value
 * (builds it as `undefined`, which `buildPathObject` then omits) whenever
 * the named field is unset — regardless of what the scorer tapped, and
 * regardless of the order fields/attribution were filled in. This exists
 * because a nested object can have one member REQUIRED alongside others
 * that are optional (cricket's `batting.dismissal` needs `kind`; `bowler`/
 * `fielder` are optional siblings) — three independent `PadField`/
 * `PadAttribution` entries with no schema-level relationship view-model.ts
 * could otherwise see (this file's own module-level note: view-model.ts
 * never reads a module's zod `eventSchemas`). Without this gate, a scorer
 * who tapped a bowler/fielder chip before ever picking a dismissal kind
 * would build `batting.dismissal.{bowler}` with no `kind` — a shape
 * `CricketPlayerLine`'s schema rejects outright (`dismissal.kind` is NOT
 * optional inside that sub-object), turning Confirm into a silent dead end.
 * Absent means "no gating field" — no existing item changes behaviour.
 */
export type PadAttributionItem =
  | { kind: "side"; path: string; labelKey?: PadLabel; required?: boolean; optional?: boolean; requiresField?: string }
  | {
      kind: "person";
      path: string;
      role?: string;
      labelKey?: PadLabel;
      required?: boolean;
      optional?: boolean;
      requiresField?: string;
    };

/**
 * A LIST of attribution requirements, not a single discriminated choice —
 * revised from the brief's restated `none | side | person(role?) | persons(n)`
 * vocabulary while wiring cricket's real actions: `cricket.review` needs a
 * SIDE (`by`) and, independently, up to two OPTIONAL persons (`person`,
 * `against`) on the very same action, which a one-of-four choice cannot
 * express at all without either dropping a real field or splitting one
 * action into several for no product reason. A list composes the same four
 * cases as a special case of "zero or more items" — `none` is `[]`, `side`
 * is one `{kind:"side"}` item, `person(role?)` is one `{kind:"person"}` item,
 * `persons(n)` is n `{kind:"person"}` items at n distinct paths (cricket's
 * wicket action needs up to four: `out`, `fielder`, `fielderAssist`,
 * `incoming`) — while also reaching the side-plus-persons case none of the
 * four could.
 */
export type PadAttribution = readonly PadAttributionItem[];

/**
 * Assemble a payload from `(dottedPath, value)` pairs — the inverse of
 * `resolvePayloadPath`, and deliberately as small: plain object nesting only,
 * no array indexing. `undefined` values are OMITTED rather than written, so
 * an unset optional field (a wicket with no named fielder) is genuinely
 * absent from the built payload — required for the `z.strictObject` payload
 * shapes this engine uses everywhere, which reject an explicit `undefined`
 * on some builds and always reject an unrecognised key.
 *
 * Shared by the engine's own conformance property test (below) and, from
 * S10 on, the renderer that turns collected form values into a real event
 * payload — see the module-level note above.
 */
export function buildPathObject(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of entries) {
    if (value === undefined) continue;
    const segments = path.split(".");
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i] as string;
      const existing = cursor[key];
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        cursor = existing as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        cursor[key] = created;
        cursor = created;
      }
    }
    cursor[segments[segments.length - 1] as string] = value;
  }
  return root;
}

export interface PadAction {
  /** Envelope type string — a key in `SportModule.eventSchemas`. */
  type: string;
  labelKey: PadLabel;
  fields: readonly PadField[];
  attribution: PadAttribution;
}

export type PadPanelLayout = "primary" | "grid" | "drawer" | "perSide";
export type PadPhase = "pre" | "live" | "post";

export interface PadPanel {
  labelKey: PadLabel;
  phase: PadPhase;
  layout: PadPanelLayout;
  actions: readonly PadAction[];
  /** Absent = always shown once its phase is active. A cfg-only condition
   *  needs no gate at all — see the module-level note above. */
  gate?: PadGate;
}

export interface PadSpec {
  panels: readonly PadPanel[];
  /** One band per event type this module can emit — see `FIDELITY` above.
   *  Keys are envelope type strings (the same universe as `eventSchemas`);
   *  every value is on the SAME closed 0–3 scale. */
  fidelity: Readonly<Record<string, FidelityBand>>;
}

// ---------------------------------------------------------------------------
// R8/WS-B (#… "the live dead-end tap") — `isPathRequired`/
// `stampAttributionRequired`: the ONE shared derivation of
// `PadAttributionItem.required` from the action's own payload schema, so no
// sport ever hand-types the flag (memory rule #19 — a value typed into a
// table drifts from the source of truth the moment the schema it claims to
// summarise changes under it). Before this, the pad let a scorer confirm an
// action with a REQUIRED attribution item still unfilled; the engine's
// `z.strictObject` then rejected the payload and the tap dead-ended with no
// explanation (`cricket.toss.wonBy`, `cricket.review.by`, `football.goal.by`
// confirmed live). `required` makes that state unreachable: the renderer
// gates Confirm on every item this derivation calls required.
// ---------------------------------------------------------------------------

/** How many `.optional()`/`.nullable()`/`.default()` hops `objectShapeOf`
 *  will peel before giving up. A real payload schema never nests more than
 *  one or two modifiers deep; the bound exists so a pathological or
 *  self-referential schema fails loudly instead of hanging. */
const MAX_WRAPPER_HOPS = 8;

/**
 * The outcome of looking for an object `.shape` under `t`. A discriminated
 * result rather than `Record | undefined` because the two ways of NOT
 * finding one are different faults with different repairs, and R8's branch
 * review found them collapsed into a single (and, for one of them, false)
 * "no field found" diagnosis at the `isPathRequired` call below:
 *
 *   - `not-object`  — `t` is a leaf (a `z.string()`, say). Nothing can be
 *     resolved beneath it; the path is asking the wrong question.
 *   - `too-deep`    — `t` DOES wrap an object, just further down than
 *     `MAX_WRAPPER_HOPS`. The field the caller named may well exist; the
 *     walk simply gave up before it could see it, so reporting it as
 *     missing is a false statement about the schema.
 */
type ObjectShapeLookup =
  | { readonly kind: "shape"; readonly shape: Record<string, z.ZodTypeAny> }
  | { readonly kind: "not-object" }
  | { readonly kind: "too-deep" };

/**
 * Peels `.optional()`/`.nullable()`/`.default()` wrappers (anything with a
 * zod `.unwrap()`) off `t` until a plain object with a `.shape` is reached.
 * See `ObjectShapeLookup` for the two distinct failure outcomes.
 */
function objectShapeOf(t: z.ZodTypeAny): ObjectShapeLookup {
  let cursor: unknown = t;
  for (let hops = 0; hops < MAX_WRAPPER_HOPS; hops++) {
    const shaped = cursor as { shape?: unknown };
    if (shaped !== null && typeof shaped === "object" && shaped.shape !== undefined && typeof shaped.shape === "object") {
      return { kind: "shape", shape: shaped.shape as Record<string, z.ZodTypeAny> };
    }
    const wrapped = cursor as { unwrap?: () => z.ZodTypeAny };
    if (typeof wrapped.unwrap === "function") {
      cursor = wrapped.unwrap();
      continue;
    }
    return { kind: "not-object" };
  }
  // Still unwrappable after the bound: an object may well be down there.
  return { kind: "too-deep" };
}

/**
 * Whether the payload key at dotted `path` is REQUIRED (non-optional) in
 * `schema` — the single source of truth `PadAttributionItem.required` (and
 * `stampAttributionRequired` below) derive from, so the flag can never drift
 * from the real payload schema (memory rule #19).
 *
 * Walks the schema segment by segment; only the LEAF segment's own
 * optionality is checked. An intermediate segment's ancestor object being
 * itself `.optional()` on the schema (cricket's top-level `wicket`, absent
 * from a plain ball) is irrelevant to a LEAF item's requiredness: the action
 * that declares an attribution item under that ancestor always builds the
 * ancestor too (via its own `fields`), so from that action's own payload the
 * only real question is whether the leaf itself can be left out.
 *
 * Throws — never silently returns `false` — when a path segment does not
 * resolve against the schema. A `PadAttributionItem.path` is a promise about
 * a real payload key; a typo that this returned `false` for would silently
 * un-gate Confirm on a genuinely required field, reopening the exact
 * dead-end-tap bug this derivation exists to close.
 *
 * R8 branch review — the three ways a walk can fail each get their OWN
 * message. They previously shared `no field "<segment>" found`, which is a
 * correct diagnosis for exactly one of them and actively misleading for the
 * other two: it sends the reader looking for a typo in a path that names a
 * real key, when the actual fault is the schema's shape (a leaf, or wrappers
 * nested past `MAX_WRAPPER_HOPS`).
 */
export function isPathRequired(schema: z.ZodTypeAny, path: string): boolean {
  const segments = path.split(".");
  let cursor: z.ZodTypeAny = schema;
  for (const [index, segment] of segments.entries()) {
    const prefix = `isPathRequired: cannot resolve payload path "${path}" against its schema — `;
    const at = index === 0 ? "the payload schema" : `"${segments.slice(0, index).join(".")}"`;
    const lookup = objectShapeOf(cursor);
    if (lookup.kind === "too-deep") {
      throw new Error(
        `${prefix}${at} still wraps something after ${MAX_WRAPPER_HOPS} modifier hops, so the walk gave up ` +
          `before it could look for "${segment}" (this is a WRAPPER-DEPTH bound, not a missing field — "${segment}" ` +
          `may well exist; unwrap the schema or raise MAX_WRAPPER_HOPS in sport/module.ts)`,
      );
    }
    if (lookup.kind === "not-object") {
      throw new Error(
        `${prefix}${at} is not an object schema and does not wrap one, so nothing can be resolved beneath it ` +
          `(a PadAttributionItem/PadField path must not walk past a leaf value)`,
      );
    }
    const field = lookup.shape[segment];
    if (field === undefined) {
      throw new Error(
        `${prefix}no field "${segment}" found while walking it ` +
          `(a PadAttributionItem/PadField path must name a real payload key)`,
      );
    }
    cursor = field;
  }
  return !cursor.isOptional();
}

/**
 * Runs every attribution item in `spec` through `isPathRequired` against its
 * OWN action's registered payload schema, and returns a new `PadSpec` with
 * `required` stamped everywhere. Applied ONCE, at the end of a module's own
 * `padSpec(cfg)`, so a schema change moves every action's Confirm-gating
 * with it — no per-item literal anywhere to fall out of sync.
 *
 * An action whose `type` has no entry in `eventSchemas` is left untouched
 * (unstamped): that mismatch is `checkActionCoverage`'s job to flag, not
 * this function's — throwing here would turn one drift into two different
 * failure shapes for the same root cause.
 *
 * Pure: never mutates `spec`.
 */
export function stampAttributionRequired(
  spec: PadSpec,
  eventSchemas: Readonly<Record<string, z.ZodTypeAny>>,
): PadSpec {
  return {
    ...spec,
    panels: spec.panels.map((panel) => ({
      ...panel,
      actions: panel.actions.map((action) => {
        const schema = eventSchemas[action.type];
        if (schema === undefined) return action;
        return {
          ...action,
          attribution: action.attribution.map((item) => ({
            ...item,
            required: isPathRequired(schema, item.path),
          })),
        };
      }),
    })),
  };
}

// spec 03 §3. Extends the kernel's FoldableModule (spec 03 §2) so every
// SportModule folds through foldMatch unchanged.
export interface SportModule<Cfg, Ev, State> extends FoldableModule<Cfg, State> {
  key: string; // 'cricket'
  version: string; // semver; persisted on every division at creation
  configSchema: z.ZodType<Cfg>; // variant config (overs, setTo, halfMinutes…)
  eventSchema: z.ZodType<Ev>; // union of the sport's event payloads

  // S6/#416 (W5) — event type -> its own zod payload schema, the SAME schema
  // object already used as an `eventSchema` union member and in `apply()`'s
  // hand-written dispatch switch, now also keyed by type string in one place.
  // `eventSchema` carries no per-branch discriminant (the type string lives
  // only on the envelope, `ModuleEvent.type`), so without this registry there
  // was no way to enumerate "every branch, with its type string" short of
  // parsing the dispatch switch itself. `testkit/conformance-pad.ts` walks
  // `eventSchema`'s own `.options` and asserts this registry is a bijection
  // onto them by REFERENCE (deduped — two type strings, like
  // `cricket.ball`/`cricket.superover.ball`, may legitimately share one
  // schema object), which is what makes PadSpec coverage a provable property
  // instead of a hand-maintained claim.
  //
  // OPTIONAL. Only cricket declares it this session — the other ten modules'
  // registries are separate, disjoint follow-up sessions, so this cannot be
  // required yet without breaking every other module's object literal.
  // `padSpecConformanceSuite` asserts at runtime that a module it is handed
  // has actually declared it.
  eventSchemas?: Readonly<Record<string, z.ZodTypeAny>>;

  // S6/#416 (W5) — the pad's own contract: a pure function of resolved cfg
  // (base ⊕ variant preset ⊕ org overrides — already resolved by the caller
  // before this sees it). Must be TOTAL for every cfg `configSchema` accepts,
  // not just the named presets (`registry.get(key, version)` has no
  // fallback, so a division's pinned cfg is what renders, always), and
  // DETERMINISTIC (same cfg in, byte-identical `PadSpec` out).
  //
  // OPTIONAL for the same reason as `eventSchemas` above.
  padSpec?(cfg: Cfg): PadSpec;

  positions: PositionCatalog; // spec 02 §3
  // W4 (#407) — the catalog for a SPECIFIC resolved config, when the sport's
  // lineup rules move with the variant: football's small-sided codes field
  // fewer than eleven, hockey and ice hockey permit a side with no goalkeeper.
  // Omitted ⇒ `positions` governs every config, which is what every module did
  // before W4. Engine-side callers must go through `resolvePositions` rather
  // than reading `positions` directly (src/sport/catalog.ts).
  positionsFor?(cfg: Cfg): PositionCatalog;

  // S3/W4b (#426) — the two lineup hooks, restated here because this is the
  // interface a sport author reads. Both are inherited unchanged from
  // FoldableModule (src/core/events.ts), where the full reasoning lives.
  //
  //  - `lineupPolicy(cfg)` declares what THIS VARIANT permits: re-entry
  //    (`none | once | unlimited` + FIVB's position lock), mid-fixture squad
  //    growth, the substitution cap, and the named exemptions held outside it.
  //    A cfg hook, never a module constant — football's grassroots
  //    dispensations are rolling while Law 3.3 is not, and both share a module.
  //  - `onLineup(state, squads)` hands the folded SquadState back so a module
  //    can persist it into its own State. Called at `init` and after every
  //    accepted change; never after a refusal.
  //
  // The kernel folds `core.lineup.*` itself and never forwards those events to
  // `apply`, exactly as with `core.suspend`. A module that only needs to READ
  // the squads mid-fold declares neither hook and reads `ctx.squads`.
  lineupPolicy?(cfg: Cfg): LineupPolicy;
  onLineup?(state: State, squads: SquadState): State;
  variants: Record<string, Partial<Cfg>>; // named presets: t20, odi, beach, blitz…

  // Jul3/06 §3 — optional print-template fragments. Sport-neutral kinds
  // (timetable, standings, roster, participants) live in engine/exports; a
  // sport contributes only what needs its match grammar (a volleyball
  // scoresheet's per-set point columns, a football report's goal lines).
  exportTemplates?: {
    scoresheet?(input: ScoresheetInput, cfg: Cfg): DocSection[];
    matchReport?(input: ScoresheetInput, cfg: Cfg): DocSection[];
  };

  // Jul3/07 §3 — which fine events feed which player metrics. The engine
  // folds; scoring math stays here. Sports without person-attributed events
  // simply omit it (leaderboards then say "requires detailed scoring").
  playerStats?: PlayerStatsModel;

  // Entrant shapes (2026-07-18 spec): allowed kinds + team affordances.
  // Absent = legacy behaviour (all kinds, team affordances on team rosters).
  entrantModel?: EntrantModel;

  // SPEC-1 — optional discipline descriptor: the colours the rules editor
  // offers + a read-only card projection (usecases/discipline.ts folds it into
  // suspensions). Only card-emitting sports declare it (football + hockey +
  // ice hockey today); a division whose module omits it hides the tab.
  discipline?: DisciplineModel;

  init(cfg: Cfg, lineups: LineupPair): State;
  // W4a (#425) §3.3 — `ctx` is the strict-on-write / tolerant-on-replay seam,
  // narrowed from FoldableModule. Optional, and absent reads as STRICT
  // (`isStrictFold`), so the eight modules with no cfg-derived refusal inside
  // apply() are unchanged and the testkit's direct calls keep full validation.
  apply(state: State, ev: EventEnvelope<Ev | CoreEv>, ctx?: FoldContext): State; // pure; throws EngineError
  outcome(state: State): MatchOutcome | null; // null = still live
  summary(state: State): ScoreSummary; // display-ready at every prefix (§9.5)

  /**
   * W4a (#425) T6b — WHERE IN THE MATCH we are: set 2, game 4, 30–15 · over
   * 12.3 · P2 12:41. The one cross-sport axis W5's pad and W6's timeline order
   * and label events by, projected from state at read time.
   *
   * READ-SIDE BY RULING. The alternative — a `MatchPosition` on every stamped
   * payload — was considered and rejected this wave: `at` is recorded because
   * the fold cannot derive elapsed time, and position IS derivable, so
   * recording it creates a recorded-vs-derived pair of the same type that can
   * silently disagree (the `DisciplineCard.entrantSide` shape). Full argument
   * in `core/position.ts`.
   *
   * OPTIONAL, and its absence is not a gap to be filled. All eleven modules
   * stay at `1.0.0` and `registry.get(key, version)` is an exact lookup with no
   * fallback, so this could never have been required. But the option is also
   * the honest answer for a sport with no position: boardgame's IS the move
   * index, which `BoardgameResult.moves` already carries on the single terminal
   * event, and generic has a running score and no cursor at all. Absent ⇒ the
   * caller orders and labels by `seq` — decided ONCE, in `matchPositionOf`.
   *
   * MUST NOT be materialised into `State`. cfg and state are serialised into
   * the frozen golden strings; a position field in `init` would break all
   * eleven corpora at once, and would be the very denormalisation above.
   *
   * Defined at every prefix, like `summary` (§9.5): at `init`, mid-match, and
   * after the match is decided — where it names the last unit ACTUALLY PLAYED
   * (`currentUnit`), never a phantom next one.
   */
  position?(state: State): MatchPosition;

  // PROMPT-03 deviation from spec 03 §3: `state` appended to the signature —
  // ledger metrics (gf/ga, NRR integer ledger…) live in the folded state, not
  // in the outcome; the adapter has MatchState at hand when a fixture decides.
  // Returned pair is [home, away] in lineup order.
  standingsDelta(
    outcome: MatchOutcome,
    cfg: Cfg,
    ctx: StageCtx,
    state: State,
  ): [StandingsDelta, StandingsDelta];
  metrics: MetricSpec[]; // ledger fields this sport maintains (gd, nrr, set_ratio…)
  defaultTiebreakers: TiebreakerKey[]; // sport's official cascade (doc 05 §4)
  supportsDraws(cfg: Cfg, stage: StageKind): boolean; // knockout football: no

  // §9.3 — allowed per-fixture point totals under cfg (football {3, 2}, …);
  // the conformance kit checks Σ points of both deltas is in this set.
  declaredPointsSets(cfg: Cfg): readonly number[];

  officialLabel: { scorer: string }; // doc 13 §1 — 'Umpire'/'Referee'/'Arbiter'

  // spec 03 §6 — deterministic valid-event generator for property tests.
  // Deviation: rng-injected instead of a fast-check Arbitrary so the engine
  // keeps zero runtime deps; the testkit adapts it. null = no valid event can
  // follow this state (match decided/finalized).
  arbitraryEvent?(state: State, rng: Rng): ModuleEvent<Ev> | null;

  // §9.6 dual-fidelity hook (opt-in): collapse a fine (void-resolved) stream
  // into coarse events that fold to identical totals and outcome.
  coarsen?(events: readonly EventEnvelope<Ev | CoreEv>[]): ModuleEvent<Ev>[];
}

// Registry-facing view — the generics are the module author's business.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySportModule = SportModule<any, any, any>;
