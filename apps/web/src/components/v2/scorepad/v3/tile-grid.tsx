"use client";

// TileGrid — R1 chassis (Task 6). The pad's action surface: every tap a
// scorer makes to advance the game lives here. The pad this replaces was
// rejected for "monster-button monotony" — every action rendered at the
// same visual weight, so Abandon read like a rally tap. Two pure functions
// make that structurally impossible for any skin built on this chassis:
//
//   tilesForPhase(tiles, phase)  — a skin's `tiles(view)` can declare a
//     tile for any subset of phases; this filters to the ones live RIGHT
//     NOW, so set-score entry never appears mid-game and post-match
//     actions never appear while play is on (D-16).
//   assertTileHierarchy(tiles)  — violations (never a throw — same
//     convention as `assertScorebugSpec` in ./types.ts), when a skin
//     declares more than two `primary` tiles for one phase. Framed PER
//     PHASE: two primaries in "live" and two more in "post" is a legal
//     4-primary skin; three in the SAME phase is not (D-12).
//
// Match-losing actions (Forfeit, Abandon) never live in this grid by
// design — they belong to console chrome, not the scorer's tap surface —
// so this file adds no affordance for them. This is a CONVENTION this
// file does not enforce: neither TileSpec nor TileKind impose a type or
// runtime block on a skin declaring one anyway (review finding 3, R1/task
// 6 fix round 1) — deferred to skin-level validation in a later wave, not
// a guarantee this file makes today.
//
// RENDERER DESIGN (frontend-design pass, R1/Task 6). This grid sits in the
// DAYLIGHT product shell, not the night-tile Scorebug (Task 5, ./scorebug
// .tsx) — a different surface with its own idiom, not to be confused with
// it. "One hue per signal" is the rule that keeps hierarchy legible at a
// tap-and-glance: violet appears ONLY on `primary` (this chassis's own
// accent — deliberately NOT the legacy pad's `.btn-primary` purple; see
// KIND_CLASS below), red appears ONLY on `destructive` (reusing the app's
// existing `.btn-danger` red-600/red-200 pair — globals.css — so "red"
// keeps meaning the same thing everywhere in the product, not a new
// invented shade), and `standard`/`minor` are BOTH neutral slate,
// differentiated from each other by weight, border style (solid vs
// dashed), and size — never by color. If a third hue ever shows up on
// this grid, that itself is the bug: it means something is competing with
// `primary` for attention.
//
// Typography deliberately stays off `.app-display` — Task 5 reserved that
// face for the Scorebug's live readout (its own header comment: lime and
// the display face mark "this is a readout", never a control). A tile is
// a control, never a readout; keeping that split absolute is itself a
// legibility signal, so tile labels render in the ordinary UI face, same
// as every other pad button (action-form.tsx, fidelity-switcher.tsx,
// cricket-skin.tsx).
//
// Focus rings are NOT hand-rolled here: globals.css's
// `:where(a,button,summary,[role="tab"]):focus-visible` rule already
// covers every real <button>, and every tile is one.
import type { PadPhase, TileKind, TileSpec } from "./types";

/**
 * Tiles whose `phases` include `phase`. The mechanism that stops
 * set-score entry being offered mid-game and stops post-match actions
 * appearing while play is live (D-16).
 */
export function tilesForPhase(tiles: readonly TileSpec[], phase: PadPhase): TileSpec[] {
  return tiles.filter((tile) => tile.phases.includes(phase));
}

const ALL_PHASES: readonly PadPhase[] = ["pre", "live", "post"];

/**
 * Violations for a tile set — never a throw (mirrors `assertScorebugSpec`
 * in ./types.ts). Counted PER PHASE, independently: a tile that declares
 * several phases counts toward each one it names. More than two `primary`
 * tiles for any single phase is a violation (D-12) — the mechanism that
 * makes "monster-button monotony" structurally impossible.
 */
export function assertTileHierarchy(tiles: readonly TileSpec[]): string[] {
  const out: string[] = [];
  for (const phase of ALL_PHASES) {
    const count = tiles.filter((tile) => tile.kind === "primary" && tile.phases.includes(phase)).length;
    if (count > 2) {
      out.push(`phase "${phase}": ${count} primary tiles declared (max 2)`);
    }
  }
  return out;
}

/** Visual weight by kind — the hierarchy contract itself, table-driven so
 *  no per-tile special case can drift from it. */
const KIND_MIN_HEIGHT: Record<TileKind, number> = {
  primary: 52,
  standard: 52,
  destructive: 52,
  minor: 40,
};

/** Column span -> literal Tailwind class. A template-interpolated
 *  `col-span-${n}` would never be picked up by Tailwind's static class
 *  scanner (it scans source for literal strings) — this lookup keeps
 *  every class Tailwind needs to see written out in full. */
const SPAN_CLASS: Record<NonNullable<TileSpec["span"]>, string> = {
  1: "col-span-1",
  2: "col-span-2",
  3: "col-span-3",
  4: "col-span-4",
};

/** One hue per signal (see file header): violet fill = primary (this
 *  chassis's own accent), red outline = destructive (the app's existing
 *  `.btn-danger` red-600/red-200), everything else neutral slate. */
const KIND_CLASS: Record<TileKind, string> = {
  primary: "border-2 border-transparent bg-violet-600 font-semibold text-white shadow-sm hover:bg-violet-700",
  standard: "border-2 border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50",
  destructive: "border-2 border-red-200 bg-white font-medium text-red-600 hover:bg-red-50",
  minor: "border-2 border-dashed border-slate-300 bg-transparent font-medium text-slate-500 hover:bg-slate-50",
};

export interface TileGridProps {
  tiles: readonly TileSpec[];
  phase: PadPhase;
  /** Interpolating message lookup — same shape ribbon.ts's MsgFn and
   *  scorebug.tsx's `t` prop take (useMsg()/msgFor() both hand callers
   *  this shape). Tile `label`/`sublabel` are i18n keys (types.ts), never
   *  hardcoded English — this renderer never prints raw copy. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Fires with the tapped tile's own `action`, untouched, for every action
   *  shape EXCEPT `{sheet}` (task A1 carved that one out below — see
   *  `onOpenSheet`). R1 ships no pipeline/swap wiring for this component
   *  yet (out of this file's scope by brief) — a caller not yet ready to
   *  dispatch can render a fully-formed, real, still-inert grid, same
   *  posture scorebug.tsx's optional `onTap` takes for the same reason. */
  onAction?: (action: TileSpec["action"], tile: TileSpec) => void;
  /** Fires INSTEAD of `onAction` when a tapped tile's action is
   *  `{sheet: string}` — the sheet key names an entry in the skin's own
   *  `SkinDefV3.sheets` (types.ts), which a host resolves into a
   *  `GuidedSheetSpec` for ./guided-sheet.tsx (task A1). Kept as a
   *  DISTINCT path rather than folded into `onAction` because a sheet-open
   *  is not itself a scoring action — it starts a multi-step flow that
   *  only PRODUCES one once the wizard completes (guided-sheet.tsx's own
   *  `onComplete`), so a single generic `onAction` callback would have to
   *  re-discriminate the union right back apart to tell the two apart
   *  anyway. `{event}` and `{swap: true}` tiles are UNCHANGED by this: they
   *  keep going through `onAction` exactly as R1 shipped it. A later task
   *  wires both this and swap's own host handling — this file's job is
   *  correct ROUTING only. */
  onOpenSheet?: (sheetKey: string) => void;
}

/**
 * Renders the phase-filtered tile set. A THIN mapping, deliberately (see
 * task-6-brief.md: "the renderer is a thin mapping asserted by e2e
 * later") — every visual decision is table-driven off `kind`
 * (KIND_MIN_HEIGHT / KIND_CLASS above), never a per-tile special case.
 */
export function TileGrid({ tiles, phase, t, onAction, onOpenSheet }: TileGridProps) {
  const visible = tilesForPhase(tiles, phase);
  return (
    <div className="grid grid-cols-4 gap-2">
      {visible.map((tile) => (
        <Tile key={tile.id} tile={tile} t={t} onAction={onAction} onOpenSheet={onOpenSheet} />
      ))}
    </div>
  );
}

function Tile({
  tile,
  t,
  onAction,
  onOpenSheet,
}: {
  tile: TileSpec;
  t: TileGridProps["t"];
  onAction?: TileGridProps["onAction"];
  onOpenSheet?: TileGridProps["onOpenSheet"];
}) {
  const minHeight = KIND_MIN_HEIGHT[tile.kind];
  const spanClass = SPAN_CLASS[tile.span ?? 1];
  // Route by action shape (task A1): {sheet} takes the distinct
  // onOpenSheet path; {event}/{swap:true} keep going through onAction
  // exactly as before — see TileGridProps.onOpenSheet's own doc.
  const handleClick = () => {
    if ("sheet" in tile.action) {
      onOpenSheet?.(tile.action.sheet);
    } else {
      onAction?.(tile.action, tile);
    }
  };
  return (
    <button
      type="button"
      data-tile-id={tile.id}
      data-tile-kind={tile.kind}
      onClick={handleClick}
      style={{ minHeight }}
      className={`relative min-w-0 flex flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1.5 text-center transition-colors ${spanClass} ${KIND_CLASS[tile.kind]} ${
        tile.kind === "minor"
          ? // The 40px minor tile is visually smaller than the 44px touch
            // floor every other tile meets by height alone. Rather than
            // grow the visible box (and blow the deliberately-smaller
            // "quietest tile" size), a `::before` pseudo-element expands
            // the HIT area only: absolutely positioned, 2px negative
            // inset top and bottom (40 + 2 + 2 = 44px), zero visual paint
            // (no `content` other than Tailwind's default empty string —
            // the SAME after:absolute after:inset-0 idiom
            // ui/entity-card.tsx already uses in this repo to stretch a
            // hit area, applied here to add 2px top/bottom instead of
            // covering the whole card). A pseudo-element is generated
            // content of its host <button>, not a separate hit-test
            // target or DOM node, so a click landing in that 2px margin
            // still fires this button's own onClick — no extra element,
            // no aria workaround needed.
            //
            // CAVEAT (review finding 2, fix round 1): this bleed is
            // escapable. Any ancestor sized flush to this tile with
            // `overflow: hidden`/`clip` (a scroll sheet, a tightly
            // clipped card) silently clips the pseudo-element back to a
            // real 40px hit area with no warning anywhere at runtime. A
            // future integrator wiring this grid into such a container
            // must either keep clearance around minor tiles or stop
            // relying on this technique for the 44px floor.
            "before:absolute before:inset-x-0 before:-inset-y-0.5"
          : ""
      }`}
    >
      <span className={`break-words ${tile.kind === "minor" ? "text-xs" : "text-sm"}`}>{t(tile.label)}</span>
      {tile.sublabel && <span className="break-words text-[11px] opacity-70">{t(tile.sublabel)}</span>}
    </button>
  );
}
