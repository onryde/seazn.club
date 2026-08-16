"use client";
// Context strip + shared candidate-picker plumbing — R1 chassis (Task 8).
// Persistent chips above the tile grid for events whose payload REQUIRES
// people (cricket striker/non-striker/bowler, spec §2.4): each ContextSlot
// (types.ts) renders as a real button naming the slot + its current person;
// tapping it opens an inline picker of that slot's own candidate pool,
// tapping a candidate commits the change via `onSelect` and closes the
// picker. Nothing here dispatches to the pipeline itself (same posture as
// scorebug.tsx's onTap / tile-grid.tsx's onAction) — a caller not yet wired
// to a real skin can still render a fully-formed, real, interactive strip.
//
// resolvePool(slot, view) — Ruling F (progress.md, scout re-pin 2026-08-16):
// the plan originally pinned attribution-picker.tsx's `candidatesForPerson`
// as the accessor to reuse, but that helper calls `playingSquad()` alone
// with NO on-field/bench split (bench players ARE included for a role-less
// person item there) — reusing it here would let a swap sheet offer an
// on-field player as their own substitute. This function instead reads the
// engine's own SquadMember.onField flag directly: "onfield" is
// `onFieldPersons(side)` verbatim; "bench" is `playingSquad(side)` MINUS
// whoever `onFieldPersons` names; "all" is `playingSquad(side)` unfiltered.
// Both engine selectors already filter to `role === "player"` internally
// (core/lineup.ts) — a coach/staff member never reaches any pool from here,
// with no re-check needed in this file.
//
// SCOPE NOTE: `PoolView` carries exactly ONE `SideSquad` — which side's
// squad backs a given slot/step is a decision this file does not make.
// Cricket's own real wiring (striker/non-striker from the batting side,
// bowler from the fielding side) is R2+'s job, the same deferral Ruling F's
// own "cost if wrong" already prices in: a later skin re-picks the pool
// source, contained to this file's callers.
//
// RENDERER DESIGN (frontend-design pass, R1/Task 8). Both new primitives in
// this task are about PEOPLE, not score (Scorebug's night tile) or actions
// (TileGrid's daylight buttons) — a third information layer in the pad, and
// it deliberately reuses the other two layers' existing tokens rather than
// adding a new one: a resting chip mirrors TileGrid's own `standard` tile
// (white, slate-200 border, slate-700 text); the chip currently being
// edited (its picker open) fills violet-600 — TileGrid's own primary accent
// and DetailDock's own "selected chip" treatment, reused a third time for
// the same reason both gave it: this is the thing engaged right now, the
// same visual weight as a primary tile mid-tap. An unset REQUIRED slot gets
// no new colour either — a small lime-400 dot, the exact device
// scorebug.tsx already uses for its serving indicator and live-phase dot,
// reused here to mean the same thing it always means in this app: "look
// here, this is live/pending." Typography stays off `.app-display` for the
// same reason tile-grid.tsx gives — a chip is a control, not a readout.
import { useState } from "react";
import type { SideSquad } from "@seazn/engine/core";
import { onFieldPersons, playingSquad } from "@seazn/engine/core";
import type { ContextSlot, ContextStripSpec } from "./types";

export interface PoolView {
  readonly squad: SideSquad;
}

export interface PoolSlot {
  readonly pool: "onfield" | "bench" | "all";
}

/** The pool-resolution primitive both this file and swap-sheet.tsx build
 *  on — see the file header for Ruling F. */
export function resolvePool(slot: PoolSlot, view: PoolView): readonly string[] {
  const onField = onFieldPersons(view.squad);
  if (slot.pool === "onfield") return onField;
  const all = playingSquad(view.squad).map((m) => m.personId);
  if (slot.pool === "all") return all;
  const onFieldSet = new Set(onField);
  return all.filter((id) => !onFieldSet.has(id));
}

/** Message-lookup shape every v3 chassis renderer's own `t` prop already
 *  takes (scorebug.tsx, tile-grid.tsx, detail-dock.tsx) — loosely typed
 *  because the labels rendered through it (ContextSlot.label,
 *  SwapSheetSpec.offLabel/onLabel) are plain `string` i18n keys, not
 *  literal MessageKeys. */
export type TFn = (key: string, vars?: Record<string, string | number>) => string;

const candidateButtonClass =
  "min-w-0 shrink-0 break-words rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

/**
 * A row of real 44px candidate buttons, or `emptyText` when the pool is
 * empty — never a disabled control either way. A PLAIN FUNCTION,
 * deliberately not its own JSX component: this repo's node-only
 * `_hook-harness` walks a rendered tree through `.props.children` only,
 * never invoking a nested custom component's own function (the same
 * precedent as attribution-picker.tsx's `renderAttributionItem`) — a
 * genuinely separate `<CandidateRow/>` would make every button inside it
 * invisible to `walk()`/`textOf()`. Exported so swap-sheet.tsx renders the
 * exact same chip shape rather than a parallel one.
 */
export function renderCandidateRow(
  ids: readonly string[],
  personNames: Readonly<Record<string, string>>,
  t: TFn,
  onPick: (personId: string) => void,
  emptyText: string,
) {
  if (ids.length === 0) {
    return <p className="text-xs text-slate-600">{emptyText}</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onPick(id)}
          style={{ minHeight: 44 }}
          className={candidateButtonClass}
        >
          {personNames[id] ?? t("eventCopy.unknownPerson")}
        </button>
      ))}
    </div>
  );
}

export interface ContextStripProps {
  spec: ContextStripSpec;
  view: PoolView;
  personNames: Readonly<Record<string, string>>;
  t: TFn;
  /** Fires when a candidate is tapped in an open slot's picker. Nothing in
   *  this file decides what the selection MEANS (which lineup event it
   *  becomes) — same posture as scorebug.tsx's onTap/tile-grid.tsx's
   *  onAction: a caller not yet wired to the pipeline can still render a
   *  fully real, interactive strip. */
  onSelect: (slotId: string, personId: string) => void;
}

function chipLabel(slot: ContextSlot, personNames: Readonly<Record<string, string>>, t: TFn): string {
  const label = t(slot.label);
  if (!slot.personId) return label;
  const name = personNames[slot.personId] ?? t("eventCopy.unknownPerson");
  return `${label}: ${name}`;
}

/**
 * Renders a ContextStripSpec as a row of persistent, tappable chips —
 * "every ball tap already carries its people" (spec §2.4). Tapping a chip
 * opens ITS OWN slot's picker (resolvePool, filtered to that slot's
 * declared `pool`) directly beneath the row; tapping a candidate commits
 * via `onSelect` and closes the picker. Only one slot's picker is open at a
 * time (component-local state) — this file makes no attempt at a
 * multi-picker layout, matching the brief's own "persistent chips... tap to
 * change" wording (one interruption at a time).
 */
export function ContextStrip({ spec, view, personNames, t, onSelect }: ContextStripProps) {
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  if (spec.slots.length === 0) return null;
  // Blocker 2 (R2 review): a readOnly slot's picker must never open — this
  // guards even a stray activeSlotId somehow naming one (belt-and-braces;
  // the row below already never attaches an onClick to a readOnly chip, so
  // activeSlotId can never actually BE set to one in the first place).
  const activeSlot = spec.slots.find((s) => s.id === activeSlotId && !s.readOnly) ?? null;

  return (
    <div data-role="context-strip" className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {spec.slots.map((slot) => {
          // Blocker 2 (R2 review, `docs/superpowers/plans/2026-08-16-
          // scorepad-v3-r2-cricket.md`): a readOnly slot (ContextSlot.
          // readOnly's own doc, ./types.ts) renders as plain, non-
          // interactive markup — same chip footprint, no <button>, no
          // onClick, no aria-pressed, no "unset" affordance (there is
          // nothing a tap could fix). It still shows real information —
          // dropping it entirely would lose the on-strike marker/name for
          // no gain — it just never pretends to be a control the engine
          // will actually honour.
          if (slot.readOnly) {
            return (
              <span
                key={slot.id}
                style={{ minHeight: 44 }}
                className="inline-flex min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700"
              >
                <span className="break-words">{chipLabel(slot, personNames, t)}</span>
              </span>
            );
          }
          const active = slot.id === activeSlotId;
          const unset = slot.required && !slot.personId;
          return (
            <button
              key={slot.id}
              type="button"
              aria-pressed={active}
              onClick={() => setActiveSlotId(active ? null : slot.id)}
              style={{ minHeight: 44 }}
              className={`inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 ${
                active
                  ? "border-transparent bg-violet-600 text-white hover:bg-violet-700"
                  : unset
                    ? "border-dashed border-slate-300 bg-transparent text-slate-500 hover:bg-slate-50"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {unset && !active && (
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-lime-400" />
              )}
              <span className="break-words">{chipLabel(slot, personNames, t)}</span>
            </button>
          );
        })}
      </div>
      {activeSlot &&
        renderCandidateRow(
          resolvePool(activeSlot, view),
          personNames,
          t,
          (personId) => {
            onSelect(activeSlot.id, personId);
            setActiveSlotId(null);
          },
          t("scorepad.attribution.noRoster"),
        )}
    </div>
  );
}
