// v3/skins/hockey.tsx — FIELD HOCKEY (FIH), ScoringPad v3 wave R6.
//
// The pad's whole shape lives in `./period-shared.ts`, which hockey and ice
// hockey genuinely share: one engine kernel (`sports/period/kernel.ts`) under
// two presets, one identical event union. What is hockey's alone is here, and
// it is small on purpose — everything that could be read off `cfg` or the
// module's own `summary()` is read rather than declared, so a division running
// the `youth` variant (four ten-minute quarters, a seven-a-side strength floor,
// one/three-minute cards) gets a correct pad with no code in this file knowing
// that variant exists.
//
// TWO THINGS ARE HOCKEY'S OWN.
//
// 1. THE CARD LADDER IS THREE PHYSICAL SWATCHES. `HOCKEY_SUSPENSIONS`
//    (`period/suspensions.ts:73-77`) is green/yellow/red, and the preset names
//    them as colours in `disciplineColors` (`hockey.ts:219-223`) — these are
//    cards an umpire holds up, not words on a sheet. Two tones could not carry
//    three strengths, which is why R6 added `advisory` as the seventh sport
//    token and why the mapping below is total: green -> `advisory`,
//    yellow -> `caution`, red -> `dismissal`.
//
//    EVERY class sets `teamShort: true`. A card in this sport always REDUCES
//    the offender and nobody ever gains, so the strength chip on the scorebug
//    strip only ever reads short — the exact opposite of ice hockey in
//    overtime, and the reason neither skin computes that chip itself.
//
// 2. THE GREEN-CARD ESCALATION HINT IS HOCKEY'S ALONE. `escalationHints`
//    (`suspensions.ts:275-281`) lists players already carrying a green, and the
//    kernel publishes it on `summary.detail.escalate` for `preset.key ===
//    "hockey"` and nothing else (kernel.ts:2573). `period-shared.ts` therefore
//    needs no sport check: it reads the field, and ice hockey's summary simply
//    never has one. The sentence it shows — "This player already has a green
//    card…" — is `pad.pp.escalation`, shipped in four locales by S13 and
//    REUSED here rather than reminted.
//
// Assists are OFF (`hockey.ts:133`, `assists: false`) and `applyGoal` refuses a
// non-empty `assists` array outright when they are, so the goal dock offers
// scorer chips and no assist chips at all. That branch is `cfg.assists`-driven
// in the shared builder, not hard-coded here.

import { hockeyPadRules } from "@seazn/engine/pad";
import type { SportTone } from "../sport-theme";
import { makePeriodSkin, type PeriodSkinSpec, type TFn } from "./period-shared";
import type { PadHostView, SkinDefV3 } from "../types";

/** Three cards, three swatches — see this file's header for why all three are
 *  coloured where ice hockey's seven are not. A tone map keyed by the engine's
 *  class catalogue (`hockeyPadRules.suspensionClassKeys`), which
 *  `skins/__tests__/pad-rules-period.test.ts` pins key for key. */
export const HOCKEY_CLASSES: Readonly<Record<string, readonly SportTone[]>> = {
  green: ["advisory"],
  yellow: ["caution"],
  red: ["dismissal"],
};

export const hockeySpec: PeriodSkinSpec = {
  key: "hockey",
  classes: HOCKEY_CLASSES,
  // The offence list, the goal-type flag (W2d T18, HK-TB-2: FIH ranks on field goals, so the goal tap asks Field goal /
  // Penalty corner / Penalty stroke, or Own goal, before anything is queued), the bands and the phase table: the engine's.
  rules: hockeyPadRules,
};

export const hockeySkinV3: (t: TFn) => SkinDefV3<PadHostView> = makePeriodSkin(hockeySpec);
