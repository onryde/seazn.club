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
// R2b (owner ruling, bowler-eligibility block, 2026-08-17) added a third,
// per-TILE mechanism: `TileSpec.disabled` (types.ts). Unlike the two above
// (which decide whether a tile is DECLARED for a phase at all), `disabled`
// keeps a tile fully visible and only removes its tap — rendered below as a
// real, native `disabled` <button> plus a `data-tile-disabled` hook, never a
// control that merely LOOKS inert.
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
import type { ContextStripSpec, PadPhase, TileKind, TileSpec } from "./types";

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

/**
 * R2b-cricket-over review fix (item 4, Important finding): a skin can
 * legally set `disabled: true` (types.ts) on a tile with NO `context()` at
 * all, or a `context()` whose slots all omit `message` — the chassis then
 * renders a real `<button disabled>` explaining nothing, and nothing
 * (type, test, or lint) caught the omission before this. Cricket only
 * pairs them by convention; nothing enforced it.
 *
 * SET-LEVEL, not a per-tile pairing: `TileSpec.disabled`'s own doc is
 * explicit that a single cause can disable MANY tiles at once and the
 * explanation lives ONCE, on whichever `ContextSlot` names the person/fact
 * at fault — never repeated per tile. So the rule here is "if any tile is
 * disabled, at least one context slot must carry a non-empty message
 * somewhere", never "every disabled tile needs its own paired slot".
 * `!!slot.message` (not `!== undefined`) matches item 3's own fix on the
 * renderer side — an empty-string message must not count as an
 * explanation either.
 *
 * R8 — a `kind: "mode"` slot's message does NOT count. Such a slot states
 * which entry lane the sport is locked into (`ContextSlot.kind`, ../types.ts)
 * and therefore ALWAYS carries a message whenever it is present at all: count
 * it and this validator goes vacuously green for every skin that declares
 * one, which is precisely the "a guard nothing kills is not tested" shape it
 * was written to catch. It is also not an answer to the question asked here —
 * "why is this tile grey" is never "because the innings is ball-by-ball";
 * cricket's coarse lane doesn't DISABLE the ball tiles, it withholds them
 * (`buildTiles`, skins/cricket.tsx).
 *
 * Never a throw — same non-throwing convention as `assertTileHierarchy`
 * below and `assertScorebugSpec` (../types.ts): a skin author's own test
 * suite asserts against the returned violation strings. Deliberately kept
 * OUT of pad-host.tsx's render path for the same reason — a disabled tile
 * with no explanation is a cosmetic authoring gap, not a correctness bug
 * that should crash a live pad mid-match. `assertTileHierarchy`/
 * `assertScorebugSpec` are themselves never wired into a live render
 * either (confirmed by search, R2b-cricket-over review), so this keeps
 * the file's one established convention for a structural-invariant
 * validator rather than inventing a second one.
 */
export function assertDisabledTilesExplained(
  tiles: readonly TileSpec[],
  context: ContextStripSpec | null,
): string[] {
  const disabledIds = tiles.filter((tile) => tile.disabled === true).map((tile) => tile.id);
  if (disabledIds.length === 0) return [];
  const hasMessage = (context?.slots ?? []).some((slot) => !!slot.message && slot.kind !== "mode");
  if (hasMessage) return [];
  return disabledIds.map((id) => `tile "${id}": disabled with no context slot message explaining why`);
}

/** Visual weight by kind — the hierarchy contract itself, table-driven so
 *  no per-tile special case can drift from it. */
// R5 — `minor` is 44, not 40. It was 40 painted plus a `::before` bleed of
// 2px top and bottom, on the reasoning that a pseudo-element expands the HIT
// area without growing the visible box. MEASURED in a real browser against a
// real pad (table tennis's serve-anchor tile, mobile-430): a click dispatched
// 1px above the tile lands on the GRID CONTAINER and the tile's sheet does not
// open — `document.elementFromPoint` there returns the grid, never the button.
// The bleed never worked, so every `minor` tile across every v3 skin has been
// a 40px touch target, under the 44px floor this repo holds itself to. The
// technique's own comment also warned that any ancestor with `overflow:
// hidden` would clip it back, undetectably — two ways to be wrong for one
// technique that was buying 4px. Paint the real height instead.
const KIND_MIN_HEIGHT: Record<TileKind, number> = {
  primary: 52,
  standard: 52,
  destructive: 52,
  minor: 44,
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
   *  hardcoded English — this renderer never prints raw copy. The two
   *  exceptions are `labelText`/`sublabelText` (types.ts's own doc): a
   *  pre-localised raw string the skin already resolved, rendered
   *  verbatim below with no call to `t` at all. */
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
  // R2b (owner ruling, bowler-eligibility block): a disabled tile stays
  // VISIBLE (below) but must not accept a tap. `isDisabled` gates both the
  // native `disabled` attribute (the real backstop — a browser never fires
  // onClick for a disabled <button>) AND handleClick's own early return
  // (belt-and-braces for any caller that invokes the onClick prop directly,
  // bypassing real DOM click semantics — e.g. this file's own test harness).
  const isDisabled = tile.disabled === true;
  // Route by action shape (task A1): {sheet} takes the distinct
  // onOpenSheet path; {event}/{swap:true} keep going through onAction
  // exactly as before — see TileGridProps.onOpenSheet's own doc.
  const handleClick = () => {
    if (isDisabled) return;
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
      data-tile-disabled={String(isDisabled)}
      disabled={isDisabled}
      onClick={handleClick}
      style={{ minHeight }}
      className={`relative min-w-0 flex flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1.5 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${spanClass} ${KIND_CLASS[tile.kind]}`}
    >
      <span className={`break-words ${tile.kind === "minor" ? "text-xs" : "text-sm"}`}>
        {tile.labelText ?? t(tile.label)}
      </span>
      {/* R3/task D — 90%, not 70%. Football was the FIRST skin to put a
          sublabel on a `primary` tile ("Goal / Home"), and white at 70% over
          violet-600 composites to 3.55:1 at 11px, under WCAG AA's 4.5 floor.
          90% is 5.02:1 there.

          R4/tennis — AND A PER-KIND TONE, because R3's reason for keeping ONE
          value was wrong. It argued 90% "strictly improves every other tile
          kind too (all of which sit on white or transparent)", which reads as
          if the saturated ground were the binding case. It is not: the binding
          case is the LIGHTEST TEXT, and that is `minor`'s slate-500. Dimmed to
          90% on white it composites to **3.91:1** — a fail, by the same margin
          and for the same reason as the one R3 had just fixed one kind over.

          Tennis's Award-game tiles are the first `minor` tile anywhere to
          carry a sublabel, so the axe scan only reached it now. The sublabel
          names WHICH SIDE the tile belongs to, so it is the most load-bearing
          word on a two-lane board — exactly R3's own argument for fixing it
          rather than lowering the bar.

          One step darker for that kind only (slate-600 at 90% = 5.83:1). The
          alpha stays uniform, so `primary`, `standard` and `destructive` are
          byte-identical and no signed-off cricket or football pixel moves.
          A per-kind branch is not a new idea here either — the label span
          directly above already branches on `tile.kind === "minor"`.

          Measured, not eyeballed, against the values the BUILT stylesheet
          actually ships: primary 5.02, standard 7.69, destructive 4.59, minor
          5.83. `__tests__/contrast.test.ts` now derives the kinds from
          KIND_CLASS itself and checks ALL of them — it previously checked two
          and claimed in its own describe name to check every one. */}
      {tile.sublabelText
        ? <span className={`break-words text-[11px] opacity-90 ${tile.kind === "minor" ? "text-slate-600" : ""}`}>{tile.sublabelText}</span>
        : tile.sublabel && <span className={`break-words text-[11px] opacity-90 ${tile.kind === "minor" ? "text-slate-600" : ""}`}>{t(tile.sublabel)}</span>}
    </button>
  );
}
