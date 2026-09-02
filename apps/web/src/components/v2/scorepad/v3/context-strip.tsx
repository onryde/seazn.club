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
import type { Blocked, CandidateMeta, ContextSlot, ContextStripSpec } from "./types";

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
  "min-w-0 max-w-full break-words rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

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
  blocked?: Blocked,
  meta?: Readonly<Record<string, CandidateMeta>>,
) {
  if (ids.length === 0) {
    return <p className="text-xs text-slate-600">{emptyText}</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => {
        // R2c: a blocked candidate stays VISIBLE and states its reason
        // (types.ts's `Blocked`) — a real native `disabled` button, never a
        // control that merely looks dimmed, and never a `title`/tooltip,
        // which is invisible on the touch surface this pad is built for.
        // `data-candidate-id`/`data-blocked` give a Playwright spec something
        // stable to assert on that is not styling.
        const reason = blocked?.[id];
        return (
          <button
            key={id}
            type="button"
            data-candidate-id={id}
            {...(reason ? { "data-blocked": "true" } : {})}
            disabled={reason !== undefined}
            onClick={reason !== undefined ? undefined : () => onPick(id)}
            style={{ minHeight: 44 }}
            className={
              reason !== undefined
                ? `${candidateButtonClass} cursor-not-allowed opacity-60`
                : candidateButtonClass
            }
          >
            {/* R5 (owner ruling 2026-08-30): the position code LEADS. Six
                teammates render as six identical wrapping names otherwise,
                and the person tapping this between rallies scans by position.
                Absent meta renders neither element, so every picker that
                supplies none — cricket's bowler, football's subs, every
                context strip — is byte-identical to before.

                `tabular-nums` and a fixed `min-w` keep the badges in a column
                so the eye can run down them; `shrink-0` is safe HERE and only
                here, because this badge's content is a 1-3 character code
                from the sport's own catalogue, never a name. The name beside
                it keeps `break-words` and is the element allowed to grow.

                NOT `aria-hidden`: the badge carries real information, and a
                screen-reader user picking between six teammates needs the
                position as much as a sighted one — hiding it would leave the
                row announcing a bare name. The accessible name becomes
                "MB <player> Libero", which reads correctly.

                `min-w` fits the LONGEST code the sport uses ("OPP"), not the
                average: one wider code pushing its neighbour's name out of
                line defeats exactly the scan this was built for. */}
            {meta?.[id]?.lead !== undefined && (
              <span
                data-candidate-lead={meta[id].lead}
                className="mr-2 inline-block min-w-[2.75rem] shrink-0 rounded bg-slate-100 px-1.5 text-center text-xs font-semibold tabular-nums text-slate-600"
              >
                {meta[id].lead}
              </span>
            )}
            <span className="break-words">{personNames[id] ?? t("eventCopy.unknownPerson")}</span>
            {meta?.[id]?.tag !== undefined && (
              <span
                data-candidate-tag={meta[id].tag}
                className="ml-2 break-words rounded-full border border-violet-300 px-2 text-xs font-medium text-violet-700"
              >
                {meta[id].tag}
              </span>
            )}
            {reason !== undefined && (
              <span className="ml-2 break-words text-xs font-normal text-red-600">{reason}</span>
            )}
          </button>
        );
      })}
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

/**
 * R8 — whether this slot can ever open a picker. `readOnly` is the skin's own
 * per-render verdict (cricket's bowler is editable at an over boundary and not
 * mid-over); `kind: "mode"` is unconditional and chassis-enforced, because a
 * mode a sport has already locked can never be moved from the strip
 * (ContextSlot.kind, ./types.ts). One predicate so the chip branch and the
 * picker guard can never disagree about which slots are static.
 */
export function isStatic(slot: Pick<ContextSlot, "readOnly" | "kind">): boolean {
  return slot.readOnly === true || slot.kind === "mode";
}

/**
 * ContextSlot.message (./types.ts) — a PRE-LOCALISED raw string, rendered
 * VERBATIM, never through `t()`.
 *
 * R2b (owner ruling, bowler-eligibility block, 2026-08-17): orthogonal to
 * `readOnly` (rendered whatever chip shape the slot took) and to the picker
 * (rendered whether or not one is open). Real visible text, never a
 * `title`/tooltip, which is invisible on the touch surface this pad is built
 * for, with a stable `data-*` hook for a Playwright spec. Most slots never set
 * this and then nothing renders.
 *
 * R2b-cricket-over review fix (item 3): the callers use a TRUTHY check, not
 * `!== undefined` — the same convention `StripItem.id` (scorebug.tsx) uses.
 * `message: ""` must read as "no message", not as a real, empty <p> that still
 * occupies DOM and layout.
 *
 * R5 — `messageTone` picks the register, DEFAULTING to "alert" so every
 * pre-existing slot (cricket's bowler) is byte-identical to before. A skin
 * whose message is a TIER rather than a FAULT opts into "info".
 *
 * A PLAIN FUNCTION, not a
 * component, for this file's own established reason: the node-only
 * `_hook-harness` walks `.props.children` and never invokes a nested custom
 * component, so a real `<SlotMessage/>` would make this text invisible to
 * `walk()`/`textOf()`. Shared by the generic block at the foot of the strip
 * and by the mode statement, which renders its own so the sentence stays
 * glued to the line it explains.
 */
function renderSlotMessage(slot: ContextSlot) {
  return (
    <p
      key={`${slot.id}-message`}
      data-role="context-slot-message"
      data-slot-id={slot.id}
      data-message-tone={slot.messageTone ?? "alert"}
      className={`text-xs font-medium ${
        (slot.messageTone ?? "alert") === "info" ? "text-amber-700" : "text-red-600"
      }`}
    >
      {slot.message}
    </p>
  );
}

/**
 * WS-M copy round 2 (controller ruling, 2026-09-02) — a `kind: "mode"` slot
 * renders as PLAIN TEXT WITH A LOCK GLYPH, never a pill.
 *
 * The reason is agency, not topic. The strip sits directly under the pad's
 * band control, which is the scorer's OWN choice of how much to record and is
 * a real, tappable chip. A mode statement is the opposite: a fact the sport
 * locked when the period/innings began, that no control on this pad can move.
 * Both are granularity, so words alone separate them weakly — and a scorer
 * under time pressure reads SHAPE before words. Three independent signals now
 * say "not a control", and the strongest of them is that this is not shaped
 * like one: the noun the skin puts in its label ("This innings: …"), the
 * absence of pill styling, and the lock.
 *
 * Rendered as its own line rather than inside the chip row, so the row stays
 * a row of controls — and carrying its own message, so the statement and the
 * sentence explaining it cannot be separated by another slot's message.
 * `data-role="context-mode"`, deliberately NOT `context-chip`: a 44px
 * hit-target sweep over the chips must never measure something nobody can tap.
 */
function renderModeStatement(slot: ContextSlot, personNames: Readonly<Record<string, string>>, t: TFn) {
  return (
    <div key={`${slot.id}-mode`} className="flex flex-col gap-0.5">
      {/* `data-role` sits on the STATEMENT LINE, not on this wrapper: a
          wrapper carrying it would make `toHaveText` on the role return the
          statement CONCATENATED with its own message ("This innings:
          Over-by-overSet when this innings began, …"), which is what the
          first version of this did and what the e2e caught. The message keeps
          its own long-standing `context-slot-message` role. */}
      <p
        data-role="context-mode"
        data-slot-kind="mode"
        className="flex items-start gap-1.5 text-sm font-medium text-slate-700"
      >
        {/* The pad's own inline-SVG idiom (detail-dock.tsx, recording-chip.tsx):
            a 16-unit box, stroke-only, `currentColor`. `aria-hidden` because
            the label's own noun already carries the meaning in text — a screen
            reader announcing a lock as well would say it twice. `mt-0.5`
            keeps it optically centred on the first line when the label wraps
            at 320. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" />
          <rect x="3.25" y="7" width="9.5" height="6.25" rx="1.75" />
        </svg>
        <span className="break-words">{chipLabel(slot, personNames, t)}</span>
      </p>
      {!!slot.message && renderSlotMessage(slot)}
    </div>
  );
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
  //
  // R8: `isStatic` — a `kind: "mode"` slot is read-only whatever it declares
  // (ContextSlot.kind's own doc, ./types.ts, guarantee 1). A mode is locked by
  // definition; the chassis enforces that rather than trusting every skin to
  // remember `readOnly: true` beside it.
  const activeSlot = spec.slots.find((s) => s.id === activeSlotId && !isStatic(s)) ?? null;

  return (
    <div data-role="context-strip" className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 max-md:flex-col">
        {/* WS-M round 2: mode statements are NOT chips and never enter this
            row — see `renderModeStatement` above. */}
        {spec.slots.filter((slot) => slot.kind !== "mode").map((slot) => {
          // Blocker 2 (R2 review, `docs/superpowers/plans/2026-08-16-
          // scorepad-v3-r2-cricket.md`): a readOnly slot (ContextSlot.
          // readOnly's own doc, ./types.ts) renders as plain, non-
          // interactive markup — same chip footprint, no <button>, no
          // onClick, no aria-pressed, no "unset" affordance (there is
          // nothing a tap could fix). It still shows real information —
          // dropping it entirely would lose the on-strike marker/name for
          // no gain — it just never pretends to be a control the engine
          // will actually honour.
          if (isStatic(slot)) {
            return (
              <span
                key={slot.id}
                data-role="context-chip"
                data-readonly="true"
                // R8 — the ONE thing that tells a mode statement apart from a
                // person chip in the DOM. Both wear the identical read-only
                // chip (deliberately: no fifth chip style), so a Playwright
                // spec asserting "the pad says which mode this innings is in"
                // has nothing else stable to select on. Emitted for every
                // slot, not only mode ones, so the attribute means the same
                // thing everywhere it appears.
                data-slot-kind={slot.kind ?? "person"}
                style={{ minHeight: 44 }}
                className="inline-flex min-w-0 max-w-full cursor-default items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 max-md:w-full"
              >
                <span className="break-words max-md:truncate">{chipLabel(slot, personNames, t)}</span>
              </span>
            );
          }
          const active = slot.id === activeSlotId;
          const unset = slot.required && !slot.personId;
          return (
            <button
              key={slot.id}
              type="button"
              data-role="context-chip"
              data-readonly="false"
              data-slot-kind={slot.kind ?? "person"}
              aria-pressed={active}
              onClick={() => setActiveSlotId(active ? null : slot.id)}
              style={{ minHeight: 44 }}
              className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 max-md:w-full ${
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
              <span className="break-words max-md:truncate">{chipLabel(slot, personNames, t)}</span>
            </button>
          );
        })}
      </div>
      {activeSlot &&
        renderCandidateRow(
          // R2c SCOPE: `candidates` supersedes `pool` entirely — the same
          // `?? resolvePool(...)` line guided-sheet.tsx already uses for
          // SheetPersonStep (G6), so the two surfaces narrow identically.
          // Deliberately `??`, not a truthiness check: an EMPTY candidates
          // list means "nobody is eligible" and must render the empty-pool
          // text, never fall back to the whole pool.
          activeSlot.candidates ?? resolvePool(activeSlot, view),
          personNames,
          t,
          (personId) => {
            onSelect(activeSlot.id, personId);
            setActiveSlotId(null);
          },
          t("scorepad.attribution.noRoster"),
          activeSlot.blocked,
        )}
      {/* R2b (owner ruling, bowler-eligibility block, 2026-08-17):
          ContextSlot.message (types.ts) — a pre-localised raw string,
          rendered VERBATIM (never through t()). Orthogonal to readOnly
          (rendered regardless of which chip shape a slot took above) and
          to the picker (rendered regardless of whether activeSlot is
          open) — real visible text, never a title/tooltip (invisible on
          touch), with a stable data-* hook for a Playwright spec. Most
          slots never set this and this block then renders nothing.

          R2b-cricket-over review fix (item 3): a TRUTHY check, not
          `!== undefined` — the same convention StripItem.id (scorebug.tsx)
          already uses. `message: ""` must read as "no message", not as a
          real, empty, red <p>: a skin computing `message: cond ? text : ""`
          would otherwise render an empty element that still occupies DOM
          (and, being a <p>, layout) for nothing. Not reachable today
          (cricket never sets `""`), but the divergence between "absent"
          and "empty" was a landmine for the next skin to compute one. */}
      {/* WS-M round 2 — each mode statement, with its own message glued to it. */}
      {spec.slots.filter((slot) => slot.kind === "mode").map((slot) => renderModeStatement(slot, personNames, t))}
      {spec.slots
        .filter((slot) => !!slot.message && slot.kind !== "mode")
        .map((slot) => renderSlotMessage(slot))}
    </div>
  );
}
