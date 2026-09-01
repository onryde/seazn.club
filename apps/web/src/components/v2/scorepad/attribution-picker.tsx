"use client";
// Attribution SELECTORS (S10/#419 W8, chassis item 3) — the pure, sport-
// agnostic half of the attribution picker. `v3/action-form.tsx` and
// `timeline.tsx` are the live callers.
//
// R7/G (2026-09-01) reduced this file to those selectors. It used to also
// export an `AttributionPicker` COMPONENT, whose only production wire was
// `pad-renderer.tsx`'s `renderAttribution` typed seam — and R7/G deleted
// `pad-renderer.tsx` along with the rest of the v2 pad lane, leaving the
// component reachable from nothing but its own unit tests. The v3 lane
// renders these items itself, from `v3/action-form.tsx`, so the component,
// its props interface and its private row renderer went with the seam they
// served. It also used to export `resolveSquads`, which was byte-for-byte
// what `v3/pad-host.tsx`'s `squadStateOf` does; one copy of that rule is
// now the only copy.
//
// What remains is stateless and owns no `useState` — it never did.
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
// `isSquadState` below verifies the shape structurally (`.home.members` is
// an array) before anything trusts it. The DEGRADE that check feeds — fall
// back to `initSquads(lineups)`, the same kernel function run fresh off the
// kickoff team sheet — now lives in its one caller, `v3/pad-host.tsx`'s
// `squadStateOf`, which is where it belongs: this file exports the predicate,
// the pad host decides what to do when it says no. That covers three tiers
// through one call — no live squads at all, a private non-adopting shape like
// football's, and no roster at all (an empty LineupPair still folds to a
// valid, empty SquadState).
//
// personsAtPosition/playingSquad (core/lineup.ts) already filter to
// `role === "player"` — a coach or staff member is therefore structurally
// never offered here, without this file re-checking role itself.
import { padLabel } from "@/lib/scoring-vocab";
import type { MsgFn } from "@/lib/scoring-vocab";
import type { SideSquad, SquadState } from "@seazn/engine/core";
import { personsAtPosition, playingSquad } from "@seazn/engine/core";
import type { PadAttributionItem } from "@seazn/engine/sport";
import { deriveFieldPathLabel } from "./view-model";

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
