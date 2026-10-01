// Which sports the pad path covers, and the route to the wave that owes each of
// the others (W1c Task 7). This is a leaf, importing only the routing leaf: run.ts plans `--set pad-proof` and
// the PADPROOF scenario defers an uncovered sport from it, and neither of them
// may reach lib/pads, which is the browser layer (boundary.test.ts). The adapters
// themselves live in lib/pads/index.ts. pad-adapters.test.ts pins
// PAD_SPORTS === Object.keys(PAD_ADAPTERS), so a sport registered in one place
// and not the other reds there.

import { routeTo, type Route } from "./routing.ts";

/** The sports with a pad adapter, in SPORT_KEYS order (the registry's wave
 *  order, never re-sorted; AGENTS class 18). Grows T7→T11 alongside PAD_ADAPTERS. */
export const PAD_SPORTS: readonly string[] = Object.freeze(["football", "cricket", "boardgame", "carrom", "generic", "volleyball", "badminton", "tabletennis", "tennis", "icehockey", "hockey"]);

/** Every other sport → the route to the wave that owes its adapter. A sport
 *  moves from here to PAD_SPORTS when its adapter lands. Empty since W1c Task
 *  11: every catalogue sport has one (pad-adapters.test.ts, carry f). A sport
 *  the catalogue gains later names its owning wave here, through routeTo, so
 *  the Q-A guard reads it. */
export const PAD_OWNER: Readonly<Record<string, Route>> = Object.freeze({});
/** A sport with no adapter and no PAD_OWNER entry. W1c (whose tasks built the
 *  adapters) is closed, so the route goes to an open wave: design §8 sends a
 *  gap no wave lists to the wave owning its sport, and the sport-family wave
 *  owns every sport's scoring input (T1-R2). */
export const PAD_UNOWNED = routeTo("W2", "no task owns it: design §8 gives an unlisted sport gap to the sport-family wave");

/** Why `sport` has no pad route yet. An uncovered sport that is also missing
 *  from PAD_OWNER still names an open wave (PAD_UNOWNED), so the pad-route
 *  abstain and NoPadAdapter both read an owner. */
export function noPadReason(sport: string): string {
  const owner = Object.hasOwn(PAD_OWNER, sport) ? PAD_OWNER[sport] : PAD_UNOWNED;
  return `no pad adapter for ${sport} yet → ${owner.wave} (${owner.why})`;
}
