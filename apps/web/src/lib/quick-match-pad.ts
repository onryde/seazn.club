// Quick match: how much of a sport's detail a guest's pad may record (owner 2026-11-13 "yes" to quick match cricket,
// 2026-11-14 "why still not cricket in the quick match?"; decision log 2026-11-13: QM cricket = fidelity bands 0–1 only).
//
// A quick match's sides are names with nobody in them, so a detail band whose actions cannot be recorded without a named
// player is a band the guest can never use. For cricket that is band 2 (the player line) and band 3 (every ball names a
// striker and a bowler): the pad would show ball tiles that wait for a bowler nobody can pick ("No bowler is eligible").
// A capped sport is scored up to its CEILING, the band below the first band holding such an action, read off the
// engine's own `padSpec(cfg)`: each event's band (`fidelity`) and each attribution's `required` flag, which the engine
// stamps from the event's own payload schema. Nothing here types a band.
//
// Which sports are capped is the product's decision, not the engine's: a sport's top band naming players is a choice to
// record more, not a refusal to record less, and only cricket's everyday scoring (the ball) is one. Every other sport's
// quick match pad is unchanged.
//
// Pure and import-light (types only): the guest's pad (a client component), the offer (server) and the probe that proves
// the offer all read it, so the band a guest scores at and the band the offer was proven at are one rule.
import type { FidelityBand, PadSpec } from "@seazn/engine/sport";

/** The sports a quick match scores below their full detail (decision log 2026-11-13: cricket, bands 0–1). */
export const QUICK_MATCH_BAND_CAPPED_SPORTS: ReadonlySet<string> = new Set(["cricket"]);

/** The lowest band holding an action that needs a named person (an attribution its schema requires), or null when no
 *  action needs one. An action with no declared band is never filtered by the pad, so it is never counted here. */
export function firstNamedPersonBand(spec: PadSpec): FidelityBand | null {
  let lowest: FidelityBand | null = null;
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      const band = spec.fidelity[action.type];
      if (band === undefined) continue;
      const named = (action.attribution ?? []).some((a) => a.kind === "person" && a.required !== false && a.optional !== true);
      if (named && (lowest === null || band < lowest)) lowest = band;
    }
  }
  return lowest;
}

/**
 * The highest band a quick match pad records for `sportKey` under `spec`, or null for no ceiling: a sport that is not
 * capped, or a capped one whose pad names nobody. Throws when a capped sport's band 0 already needs a named person: a
 * guest could not record even a result, and an offer built on it would be a pad with nothing to press.
 */
export function quickMatchBandCeiling(sportKey: string, spec: PadSpec): FidelityBand | null {
  if (!QUICK_MATCH_BAND_CAPPED_SPORTS.has(sportKey)) return null;
  const named = firstNamedPersonBand(spec);
  if (named === null) return null;
  if (named === 0) throw new Error(`quick match: ${sportKey} needs a named player at band 0, so a guest cannot score it`);
  return (named - 1) as FidelityBand;
}

/**
 * The actions about a player: any `person` attribution, required or optional. A quick match pad leaves them all out
 * (sign-off 2026-11-14, controller PO rec): the ones that need a name already sit above the ceiling, and the ones that
 * only ask for one (cricket's review: which batter, which bowler) would be recorded with that half blank, about sides
 * that have nobody in them. Read off the engine's own attributions, like the ceiling; nothing here names an event.
 */
export function personAttributedEvents(spec: PadSpec): ReadonlySet<string> {
  const out = new Set<string>();
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      if ((action.attribution ?? []).some((a) => a.kind === "person")) out.add(action.type);
    }
  }
  return out;
}
