"use client";
// The attribution picker (S10/#419 W8, chassis item 3) — plugs into
// pad-renderer.tsx's `renderAttribution` typed seam via action-form.tsx:
// `{renderAttribution?.(action, values, setValue)}`, rendered once an
// action's form is expanded. Collects each declared `PadAttributionItem`
// (view-model.ts passes `action.attribution` through untouched from the
// engine's own `padSpec`) into the SAME flat `values`/`setValue` map
// `buildActionPayload` reads at confirm time — never a parallel one.
//
// STATELESS BY DESIGN: every value lives in the caller's `values` map
// (ActionForm's own `useState`), so this file owns no `useState` of its
// own — a re-tap toggles a chip off by calling `setValue(path, undefined)`,
// exactly like ActionForm's own field controls.
//
// WHERE THE SQUAD COMES FROM (the load-bearing part of this file). Squad
// membership lives in the module's own FOLDED state, not a kickoff
// snapshot (S3/#426's `core/lineup.ts`) — but `foldClient`
// (module-client.ts) calls the engine's `foldMatch`, which returns ONLY
// `State`, discarding the kernel's own `SquadState` return value entirely.
// Whether a module's `State` carries a usable copy back is OPTIONAL and
// per-module: `sports/squad-state.ts`'s `SquadCarrier` is the ADOPTED
// shape (`state.squads: SquadState`, written by `onLineup` for period/
// setbased/nested/cricket kernels) — but football manages its OWN private
// `state.squads: {home: FootballSquad, away: FootballSquad}` at the exact
// same field name, a totally different shape (onPitch/bench/offUsed/
// sentOff/sinBin, no `members` array at all). Reading `state.squads` blind
// would silently misinterpret football's squad as empty/malformed. Hence
// `isSquadState`/`resolveSquads` below verify the shape structurally
// (`.home.members` is an array) before trusting it, and degrade to
// `initSquads(lineups)` — the SAME kernel function, run fresh off the
// kickoff team sheet — for every case that isn't a genuine adopted
// SquadState: no live squads at all, OR a private non-adopting shape like
// football's. That degrade also naturally covers "no roster at all" (an
// empty LineupPair still folds to a valid, empty SquadState), so every
// tier funnels through the exact same selector calls.
//
// personsAtPosition/playingSquad (core/lineup.ts) already filter to
// `role === "player"` — a coach or staff member is therefore structurally
// never offered here, without this file re-checking role itself.
import type { ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { padLabel } from "@/lib/scoring-vocab";
import type { MsgFn } from "@/lib/scoring-vocab";
import type { LineupPair, SideSquad, SquadState } from "@seazn/engine/core";
import { initSquads, personsAtPosition, playingSquad } from "@seazn/engine/core";
import type { PadAttributionItem, PadFieldValue } from "@seazn/engine/sport";
import type { ActionValues } from "./action-form";
import { deriveFieldPathLabel } from "./view-model";
import type { PadActionView } from "./view-model";

function isSideSquadLike(x: unknown): x is SideSquad {
  return !!x && typeof x === "object" && Array.isArray((x as { members?: unknown }).members);
}

/** Structural check: does this value genuinely look like the kernel's own
 *  `SquadState` (`{home,away}`, each with a `.members` array) — see the
 *  module header for why a shape check, not a field-name check, is
 *  required here. */
export function isSquadState(x: unknown): x is SquadState {
  if (!x || typeof x !== "object") return false;
  const s = x as { home?: unknown; away?: unknown };
  return isSideSquadLike(s.home) && isSideSquadLike(s.away);
}

/** The squad to read attribution candidates from: the module's own adopted
 *  live squad when present and genuinely `SquadState`-shaped, else a fresh
 *  `initSquads(lineups)` off the kickoff team sheet — see the module
 *  header for the three degrade tiers this collapses into one call. */
export function resolveSquads(state: unknown, lineups: LineupPair): SquadState {
  const carried = state && typeof state === "object" ? (state as { squads?: unknown }).squads : undefined;
  if (isSquadState(carried)) return carried;
  return initSquads(lineups);
}

/** Candidates for a `kind:"person"` item, from BOTH sides — the engine's
 *  `PadAttributionItem` names no side for a person item (cricket's fielder
 *  may be either side's player structurally), so a sport-agnostic picker
 *  cannot narrow further than the item itself does. `role`, when present,
 *  is read as a `personsAtPosition` position key (e.g. "GK") rather than
 *  the whole playing squad — the picker's own narrowing, not an engine
 *  concept beyond what the selector already provides. */
export function candidatesForPerson(
  item: Extract<PadAttributionItem, { kind: "person" }>,
  squads: SquadState,
): readonly { personId: string; side: "home" | "away" }[] {
  const out: { personId: string; side: "home" | "away" }[] = [];
  for (const side of ["home", "away"] as const) {
    const ids = item.role ? personsAtPosition(squads[side], item.role) : playingSquad(squads[side]).map((m) => m.personId);
    for (const id of ids) out.push({ personId: id, side });
  }
  return out;
}

/**
 * Caption for one attribution item, in three tiers: the engine's own
 * `labelKey` when declared (S7/#427's `padLabel`); else, for a PERSON item,
 * its own path humanised (`scorer` -> "Scorer"); else the chassis fallback
 * `${kind} #${index+1}`, optionally prefixed with the owning action's own
 * label. Mirrors action-form.tsx's `renderField` fallback pattern
 * (`${fallbackName} #${index+1}`) for the same accessibility reason: a
 * screen reader landing directly on a control needs a self-contained name,
 * not just a bare ordinal. `actionLabel` is optional — timeline.tsx reuses
 * this same caption for a compact summary line where that extra context
 * does not apply.
 */
export function attributionItemCaption(
  item: PadAttributionItem,
  index: number,
  msg: MsgFn,
  actionLabel?: string,
): string {
  if (item.labelKey) return padLabel(item.labelKey.key, msg, item.labelKey.label);

  // S12/#421 — before the ordinal, humanise the item's OWN path. Football's
  // goal declares `scorer` and `assist` with no labelKey, so the ordinal
  // fallback captioned its two person pickers "Goal — Person #2" and
  // "Goal — Person #3": a scorer looking at the headline flow of the second
  // busiest pad could not tell which picker credited the goal and which the
  // assist. Measured in a real browser, flag on, against a real roster.
  //
  // Derived in the RENDERER rather than by declaring engine label keys — the
  // precedent S10/#419 set for uncaptioned FIELDS, and for the same reason it
  // gave then: the alternative is minting 100+ keys across four locales for
  // surfaces a skin may relabel anyway. `deriveFieldPathLabel` is the exact
  // function that pass already uses, so the two fallbacks read identically
  // (`scorer` -> "Scorer", `assist` -> "Assist", `wicket.fielder` ->
  // "Wicket fielder"), and view-model.ts's own header explains why it is
  // deliberately never routed through msg(): a path is an engine-internal
  // identifier, not authored copy, and there is no English sentence in it for
  // a translator to translate.
  //
  // SIDE items keep the kind label: their path is usually `by`, and
  // "Goal — By" is worse than "Goal — Side". Only person paths carry a name
  // worth showing.
  if (item.kind === "person" && item.path) {
    const derived = deriveFieldPathLabel(item.path);
    return actionLabel ? `${actionLabel} — ${derived}` : derived;
  }

  const kindLabel = msg(item.kind === "side" ? "scorepad.attribution.side" : "scorepad.attribution.person");
  const base = `${kindLabel} #${index + 1}`;
  return actionLabel ? `${actionLabel} — ${base}` : base;
}

function chipClass(pressed: boolean): string {
  return `inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-medium transition ${
    pressed ? "border-accent-line bg-accent-line/10 text-slate-900" : "border-slate-200 text-slate-600"
  }`;
}

/**
 * A plain function, deliberately NOT a JSX-invoked component — same reason
 * as action-form.tsx's `renderField`: this repo's node-only `_hook-harness`
 * walks a rendered tree by descending into `.props.children` only, never
 * invoking a nested custom component function, so a genuinely separate
 * `<AttributionItem/>` component would make every chip inside it invisible
 * to `walk()`/`textOf()`.
 */
function renderAttributionItem(
  item: PadAttributionItem,
  index: number,
  actionLabel: string,
  value: PadFieldValue | undefined,
  onSelect: (v: PadFieldValue | undefined) => void,
  squads: SquadState,
  lineups: LineupPair,
  personNames: Readonly<Record<string, string>>,
  msg: MsgFn,
): ReactNode {
  const caption = attributionItemCaption(item, index, msg, actionLabel);

  const options: { value: string; label: string }[] =
    item.kind === "side"
      ? [
          { value: lineups.home.entrantId, label: msg("scorepad.attribution.home") },
          { value: lineups.away.entrantId, label: msg("scorepad.attribution.away") },
        ]
      : candidatesForPerson(item, squads).map((c) => ({
          value: c.personId,
          label: personNames[c.personId] ?? msg("eventCopy.unknownPerson"),
        }));

  return (
    <div key={item.path} data-attribution-path={item.path} role="group" aria-label={caption} className="space-y-1">
      <span className="label !mb-0">{caption}</span>
      {options.length === 0 ? (
        // S13/#422 W11 cutover — text-slate-400 on this white .card measures
        // ~2.63:1, below AA's 4.5:1 floor; text-slate-600 clears it at
        // 7.56:1 — the exact fix period-skin.tsx's own noRoster hint already
        // got (dac2b6bb), reused here since it is the same pair.
        <p className="text-xs text-slate-600">{msg("scorepad.attribution.noRoster")}</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {options.map((opt) => {
            const pressed = value === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                data-value={opt.value}
                aria-pressed={pressed}
                onClick={() => onSelect(pressed ? undefined : opt.value)}
                className={chipClass(pressed)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface AttributionPickerProps {
  action: Pick<PadActionView, "attribution" | "labelKey">;
  values: ActionValues;
  setValue: (path: string, value: PadFieldValue | undefined) => void;
  /** The module's own folded state (whatever `usePadPipeline`/`foldClient`
   *  produced) — read only for an adopted `SquadState` at `.squads`; see
   *  the module header for why this is verified structurally rather than
   *  trusted by field name alone. Absent is the normal state for a fixture
   *  that has not folded any `core.lineup.*` event. */
  state?: unknown;
  /** Kickoff team sheet — the degrade target whenever `state` carries no
   *  live squads. */
  lineups: LineupPair;
  /** personId -> display name. Falls back to a generic "unknown player"
   *  label when absent — a picker must never block on a missing name. */
  personNames?: Readonly<Record<string, string>>;
}

const EMPTY_NAMES = {};

export function AttributionPicker(props: AttributionPickerProps): ReactNode {
  const msg = useMsg();
  const { action, values, setValue, lineups } = props;
  if (action.attribution.length === 0) return null;

  const squads = resolveSquads(props.state, lineups);
  const actionLabel = padLabel(action.labelKey.key, msg, action.labelKey.label);
  const personNames = props.personNames ?? EMPTY_NAMES;

  return (
    <div className="space-y-3" data-role="attribution-picker">
      {action.attribution.map((item, index) =>
        renderAttributionItem(
          item,
          index,
          actionLabel,
          values[item.path],
          (v) => setValue(item.path, v),
          squads,
          lineups,
          personNames,
          msg,
        ),
      )}
    </div>
  );
}
