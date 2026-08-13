// Skin contract (S11/#420 W9). A "skin" is a hand-crafted layout for one
// sport family, replacing the universal renderer's panel walk
// (pad-renderer.tsx:241 -> panel.tsx:89) for the sports it claims.
//
// The architecture rule this file enforces, and the reason it is split into a
// PURE layout function plus a React component:
//
//   1. A skin may render ONLY actions the spec declares, and must reach ALL of
//      them. `skinLayout()` returns data, not JSX, so `skin-coverage.test.ts`
//      can compare a skin's action set against `allActionViews()` for every
//      sport x variant with no DOM at all. apps/web's vitest is
//      `environment: "node"` (vitest.config.ts:71) with no jsdom and no
//      @testing-library, so a DOM-rendered assertion is not available here --
//      this is the same constraint that shaped S10's view-model, recorded in
//      _INDEX.md 2026-08-12.
//   2. A skin may NOT invent an event type or bypass chassis dispatch. It never
//      receives `submit` directly; it receives `SkinDispatch` (below), which
//      refuses any type the current view does not declare.
//
// S10's lesson, restated because it cost that session an unreachable component:
// a seam left for a later pass must ship with a working default. Hence
// `skinFor()` is consulted by PadRenderer itself (registry.ts), not left for
// S12 to wire.
import type { ComponentType } from "react";
import type { LineupPair } from "@seazn/engine/core";
import type { FidelityBand, PadSpec } from "@seazn/engine/sport";
import type { PadActionView, PadView } from "../view-model";

/**
 * How prominently a skin commits to drawing a group of actions. This is the
 * part the coverage test can hold a skin to BEYOND mere presence: a cricket
 * skin that reaches `cricket.ball` only from a drawer has satisfied "renders
 * every action" while failing the actual brief (the over's rhythm on screen),
 * so per-sport tests assert headline actions land in `primary`.
 */
export type SkinProminence = "primary" | "secondary" | "drawer";

export interface SkinGroup {
  /** Stable id, skin-local. Used by tests and as a React key -- never shown. */
  id: string;
  prominence: SkinProminence;
  /** Action types drawn in this group, in the order the skin draws them.
   *  Every entry must exist in the `PadView` the layout was built from. */
  actions: readonly string[];
}

/**
 * A score header is a skin's answer to the gap S10 recorded and left open: the
 * universal pad "has no score header of its own -- a scorer sees actions but
 * not the state they are scoring" (_INDEX.md, 2026-08-12). Each skin declares
 * its own, as pure data, so the header is unit-testable per sport x variant
 * without rendering anything.
 */
export interface SkinHeaderField {
  /** Skin-local id, e.g. "score", "overs", "wickets", "clock". */
  id: string;
  /** Already-resolved display text. Numbers are formatted by the skin. */
  value: string;
  /** i18n message key for the field's own caption. Null = value stands alone
   *  (a scoreline needs no caption; "Overs" does). */
  captionKey: string | null;
  /** Drawn large. At most a couple per header -- this is the thing a scorer
   *  reads across a pitch, and 375px is the real surface. */
  emphasis: boolean;
}

export interface SkinHeader {
  fields: readonly SkinHeaderField[];
}

export interface SkinLayoutCtx {
  /** personId -> display name. Optional because the pure sweep in
   *  `skin-coverage.test.ts` has no roster to hand in, and a skin must stay
   *  total without one. Absent (or a missing id) means the skin shows whatever
   *  it can — never a crash, never a blank.
   *
   *  This channel exists because THREE skin implementers independently
   *  reported the same gap in the first pass: without it every person picker
   *  renders a raw person id, so a scorer picking a fielder or an assist sees
   *  a UUID. That is this programme's recurring shape — a surface that is
   *  built, tested and technically reachable, but not actually usable — so it
   *  is fixed centrally here rather than worked around five times. */
  personNames?: Readonly<Record<string, string>>;
  /** The fixture's two entrants and their members, as the chassis already
   *  holds them (`PadRendererProps.lineups`). Optional for the same reason. */
  lineups?: LineupPair;
  /** The module's cfg. Several facts a skin needs are cfg-ONLY and never
   *  surface in PadSpec -- cricket's `ballsPerOver` (5 for the hundred, 6
   *  otherwise) is the measured example: t20/odi/hundred produce byte-identical
   *  specs, so a skin that reads only the spec cannot draw the hundred's over
   *  correctly. Probe evidence recorded in _INDEX.md (S11, 2026-08-13). */
  cfg: unknown;
  /** Live folded state, for the header and for rhythm (this over's balls). */
  state: unknown;
  summary: unknown;
  band: FidelityBand;
}

export interface SkinLayout {
  header: SkinHeader | null;
  groups: readonly SkinGroup[];
}

/**
 * Chassis dispatch, narrowed. `submit` itself (use-pad-pipeline.ts:122) accepts
 * any string; this refuses a type the current view does not declare, so
 * "skin invents an event type" fails loudly at the call site instead of
 * reaching the transport and 422-ing against the server's zod schema.
 */
export type SkinDispatch = (type: string, payload: unknown) => Promise<void>;

export interface SkinProps {
  view: PadView;
  spec: PadSpec;
  ctx: SkinLayoutCtx;
  layout: SkinLayout;
  dispatch: SkinDispatch;
  /** Mirrors the chassis result (use-pad-pipeline.ts:101-123) for status
   *  chrome a skin draws itself. */
  queueDepth: number;
  offline: boolean;
  submittingType: string | null;
}

export interface SkinDef {
  /** Registry key, also the test id. */
  key: string;
  /** Sport keys this skin claims. A sport appears in at most one skin --
   *  asserted by the registry's own test. */
  sports: readonly string[];
  /** PURE. No React, no DOM, no i18n lookup -- called directly by the coverage
   *  test across every sport x variant. */
  layout: (view: PadView, ctx: SkinLayoutCtx) => SkinLayout;
  Component: ComponentType<SkinProps>;
}

/** Every action type a layout places, in draw order, across all groups. */
export function layoutActionTypes(layout: SkinLayout): readonly string[] {
  return layout.groups.flatMap((group) => group.actions);
}

/** Action types at a given prominence -- the "did the headline action reach the
 *  primary surface" assertion per-sport tests use. */
export function layoutActionTypesAt(layout: SkinLayout, prominence: SkinProminence): readonly string[] {
  return layout.groups.filter((group) => group.prominence === prominence).flatMap((group) => group.actions);
}

/**
 * Wraps the chassis `submit` so a skin can only ever emit an action the view in
 * front of it declares. Not defence against a typo alone: it is the structural
 * answer to "a skin bypassing chassis dispatch", because a skin has no other
 * way to send -- PadRenderer never hands a skin `submit` itself.
 */
export function createSkinDispatch(
  view: PadView,
  submit: (type: string, payload: unknown) => Promise<void>,
): SkinDispatch {
  const declared = new Set(view.panels.flatMap((panel) => panel.actions.map((action) => action.type)));
  return async (type, payload) => {
    if (!declared.has(type)) {
      throw new Error(
        `skin dispatched an action the spec does not declare at this phase: ${type}. ` +
          `Declared here: ${[...declared].sort().join(", ") || "(none)"}`,
      );
    }
    await submit(type, payload);
  };
}

/** Convenience for skins: the resolved action view for a type, or null. */
export function actionByType(view: PadView, type: string): PadActionView | null {
  for (const panel of view.panels) {
    for (const action of panel.actions) if (action.type === type) return action;
  }
  return null;
}
