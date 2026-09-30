// sport → pad adapter. It grows T7→T11 in SPORT_KEYS order (the registry's wave
// order; AGENTS class 18). lib/pad-sports.ts's PAD_SPORTS is this table's key
// list, restated as a leaf for the modules that may not load the browser layer.
// pad-adapters.test.ts pins the two equal.
import { badmintonPad } from "./badminton.ts";
import { footballPad } from "./football.ts";
import { genericPad } from "./generic.ts";
import { hockeyPad } from "./hockey.ts";
import { icehockeyPad } from "./icehockey.ts";
import { tabletennisPad } from "./tabletennis.ts";
import { tennisPad } from "./tennis.ts";
import type { MatrixPadAdapter } from "./types.ts";
import { volleyballPad } from "./volleyball.ts";

export const PAD_ADAPTERS: Readonly<Partial<Record<string, MatrixPadAdapter>>> = Object.freeze({
  football: footballPad,
  generic: genericPad,
  volleyball: volleyballPad,
  badminton: badmintonPad,
  tabletennis: tabletennisPad,
  tennis: tennisPad,
  icehockey: icehockeyPad,
  hockey: hockeyPad,
});
