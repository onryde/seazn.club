// sport → pad adapter. It grows T7→T11 in SPORT_KEYS order (the registry's wave
// order; AGENTS class 18). lib/pad-sports.ts's PAD_SPORTS is this table's key
// list, restated as a leaf for the modules that may not load the browser layer.
// pad-adapters.test.ts pins the two equal. Every adapter enters through
// registerPads, which refuses a fallback that is not judged (fix round 1, I-1).
import { badmintonPad } from "./badminton.ts";
import { boardgamePad } from "./boardgame.ts";
import { carromPad } from "./carrom.ts";
import { cricketPad } from "./cricket.ts";
import { footballPad } from "./football.ts";
import { genericPad } from "./generic.ts";
import { hockeyPad } from "./hockey.ts";
import { icehockeyPad } from "./icehockey.ts";
import { tabletennisPad } from "./tabletennis.ts";
import { tennisPad } from "./tennis.ts";
import type { MatrixPadAdapter } from "./types.ts";
import { volleyballPad } from "./volleyball.ts";

/** The registry's door: every fallback declares the row types its taps write
 *  and a judge that compares them with the event, or the table is refused by
 *  name at load. A fallback is judged, never waved through. */
export function registerPads(table: Record<string, MatrixPadAdapter>): Readonly<Partial<Record<string, MatrixPadAdapter>>> {
  for (const [sport, a] of Object.entries(table)) {
    for (const f of a.fallbacks) {
      if (typeof f.judge !== "function") throw new Error(`FallbackUnjudged: ${sport}'s ${f.eventType} fallback declares no judge — a fallback is judged, never waved through`);
      if (f.writes.length === 0) throw new Error(`FallbackWritesNothing: ${sport}'s ${f.eventType} fallback declares no row type it writes`);
    }
  }
  return Object.freeze({ ...table });
}

export const PAD_ADAPTERS: Readonly<Partial<Record<string, MatrixPadAdapter>>> = registerPads({
  football: footballPad,
  cricket: cricketPad,
  boardgame: boardgamePad,
  carrom: carromPad,
  generic: genericPad,
  volleyball: volleyballPad,
  badminton: badmintonPad,
  tabletennis: tabletennisPad,
  tennis: tennisPad,
  icehockey: icehockeyPad,
  hockey: hockeyPad,
});
