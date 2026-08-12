// The universal renderer's pure core (S10/#419 W8, chassis item 1): walks a
// PadSpec + a runtime context into a `PadView` a React surface can draw
// mechanically, with zero per-sport branching. PURE — no React, no fetch, no
// engine folding (the caller already folded via module-client.ts's
// `foldClient` and hands in `state`/`summary`).
//
// Gate evaluation is delegated to the engine's OWN `evalPadGate` (imported,
// never reimplemented) — this repo's most-repeated defect is a
// placer/verifier fork, two code paths computing "should this show right
// now" until they silently disagree (see sport/module.ts's own header). The
// same discipline applies to payload construction: `buildActionPayload`
// below is a thin wrapper over the engine's `buildPathObject`, the exact
// function the engine's own conformance property test uses to build a
// reference payload from an action's declared fields/attribution — so a
// scorer's submitted values and the engine's own coverage proof assemble a
// payload the identical way.
import type { MessageKey } from "@/lib/messages";
import {
  evalPadGate,
  buildPathObject,
  type FidelityBand,
  type PadAction,
  type PadAttribution,
  type PadField,
  type PadFieldValue,
  type PadGate,
  type PadLabel,
  type PadPanel,
  type PadPanelLayout,
  type PadPhase,
  type PadSpec,
} from "@seazn/engine/sport";

/** Canonical phase order — every phase-ordered UI (tab nav, `phases`) walks
 *  this, never `Object.keys`/declaration order, which would follow whatever
 *  order a module happened to push panels in. */
export const PAD_PHASES: readonly PadPhase[] = ["pre", "live", "post"];

const ALWAYS_GATE: PadGate = { op: "always" };

/**
 * A key this file owns the copy for (never an engine `PadLabel` — those
 * resolve through `padLabel()`/`PAD_LABEL_SET` in scoring-vocab.ts, and a
 * chassis-native reason is never one of those keys). `label` is this file's
 * own English fallback, the same convention `PadLabel` itself uses, so a
 * renderer that has no dictionary at hand (a bare unit test) still gets
 * legible text.
 */
export interface ChassisLabel {
  key: MessageKey;
  label: string;
}

const MISSING_FIELDS_REASON: ChassisLabel = {
  key: "scorepad.validity.missingFields",
  label: "Fill in the required fields to continue.",
};

const LOCKED_REASON: ChassisLabel = {
  key: "scorepad.locked.reason",
  label: "Upgrade your plan to unlock this action.",
};

export type ActionAvailability = { kind: "available" } | { kind: "locked"; reason: ChassisLabel };

/** An action, resolved for THIS context: band/entitlement decided, fields
 *  and attribution requirements passed through untouched (the attribution
 *  picker is a later pass — see the module header) for a future picker to
 *  consume from the exact same shape the engine declared. */
export interface PadActionView {
  type: string;
  labelKey: PadLabel;
  fields: readonly PadField[];
  attribution: PadAttribution;
  availability: ActionAvailability;
}

export interface PadPanelView {
  labelKey: PadLabel;
  phase: PadPhase;
  layout: PadPanelLayout;
  actions: readonly PadActionView[];
}

export interface PadView {
  /** Echoes the requested phase. */
  phase: PadPhase;
  /** Every phase the spec declares at least one panel for — structural
   *  (derived from `spec.panels` alone), NOT gate/band/entitlement filtered,
   *  so phase tab navigation stays stable regardless of runtime state. */
  phases: readonly PadPhase[];
  /** Panels at `phase`, gate-filtered (`evalPadGate`) and with each
   *  surviving panel's actions band/entitlement-filtered. A panel whose
   *  every action is band-hidden is dropped too — an empty panel has
   *  nothing to draw. */
  panels: readonly PadPanelView[];
}

export interface PadViewCtx {
  /** The module's own folded state — required by gate predicates rooted at
   *  `state.*`. Pass the REAL fold (module-client.ts's `foldClient`), never
   *  a hand-abbreviated shape: several sport states carry OPTIONAL fields
   *  that only appear once folded (e.g. generic's `running`), and a partial
   *  stand-in can make a gate (or a downstream `summary()`) misbehave. */
  state: unknown;
  summary: unknown;
  phase: PadPhase;
  /** The fixture's own configured/currently-viewed fidelity band. */
  band: FidelityBand;
  /** FeatureKey -> whether the org holds it, e.g. `{"stats.player": true}`.
   *  Only entries `spec.fidelityEntitlements` actually references matter. */
  entitlements: Readonly<Record<string, boolean>>;
}

/**
 * One action's resolved view, independent of any panel gate — the building
 * block both `buildPadView` (phase + gate filtered, for the renderer) and
 * `allActionViews` (unfiltered by phase/gate, for coverage/search) share, so
 * the two can never compute band/entitlement availability two different
 * ways. Returns `null` when the action sits above `ctx.band` — "absent",
 * per the S10 acceptance criteria, not merely disabled.
 */
function resolveActionView(
  spec: PadSpec,
  action: PadAction,
  ctx: Pick<PadViewCtx, "band" | "entitlements">,
): PadActionView | null {
  const band = spec.fidelity[action.type];
  // Every registered type has exactly one band, by the engine's own
  // `checkFidelityMap` conformance — but a spec is untrusted input from this
  // file's point of view, so an unbanded type (a conformance regression, or
  // a future module still mid-wiring) reads as "hide it", the safe default,
  // never "show unconditionally".
  if (band === undefined || band > ctx.band) return null;
  const neededEntitlement = spec.fidelityEntitlements[band];
  const availability: ActionAvailability =
    neededEntitlement && !ctx.entitlements[neededEntitlement]
      ? { kind: "locked", reason: LOCKED_REASON }
      : { kind: "available" };
  return {
    type: action.type,
    labelKey: action.labelKey,
    fields: action.fields,
    attribution: action.attribution,
    availability,
  };
}

/**
 * Every action across the WHOLE spec, independent of phase and panel gate —
 * only band/entitlement filtering applies. At `band: 3` (the maximum) this
 * is every action `padSpec(cfg)` declares, unconditionally, which is what
 * makes it the natural hook for a coverage/reachability sweep across a
 * module's whole cfg space: no gate-satisfying state to fabricate, because
 * gates are a "what to show right now" concern, not a "does this action
 * exist" one. Also useful on its own (a command palette / search over every
 * action a fixture could ever reach, regardless of the tab currently open).
 */
export function allActionViews(
  spec: PadSpec,
  ctx: Pick<PadViewCtx, "band" | "entitlements">,
): readonly PadActionView[] {
  const out: PadActionView[] = [];
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      const view = resolveActionView(spec, action, ctx);
      if (view) out.push(view);
    }
  }
  return out;
}

/** The renderer's main entry point: phase-scoped, gate-filtered (via the
 *  engine's own `evalPadGate`), band/entitlement-filtered. */
export function buildPadView(spec: PadSpec, ctx: PadViewCtx): PadView {
  const gateCtx = { state: ctx.state, summary: ctx.summary };
  const phases = PAD_PHASES.filter((phase) => spec.panels.some((panel) => panel.phase === phase));

  const panels: PadPanelView[] = [];
  for (const panel of spec.panels) {
    if (panel.phase !== ctx.phase) continue;
    if (!evalPadGate(panel.gate ?? ALWAYS_GATE, gateCtx)) continue;
    const actions: PadActionView[] = [];
    for (const action of panel.actions) {
      const view = resolveActionView(spec, action, ctx);
      if (view) actions.push(view);
    }
    if (actions.length === 0) continue; // nothing left to draw in this panel
    panels.push({ labelKey: panel.labelKey, phase: panel.phase, layout: panel.layout, actions });
  }

  return { phase: ctx.phase, phases, panels };
}

export type ActionValidity =
  | { ok: true }
  | { ok: false; missing: readonly PadField[]; reason: ChassisLabel };

/**
 * Spec-derived only (this file never sees a module's zod `eventSchemas`, by
 * design — see the brief). Every declared FIELD is required for the action
 * to fire; attribution is deliberately excluded — the attribution picker is
 * a later pass (module header), so nothing collects those values yet, and
 * several attribution items are legitimately optional in the engine's own
 * schema (a wicket with no named fielder) with no per-item flag on
 * `PadAttributionItem` to tell required from optional even if this file
 * wanted to check them.
 */
export function checkActionValidity(
  action: Pick<PadAction, "fields">,
  values: Readonly<Record<string, PadFieldValue | undefined>>,
): ActionValidity {
  const missing = action.fields.filter((field) => values[field.path] === undefined);
  if (missing.length > 0) return { ok: false, missing, reason: MISSING_FIELDS_REASON };
  return { ok: true };
}

/**
 * Turn collected form values into a real event payload — fields AND
 * attribution together, both are just `(path, value)` pairs from
 * `buildPathObject`'s point of view. An unset path is OMITTED (never sent as
 * an explicit `undefined`), matching the engine's own `z.strictObject`
 * payload shapes and the exact technique `testkit/conformance-pad.ts`'s
 * property test uses to build its reference payloads.
 */
export function buildActionPayload(
  action: Pick<PadAction, "fields" | "attribution">,
  values: Readonly<Record<string, PadFieldValue | undefined>>,
): Record<string, unknown> {
  const entries: (readonly [string, unknown])[] = [];
  for (const field of action.fields) entries.push([field.path, values[field.path]]);
  for (const item of action.attribution) entries.push([item.path, values[item.path]]);
  return buildPathObject(entries);
}
