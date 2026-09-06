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
  type PadAttributionItem,
  type PadField,
  type PadFieldValue,
  type PadGate,
  type PadLabel,
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

/** R8/WS-B2 — Confirm's one-line reason when every field is set but a
 *  required attribution item (asterisk + "required" microcopy on its own
 *  row — action-form.tsx's `renderAttributionRow`) is still unfilled. */
const MISSING_ATTRIBUTION_REASON: ChassisLabel = {
  key: "scorepad.validity.missingAttribution",
  label: "Choose who's required before you can continue.",
};

/**
 * Task 20 — Confirm's reason when an action declares one or more `PadField
 * .group`s (module.ts) and NONE of them has been touched. Deliberately
 * chassis-generic, like the two reasons above, and NEVER the sport-specific
 * wording a particular action's groups happen to mean ("batting or bowling",
 * for `cricket.player.line`): this file's own header states the contract —
 * "a chassis-native reason is never one of those keys" (an engine `PadLabel`)
 * — and `ActionValidity.reason` is typed `ChassisLabel`, whose `key` is a
 * `MessageKey`, not the wider `string` a `PadLabel.key` carries; threading a
 * per-action label through here would need a cast at the boundary this file
 * exists to keep un-cast. A future action with its own group semantics gets
 * the same generic copy for free, with zero per-sport branching added here.
 *
 * Fix round 1 (task-20-review.md, Important #1) — the copy must never claim
 * a UI affordance the renderer doesn't have: `field.group` is read nowhere
 * in `action-form.tsx` (no highlighting, no visual grouping, no section
 * boundary), so the original "Fill in at least one of the highlighted
 * sections" was a truthfulness defect, not just a wording one. This wording
 * names no visual treatment at all. */
const MISSING_GROUP_REASON: ChassisLabel = {
  key: "scorepad.validity.missingGroup",
  label: "Fill in at least one section.",
};

/**
 * Task 20 — which of an action's declared `PadField.group` names have at
 * least one field "touched" (a defined value in `values`). A `kind: "toggle"`
 * field is EXCLUDED from this test on purpose: `initialActionValues`
 * (action-form.tsx) pre-seeds every toggle to `false` before the scorer taps
 * anything, so a toggle's mere presence in `values` says nothing about
 * whether its group was genuinely engaged (`cricket.player.line`'s
 * `batting.out` is exactly this case). Shared by `checkActionValidity` and
 * `buildActionPayload` so the two can never drift on what "touched" means. */
function groupsTouched(
  fields: readonly PadField[],
  values: Readonly<Record<string, PadFieldValue | undefined>>,
): ReadonlySet<string> {
  const touched = new Set<string>();
  for (const field of fields) {
    if (field.group === undefined || field.kind === "toggle") continue;
    if (values[field.path] !== undefined) touched.add(field.group);
  }
  return touched;
}

// W1 / Task 4 (entitlements v18): `ActionAvailability` and its
// `LOCKED_REASON` are DELETED, not defaulted. They had exactly one producer —
// `spec.fidelityEntitlements[band]`, a field Task 2 removed from the engine —
// so a surviving `{kind:"available"}` union of one would be a signal nothing
// can ever raise, sitting in a shape three renderers branch on. An action is
// either within the scorer's chosen band and rendered, or above it and absent
// (`resolveActionView` below returns `null`); there is no third state and no
// paid one.

/** An action, resolved for THIS context: band decided, fields and attribution
 *  requirements passed through untouched (the attribution picker is a later
 *  pass — see the module header) for a future picker to consume from the
 *  exact same shape the engine declared. */
export interface PadActionView {
  type: string;
  labelKey: PadLabel;
  fields: readonly PadField[];
  attribution: PadAttribution;
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
  /** The recording band the SCORER has picked on the Recording chip — a UX
   *  filter, never an entitlement (W1, entitlements v18). `pad-host.tsx`
   *  owns it; see its `defaultBandFor`/`resolveInitialBand`. */
  band: FidelityBand;
}

/**
 * One action's resolved view, independent of any panel gate — the building
 * block both `buildPadView` (phase + gate filtered, for the renderer) and
 * `allActionViews` (unfiltered by phase/gate, for coverage/search) share, so
 * the two can never compute band availability two different ways. Returns `null` when the action sits above `ctx.band` — "absent",
 * per the S10 acceptance criteria, not merely disabled.
 */
function resolveActionView(
  spec: PadSpec,
  action: PadAction,
  ctx: Pick<PadViewCtx, "band">,
): PadActionView | null {
  const band = spec.fidelity[action.type];
  // Every registered type has exactly one band, by the engine's own
  // `checkFidelityMap` conformance — but a spec is untrusted input from this
  // file's point of view, so an unbanded type (a conformance regression, or
  // a future module still mid-wiring) reads as "hide it", the safe default,
  // never "show unconditionally".
  if (band === undefined || band > ctx.band) return null;
  return {
    type: action.type,
    labelKey: action.labelKey,
    fields: action.fields,
    attribution: action.attribution,
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
  ctx: Pick<PadViewCtx, "band">,
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
  | { ok: false; missing: readonly (PadField | PadAttributionItem)[]; reason: ChassisLabel };

/**
 * Spec-derived only (this file never sees a module's zod `eventSchemas`, by
 * design — see the brief). Every declared FIELD is required for the action
 * to fire. Attribution is checked too, as of R8/WS-B2: `PadAttributionItem
 * .required` (stamped by the engine's own `stampAttributionRequired`,
 * derived from the action's real payload schema — module.ts's own header)
 * now tells required from optional, closing the dead-end tap where a scorer
 * could confirm e.g. cricket.toss with `wonBy` unset and the engine's
 * `z.strictObject` silently rejected the payload. `required` falsy (or
 * absent, for a hand-built test fixture never run through the stamp) stays
 * skippable, exactly as before — several attribution items are legitimately
 * optional in the engine's own schema (a wicket with no named fielder).
 *
 * R8 branch review, finding 5 — `attribution` is REQUIRED on the parameter.
 * It used to be `Partial<…>`, which meant a caller passing `{ fields }` alone
 * disabled this entire gate with no type error: an inert seam sitting on the
 * very guard that exists to close inert seams. An action genuinely without
 * attribution passes `attribution: []`, which SAYS so; an omission cannot say
 * anything. Enforced by an `@ts-expect-error` proof in view-model.test.ts,
 * since vitest never typechecks and nothing at runtime can witness a
 * parameter that was merely widened.
 *
 * Task 20 — `field.group` (module.ts, hand-authored): a group with ZERO
 * touched fields (`groupsTouched` above) is skipped entirely, same as an
 * `optional` field, regardless of each member's own `optional` flag. The
 * moment ANY field in a group is touched, every field in THAT group reverts
 * to its own `optional` flag exactly as if `group` were absent — a
 * half-filled aspect still blocks Confirm on its own required fields. An
 * action declaring 1+ distinct group names additionally requires at least
 * one be touched (`cricket.player.line`'s "batting and/or bowling" rule,
 * mirrored from `CricketPlayerLine`'s own schema `.refine()` — see that
 * schema's comment — with no schema or reducer change needed).
 */
export function checkActionValidity(
  action: Pick<PadAction, "fields" | "attribution">,
  values: Readonly<Record<string, PadFieldValue | undefined>>,
): ActionValidity {
  const touchedGroups = groupsTouched(action.fields, values);
  const groupNames = new Set(action.fields.map((field) => field.group).filter((g): g is string => g !== undefined));

  // Owner ruling 12, S18 — `field.optional` (module.ts, hand-authored, never
  // derived) is skipped from the gate entirely: a field flagged this way may
  // stay unset and Confirm still fires. Absent/falsy behaves exactly as
  // before this flag existed — every pre-ruling-12 field on every action
  // stays required. See cricket's `cricket.player.line` for the shipped
  // example (its six band-2 enrichment fields vs. its original seven).
  //
  // Task 20 — a field whose `group` is declared but NOT (yet) touched is
  // also skipped here, on top of `optional`: an untouched aspect is not
  // "missing", it is not being submitted at all.
  const missingFields = action.fields.filter((field) => {
    if (field.optional === true) return false;
    if (field.group !== undefined && !touchedGroups.has(field.group)) return false;
    return values[field.path] === undefined;
  });
  if (missingFields.length > 0) return { ok: false, missing: missingFields, reason: MISSING_FIELDS_REASON };

  // Task 20 — the action declares groups (an "aspect" choice) but the
  // scorer has touched none of them: refuse before ever reaching the
  // attribution gate, same posture as the missing-fields check above.
  if (groupNames.size > 0 && touchedGroups.size === 0) {
    return {
      ok: false,
      missing: action.fields.filter((field) => field.group !== undefined),
      reason: MISSING_GROUP_REASON,
    };
  }

  // The `?? []` stays deliberately, even though the type now forbids the
  // case: this is the Confirm path of a live scoring pad, and an untyped
  // caller (a cast, a hand-built fixture) should not crash it. The TYPE is
  // the fix — the seam was "disables the gate with NO TYPE ERROR" — and the
  // fallback is belt to its braces, not the guard itself.
  const missingAttribution = (action.attribution ?? []).filter(
    (item) => item.required === true && values[item.path] === undefined,
  );
  if (missingAttribution.length > 0) {
    return { ok: false, missing: missingAttribution, reason: MISSING_ATTRIBUTION_REASON };
  }
  return { ok: true };
}

/**
 * Turn collected form values into a real event payload — fields AND
 * attribution together, both are just `(path, value)` pairs from
 * `buildPathObject`'s point of view. An unset path is OMITTED (never sent as
 * an explicit `undefined`), matching the engine's own `z.strictObject`
 * payload shapes and the exact technique `testkit/conformance-pad.ts`'s
 * property test uses to build its reference payloads.
 *
 * Owner ruling 12, S18 — an attribution item declaring `requiresField` (a
 * dotted `PadField` path, module.ts) has its collected value dropped to
 * `undefined` here whenever that field is itself unset, REGARDLESS of what
 * the scorer tapped — so `buildPathObject` omits it exactly like any other
 * unset path. This is what keeps `batting.dismissal.bowler`/`.fielder` from
 * ever reaching the payload without `batting.dismissal.kind` alongside them
 * (the schema requires `kind` inside that sub-object; see the field's own
 * doc in sport/module.ts).
 *
 * Task 20 — a field whose `group` (module.ts) is declared but NOT touched
 * (`groupsTouched` above, shared with `checkActionValidity` so the two can
 * never disagree) is forced to `undefined` here REGARDLESS of what `values`
 * holds for it — closing the exact defect this task fixes: a toggle field's
 * own `initialActionValues` default (e.g. `cricket.player.line`'s
 * `batting.out`, pre-seeded `false`) would otherwise survive into the built
 * payload even when the scorer never touched that aspect at all, building a
 * half-formed `batting`/`bowling` sub-object the engine's schema rejects.
 */
export function buildActionPayload(
  action: Pick<PadAction, "fields" | "attribution">,
  values: Readonly<Record<string, PadFieldValue | undefined>>,
): Record<string, unknown> {
  const touchedGroups = groupsTouched(action.fields, values);
  const entries: (readonly [string, unknown])[] = [];
  for (const field of action.fields) {
    const suppressed = field.group !== undefined && !touchedGroups.has(field.group);
    entries.push([field.path, suppressed ? undefined : values[field.path]]);
  }
  for (const item of action.attribution) {
    const gated = item.requiresField !== undefined && values[item.requiresField] === undefined;
    entries.push([item.path, gated ? undefined : values[item.path]]);
  }
  return buildPathObject(entries);
}

/**
 * S10/#419 W8 fix 1 — the renderer's own fallback caption for a `PadField`
 * that ships with no `labelKey` at all. That is legal by design
 * (`PadFieldEnum`'s own header in sport/module.ts): S7/#427 left it optional
 * on the reasoning that e.g. cricket's `runs.bat` "sits inside a labelled
 * Ball action whose whole layout names it" — true of a hand-built skin,
 * false of THIS universal renderer, which has no per-sport layout to lean
 * on. Concretely, cricket's `cricket.player.line` action ships SEVEN such
 * fields, and the renderer's old fallback (`${action label} #${n}`) rendered
 * them as "Scorecard line #1" … "#7" with no visible caption at all — a
 * scorer could not tell runs from wickets from overs.
 *
 * This derives a real, visible caption from the field's own dotted `path`
 * instead: split on ".", split each segment's camelCase/snake_case into
 * words, lowercase everything, join with spaces, capitalize only the first
 * letter of the whole phrase — "wickets" -> "Wickets", "bowling.legalBalls"
 * -> "Bowling legal balls". That is A defensible rule, not THE only one; it
 * is total (never throws, never returns the empty string for a non-empty
 * path), deterministic, and — unlike using only the last segment — it
 * disambiguates two fields in the same action that share a leaf name (e.g. a
 * `kind` nested under two different parents). A declared `labelKey` always
 * wins over this — see action-form.tsx's `renderField` — so this only ever
 * fires for a field the engine deliberately left uncaptioned.
 *
 * Deliberately NEVER routed through msg()/a dictionary key. `path` is an
 * engine-internal identifier, not authored copy: there is no English
 * sentence here for a translator to translate, and four locale files cannot
 * usefully carry "whatever field path an as-yet-unwritten module happens to
 * declare". `ChassisLabel`/`MISSING_FIELDS_REASON` above are this file's
 * pattern for actual human-authored copy; this is deliberately not that, and
 * `i18n:check` never sees it (it only walks `src/dictionaries/**`).
 */
export function deriveFieldPathLabel(path: string): string {
  const words = path
    .split(".")
    .flatMap((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase -> word boundary
        .replace(/[_-]+/g, " ") // snake_case / kebab-case -> word boundary
        .toLowerCase()
        .split(" ")
        .filter(Boolean),
    );
  if (words.length === 0) return path; // defensive only — the engine never declares an empty path
  return words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1) + (words.length > 1 ? " " + words.slice(1).join(" ") : "");
}

/**
 * S10/#419 W8 fix 3 — the fold's own headline (`ScoreSummary.headline`,
 * packages/engine/src/core/types.ts), read defensively. `summary` reaches
 * this file typed `unknown` (see `PadViewCtx`'s own header above) and stays
 * that way here on purpose: every SHIPPED module's `summary()` always sets a
 * non-empty string `headline` once it runs (generic's own comment: "defined
 * at every prefix; before any result the headline is '—'"), but this file
 * has never imported `ScoreSummary` and does not start now just to read one
 * field, so a genuinely malformed or absent summary — a non-conforming
 * caller, or a future module mid-wiring — degrades to `null` instead of
 * crashing the renderer or putting the literal string "undefined" on a
 * scorer's screen. `null` means "render nothing", never "render a
 * placeholder" — inventing fallback copy here would be exactly the
 * sport-specific vocabulary this file is not supposed to know.
 */
export function summaryHeadline(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return null;
  const headline = (summary as { headline?: unknown }).headline;
  return typeof headline === "string" && headline.length > 0 ? headline : null;
}
