"use client";
// Tennis skin (S11/#420 W9). Point -> game -> set nesting off
// packages/engine/src/sports/nested/kernel.ts — its own vocabulary
// (tennis.point, tennis.game.award, tennis.interruption), NOT the setbased
// three (volleyball/badminton/tabletennis) racquet-skin shares. See
// registry.ts's header for why tennis gets its own module, and ./types.ts
// for the contract this file implements.
//
// `tennisLayout` is PURE (contract: ./types.ts) — no React, no i18n lookup.
// It derives every group structurally from the `PadView` it is handed: one
// SkinGroup per surviving panel, in the SAME order, so `TennisSkin` below
// can zip `layout.groups[i]` with `view.panels[i]` to find the REAL actions
// to draw (a group's own `actions` are bare TYPE STRINGS — see
// `layoutActionTypes`'s own doc comment — never enough on their own to
// render a tile). That is also what makes the gated `gameAward` panel just
// work: when its gate is closed, `evalPadGate` (buildPadView, upstream of
// this file) has already dropped it from `view.panels`, so there is simply
// no panel to make a group from — nothing here has to know about the gate
// at all.
//
// Every reader below (`readState`/`readBestOf`/`readEntrants`) is TOTAL and
// defaults safely rather than throwing: skin-coverage.test.ts's own sweep
// calls `layout()` with `ctx.state: {}` (a stand-in, not a real fold — see
// that file's header on why gates are measured separately from reach), and
// this file has to keep producing a real header against that shape.
import type { ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { type MsgFn } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";
import type { LineupPair } from "@seazn/engine/core";
import { ActionForm, type ActionFormProps } from "../action-form";
import { AttributionPicker } from "../attribution-picker";
import type { PadActionView, PadPanelView, PadView } from "../view-model";
import {
  actionByType,
  type SkinDef,
  type SkinDispatch,
  type SkinGroup,
  type SkinHeader,
  type SkinHeaderField,
  type SkinLayout,
  type SkinLayoutCtx,
  type SkinProminence,
  type SkinProps,
} from "./types";
import { renderLockedTile } from "./shared";

// ---------------------------------------------------------------------------
// layout() — pure. Reads `ctx.cfg` / `ctx.state` defensively; never throws.
// ---------------------------------------------------------------------------

type Side = "home" | "away";

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asSide(v: unknown, fallback: Side): Side {
  return v === "home" || v === "away" ? v : fallback;
}

interface TennisPointsRead {
  kind: "standard" | "tiebreak" | "matchTiebreak";
  home: number;
  away: number;
  advantage: Side | null;
}

interface TennisStateRead {
  games: { home: number; away: number };
  points: TennisPointsRead;
  setsWon: { home: number; away: number };
  serving: Side;
}

/** Narrows `ctx.state` (typed `unknown` by the shared contract — nested
 *  kernel's own `NestedState` is not part of the engine's public export
 *  surface, so a skin reads its own sport's shape structurally rather than
 *  importing a type nothing exposes) into exactly the fields this header
 *  needs, defaulting every one of them rather than throwing. */
function readState(raw: unknown): TennisStateRead {
  const s = asRecord(raw);
  const games = asRecord(s.games);
  const setsWon = asRecord(s.setsWon);
  const points = asRecord(s.points);
  const kind = points.kind === "tiebreak" || points.kind === "matchTiebreak" ? points.kind : "standard";
  const advantage = points.advantage === "home" || points.advantage === "away" ? points.advantage : null;
  return {
    games: { home: asFiniteNumber(games.home, 0), away: asFiniteNumber(games.away, 0) },
    points: { kind, home: asFiniteNumber(points.home, 0), away: asFiniteNumber(points.away, 0), advantage },
    setsWon: { home: asFiniteNumber(setsWon.home, 0), away: asFiniteNumber(setsWon.away, 0) },
    serving: asSide(s.serving, "home"),
  };
}

function readBestOf(raw: unknown): number {
  return asFiniteNumber(asRecord(raw).bestOf, 3);
}

function readEntrants(raw: unknown): { home: string; away: string } {
  const entrants = asRecord(asRecord(raw).entrants);
  return {
    home: typeof entrants.home === "string" ? entrants.home : "home",
    away: typeof entrants.away === "string" ? entrants.away : "away",
  };
}

const CALLS = ["0", "15", "30", "40"] as const;

/**
 * Tennis's own point vocabulary — mirrors nested/kernel.ts's own
 * `gameScoreLine` (0/15/30/40, deuce, "Ad"), re-implemented locally because
 * the engine's public `@seazn/engine/sports/tennis` surface exports only the
 * `tennis` module VALUE, never kernel-internal helpers (there is no
 * `sports/nested/index.ts` barrel at all). "Ad" is the SAME un-translated
 * abbreviation `gameScoreLine` itself ships — rendered verbatim by
 * pad-renderer.tsx's own score headline with no msg() call — so tennis
 * scoreline vocabulary is already, elsewhere in this codebase, treated as
 * scoreboard notation rather than prose needing translation.
 *
 * During a tie-break/match tie-break this returns the raw point count alone
 * (no "TB"/"MTB" prefix) — the separate `tiebreak` header field below
 * supplies that context, so the two don't say the same thing twice.
 */
function pointsValue(points: TennisPointsRead): string {
  if (points.kind !== "standard") return `${points.home}–${points.away}`;
  if (points.home >= 3 && points.away >= 3) {
    if (points.advantage === "home") return "Ad–40";
    if (points.advantage === "away") return "40–Ad";
    return "40–40";
  }
  const h = CALLS[Math.min(points.home, 3)] ?? "0";
  const a = CALLS[Math.min(points.away, 3)] ?? "0";
  return `${h}–${a}`;
}

/** Home-first, matching every other header field's own order (and
 *  `gameScoreLine`'s). A dot pair, not a word: `SkinHeaderField.value` is
 *  rendered verbatim (layout() may perform no i18n lookup — see this file's
 *  own header), and this session's allowed key list has no bare "Home"/
 *  "Away" pair for a header VALUE (`scorepad.attribution.home/.away` exist,
 *  but those caption an attribution CONTROL, a different surface). */
function servingValue(serving: Side): string {
  return serving === "home" ? "● ○" : "○ ●";
}

/** A match tie-break REPLACES the final set and has no games at all
 *  (nested/kernel.ts's own `nestedPosition`: "the game segment is omitted
 *  rather than reported as a phantom 'Game 1'") — an em dash says "not
 *  applicable" without implying a false 0–0. */
function gamesValue(games: { home: number; away: number }, points: TennisPointsRead): string {
  if (points.kind === "matchTiebreak") return "—";
  return `${games.home}–${games.away}`;
}

/** Best-of rides along as a bare "Bo3"/"Bo5" — the same un-translated
 *  scoreboard-abbreviation convention as "TB"/"MTB"/"Ad" above, not a new
 *  one, so flipping `cfg.bestOf` (acceptance criterion: "flipping best-of
 *  visibly changes the scoreboard") is legible without an i18n key this
 *  session's allowed list does not have. */
function setsValue(setsWon: { home: number; away: number }, bestOf: number): string {
  return `${setsWon.home}–${setsWon.away} (Bo${bestOf})`;
}

function buildHeader(ctx: SkinLayoutCtx): SkinHeader {
  const state = readState(ctx.state);
  const bestOf = readBestOf(ctx.cfg);
  const fields: SkinHeaderField[] = [
    { id: "sets", value: setsValue(state.setsWon, bestOf), captionKey: "scorepad.skin.tennis.header.sets", emphasis: true },
    { id: "games", value: gamesValue(state.games, state.points), captionKey: "scorepad.skin.tennis.header.games", emphasis: false },
    { id: "points", value: pointsValue(state.points), captionKey: "scorepad.skin.tennis.header.points", emphasis: true },
    { id: "serving", value: servingValue(state.serving), captionKey: "scorepad.skin.tennis.header.serving", emphasis: false },
  ];
  // Present only "when in one" (acceptance criterion) — a scorer never sees
  // a permanently-blank TB/MTB slot during standard play.
  if (state.points.kind !== "standard") {
    fields.push({
      id: "tiebreak",
      value: state.points.kind === "matchTiebreak" ? "MTB" : "TB",
      captionKey: "scorepad.skin.tennis.header.tiebreak",
      emphasis: false,
    });
  }
  return { fields };
}

/** panel.labelKey.key -> this skin's own group id + prominence. Safe to
 *  hardcode (rather than derive from `panel.layout` alone): nested/kernel.ts
 *  §"S6/#416 (W5) — padSpec" states this kernel has NO cfg-shaped gating at
 *  all — every one of these 5 panels exists, spelled exactly this way, for
 *  every cfg tennis's configSchema accepts. A panel key this table does not
 *  recognise (only possible if that invariant ever changes) still degrades
 *  safely via the fallback below rather than throwing. */
const PANEL_GROUP: Readonly<Record<string, { id: string; prominence: SkinProminence }>> = {
  "pad.tennis.panel.points": { id: "point", prominence: "primary" },
  "pad.tennis.panel.setScore": { id: "setScore", prominence: "secondary" },
  "pad.tennis.panel.sanctions": { id: "sanctions", prominence: "drawer" },
  "pad.tennis.panel.interruptions": { id: "interruptions", prominence: "drawer" },
  "pad.tennis.panel.gameAward": { id: "gameAward", prominence: "drawer" },
};

const FALLBACK_PROMINENCE: Readonly<Record<PadPanelView["layout"], SkinProminence>> = {
  primary: "primary",
  grid: "secondary",
  drawer: "drawer",
  perSide: "secondary",
};

function groupFor(panel: PadPanelView): { id: string; prominence: SkinProminence } {
  return PANEL_GROUP[panel.labelKey.key] ?? { id: panel.labelKey.key, prominence: FALLBACK_PROMINENCE[panel.layout] };
}

function dedupeTypes(types: readonly string[]): string[] {
  return [...new Set(types)];
}

/** PURE. One SkinGroup per surviving panel, same order — see this file's
 *  own header for why the Component relies on that pairing. */
export function tennisLayout(view: PadView, ctx: SkinLayoutCtx): SkinLayout {
  const groups: SkinGroup[] = view.panels.map((panel) => {
    const { id, prominence } = groupFor(panel);
    // Deduped: `points`/`setScore` each carry TWO PadActions of the SAME
    // type (plain vs attributed point; plain vs tie-break set-summary — see
    // nested/kernel.ts's own comment on that pattern), and a group's
    // `actions` are TYPE strings, not action instances — see
    // `layoutActionTypes`'s doc comment in ./types.ts.
    return { id, prominence, actions: dedupeTypes(panel.actions.map((a) => a.type)) };
  });
  return { header: buildHeader(ctx), groups };
}

// ---------------------------------------------------------------------------
// Component — thin. Draws exactly `layout`/`view` hand it; the only NEW
// judgment call here is the plain `tennis.point` action's ONE-TAP Home/Away
// buttons (acceptance criterion: "Rally/point winner is one tap"), because
// `ActionForm`'s own zero-field auto-submit path does not collect
// attribution (view-model.ts's own comment: attribution collection is a
// later pass) — a bare tap on it would submit a payload missing the
// required `by`. Every other action tile reuses `ActionForm` unmodified.
// ---------------------------------------------------------------------------

type RenderAttribution = NonNullable<ActionFormProps["renderAttribution"]>;

/** SkinProps carries no `lineups`/`personNames` (unlike PadRenderer's own
 *  default attribution wiring) — a skin only ever gets `ctx.state`. For a
 *  `kind:"side"` item that is enough (the two entrant ids ARE the two
 *  options); for a `kind:"person"` item, `AttributionPicker`'s own
 *  `resolveSquads` degrade already produces its designed "no roster"
 *  message rather than a fabricated name — see attribution-picker.tsx's
 *  own header for that degrade path. This is a real, honest scope boundary
 *  of what a skin can offer without those two props, not a silent gap. */
function syntheticLineups(entrants: { home: string; away: string }): LineupPair {
  return { home: { entrantId: entrants.home, slots: [] }, away: { entrantId: entrants.away, slots: [] } };
}

function renderActionTile(
  action: PadActionView,
  dispatch: SkinDispatch,
  submittingType: string | null,
  renderAttribution: RenderAttribution,
  msg: MsgFn,
): ReactNode {
  if (action.availability.kind === "locked") return renderLockedTile(action, msg);
  return (
    <ActionForm
      key={action.type + action.labelKey.key}
      action={action}
      submitting={submittingType === action.type}
      onSubmit={(payload) => void dispatch(action.type, payload)}
      renderAttribution={renderAttribution}
    />
  );
}

/** The plain `tennis.point` action gets its own one-tap Home/Away pair
 *  (acceptance criterion); everything else in the primary group (the
 *  attributed point variant — ace/fault/winner/UE + server/scorer) draws
 *  through the ordinary `ActionForm` tap-to-expand path. */
function renderPrimaryAction(
  action: PadActionView,
  entrants: { home: string; away: string },
  dispatch: SkinDispatch,
  submittingType: string | null,
  renderAttribution: RenderAttribution,
  msg: MsgFn,
): ReactNode {
  const isPlainPoint = action.type === "tennis.point" && action.fields.length === 0;
  if (!isPlainPoint) return renderActionTile(action, dispatch, submittingType, renderAttribution, msg);
  if (action.availability.kind === "locked") return renderLockedTile(action, msg);
  const busy = submittingType === action.type;
  return (
    <div key={action.type + "-plain"} className="grid grid-cols-2 gap-2">
      <button
        type="button"
        className="btn btn-primary h-20 w-full text-lg"
        disabled={busy}
        onClick={() => void dispatch(action.type, { by: entrants.home })}
      >
        {msg("scorepad.attribution.home")}
      </button>
      <button
        type="button"
        className="btn btn-primary h-20 w-full text-lg"
        disabled={busy}
        onClick={() => void dispatch(action.type, { by: entrants.away })}
      >
        {msg("scorepad.attribution.away")}
      </button>
    </div>
  );
}

/** Resolves a group's own bare type strings to the real `PadActionView`s via
 *  the shared `actionByType` lookup (types.ts) -- the same type-keyed lookup
 *  every sibling skin uses (racquet-skin.tsx's `GroupBody`, period-skin.tsx's
 *  `renderActionForms`, football-skin.tsx's `renderGenericAction`), NOT an
 *  array index into `view.panels`. This is the S11 review gap 2 fix: before,
 *  `TennisSkin` zipped `layout.groups[i]` with `view.panels[i]` by position
 *  and drew from `panel.actions` (the VIEW) -- correct only because
 *  `tennisLayout` above happens to build one group per surviving panel,
 *  unfiltered, in the same pass, an invariant nothing on the Component side
 *  enforced. Rendering through the type lookup instead means the
 *  Component's render source IS the layout the coverage gate checks. A type
 *  a group names but that (defensively) cannot be found on `view` renders
 *  nothing for that slot rather than crashing; the gate itself guarantees
 *  this never fires against a real spec (skin-coverage.test.ts). */
function renderGroupActions(group: SkinGroup, view: PadView, render: (action: PadActionView) => ReactNode): ReactNode[] {
  return group.actions
    .map((type) => actionByType(view, type))
    .filter((action): action is PadActionView => action !== null)
    .map(render);
}

const GROUP_CAPTION_KEY: Readonly<Record<string, MessageKey>> = {
  point: "scorepad.skin.tennis.group.point",
  setScore: "scorepad.skin.tennis.group.setScore",
  gameAward: "scorepad.skin.tennis.group.gameAward",
  sanctions: "scorepad.skin.tennis.group.sanctions",
  interruptions: "scorepad.skin.tennis.group.interruptions",
};

export function TennisSkin(props: SkinProps) {
  const msg = useMsg();
  const { view, layout, dispatch, ctx, queueDepth, offline, submittingType } = props;

  const entrants = readEntrants(ctx.state);
  const lineups = syntheticLineups(entrants);
  const renderAttribution: RenderAttribution = (action, values, setValue) => (
    <AttributionPicker action={action} values={values} setValue={setValue} state={ctx.state} lineups={lineups} />
  );

  // Grouped by prominence alone -- each group's REAL PadActionView objects
  // are resolved by TYPE via `renderGroupActions` below (`actionByType`),
  // never by array index into `view.panels`. See `renderGroupActions`'s own
  // comment for why (S11 review gap 2).
  const primary = layout.groups.filter((g) => g.prominence === "primary");
  const secondary = layout.groups.filter((g) => g.prominence === "secondary");
  const drawer = layout.groups.filter((g) => g.prominence === "drawer");

  const queueLabel = offline
    ? msg("scorepad.queue.offline")
    : queueDepth > 0
      ? msg("scorepad.queue.pending", { count: queueDepth })
      : msg("scorepad.queue.synced");
  const queueAttention = offline || queueDepth > 0;

  return (
    <div className="space-y-3">
      {/* Dark "scoreboard" strip — this product area's established status-
       *  chrome signature (pad-renderer.tsx's own header comment); ordinary
       *  light card/btn surfaces below it, never a bespoke palette. */}
      <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]">
        {layout.header && layout.header.fields.length > 0 && (
          // flex-wrap, NOT a fixed-column grid: an equal-fraction column
          // (the first cut of this header used `grid-cols-5` + `truncate`)
          // silently ellipsised "0–0 (Bo3)" the moment the card sat in a
          // narrower host column — exactly the acceptance criterion this
          // value exists to prove, hidden by its own layout. Every field
          // here sizes to its own (short, bounded) content instead and wraps
          // to a second line rather than clipping.
          <div className="flex flex-wrap items-end gap-x-5 gap-y-2 px-3 pt-2.5 pb-2">
            {layout.header.fields.map((field) =>
              // The tiebreak field only exists WHILE the state is genuinely in
              // one (buildHeader above) — the one moment this header's
              // structure itself changes (acceptance criterion). An amber
              // badge, not another plain stat cell, makes that moment
              // readable at a glance rather than just another number in the
              // row — reusing the SAME amber this product area already uses
              // for "needs attention" (pad-renderer.tsx's queue pill,
              // panel.tsx's locked tile), never a new color.
              field.id === "tiebreak" ? (
                <span
                  key={field.id}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 py-1 pr-2.5 pl-2"
                >
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                  {field.captionKey && (
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-400/80">
                      {msg(field.captionKey as MessageKey)}
                    </span>
                  )}
                  <span className="text-sm font-bold tabular-nums text-amber-300">{field.value}</span>
                </span>
              ) : (
                <div key={field.id} className="shrink-0">
                  {/* S13/#422 W11 cutover — text-slate-500 on bg-slate-900
                   *  ~3.74:1, below AA's 4.5:1 (same pattern as
                   *  period-skin.tsx's header caption, dac2b6bb).
                   *  text-slate-400 clears it at ~6.79:1. */}
                  {field.captionKey && (
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                      {msg(field.captionKey as MessageKey)}
                    </p>
                  )}
                  <p
                    className={
                      field.emphasis
                        ? "text-xl font-bold tabular-nums tracking-tight text-white sm:text-2xl"
                        : "text-sm font-semibold tabular-nums text-slate-300"
                    }
                  >
                    {field.value}
                  </p>
                </div>
              ),
            )}
          </div>
        )}
        <div className="flex items-center justify-end border-t border-slate-800/70 px-3 py-2">
          <span
            className={`flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest ${
              queueAttention ? "text-amber-400" : "text-emerald-400"
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${queueAttention ? "animate-live-pulse bg-amber-400" : "bg-emerald-400"}`}
            />
            {queueLabel}
          </span>
        </div>
      </header>

      {layout.groups.length === 0 ? (
        // S13/#422 W11 cutover — text-purple-400 on this white .card
        // ~2.79:1, below AA's 4.5:1; text-purple-700 clears it at ~7.07:1
        // and is already this surface's established readable-purple step
        // (globals.css .label/.btn-ghost).
        <p className="card p-4 text-center text-sm text-purple-700">{msg("scorepad.emptyPhase")}</p>
      ) : (
        <>
          {primary.map((group) => (
            <div key={group.id} className="card space-y-3 p-3">
              {renderGroupActions(group, view, (action) =>
                renderPrimaryAction(action, entrants, dispatch, submittingType, renderAttribution, msg),
              )}
            </div>
          ))}

          {secondary.map((group) => (
            <section key={group.id} className="card p-3">
              <h3 className="label !mb-2">{msg(GROUP_CAPTION_KEY[group.id] ?? "scorepad.skin.more")}</h3>
              <div className="grid grid-cols-2 gap-2">
                {renderGroupActions(group, view, (action) => renderActionTile(action, dispatch, submittingType, renderAttribution, msg))}
              </div>
            </section>
          ))}

          {drawer.length > 0 && (
            <details className="card group p-3">
              <summary className="btn btn-ghost w-full cursor-pointer list-none justify-between">
                <span>{msg("scorepad.skin.more")}</span>
                {/* S13/#422 W11 cutover — text-purple-400 on white ~2.79:1,
                 *  below AA's 4.5:1; text-purple-700 clears it at ~7.07:1
                 *  and matches the label beside it (.btn-ghost's own
                 *  text-purple-700). */}
                <span aria-hidden className="text-xs text-purple-700 group-open:rotate-180">
                  ▾
                </span>
              </summary>
              <div className="mt-3 space-y-4">
                {drawer.map((group) => (
                  <div key={group.id} className="space-y-2">
                    <h4 className="label !mb-0">{msg(GROUP_CAPTION_KEY[group.id] ?? "scorepad.skin.more")}</h4>
                    <div className="flex flex-col gap-2">
                      {renderGroupActions(group, view, (action) => renderActionTile(action, dispatch, submittingType, renderAttribution, msg))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

export const tennisSkin: SkinDef = {
  key: "tennis",
  sports: ["tennis"],
  layout: tennisLayout,
  Component: TennisSkin,
};
