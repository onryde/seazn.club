// v3/skins/icehockey.tsx — ICE HOCKEY (IIHF), ScoringPad v3 wave R6.
//
// Shares its whole shape with `./period-shared.ts` and with `./hockey.tsx`: one
// engine kernel, one event union, two presets. What is ice hockey's alone is
// here.
//
// 1. SEVEN PENALTY CLASSES, TWO TONES. `ICEHOCKEY_SUSPENSIONS`
//    (`period/suspensions.ts:56-69`) runs minor / bench minor / double minor /
//    major / misconduct / game misconduct / match, and `disciplineColors`
//    (`icehockey.ts:257-265`) names them exactly that way — WORDS on a
//    scoresheet, not cards an official holds up. There is no third card grade
//    to colour, which is why this sport's palette declares no `advisory` at
//    all (`sport-theme.ts:238-244`) and why using one here would invent a card
//    the IIHF does not have.
//
//    So the ladder takes R4-4's precedent, recorded when tennis's four-step
//    code-violation ladder met the same two tokens: THE ENDS TAKE A TONE AND
//    THE MIDDLE READS AS WORDS. The ends are the two-minute `minor` (`caution`)
//    and the 25-PIM `match` (`dismissal`); the five between them are declared
//    with an empty tone array — worded, uncoloured, and deliberately so.
//
// 2. OVERTIME INVERTS THE STRENGTH MODEL. `overtimeSkaterAdvantage`
//    (`icehockey.ts:246-252`) turns `strengthOf` into `overtimeStrengthOf` for
//    sudden death: instead of the offending side losing a skater from five, the
//    NON-offending side gains one from three. The pad never computes this —
//    `summary.detail.strength` is the kernel's own chip and already carries the
//    inversion (`strengthChipOf`, kernel.ts:2297-2309), which is precisely why
//    `period-shared.ts` reads that field rather than counting suspensions.
//
// 3. ASSISTS ARE ON. `assists: true` (`icehockey.ts:174`), capped at two by
//    `PeriodGoal.assists` (`z.array(PersonId).max(2)`). The shared goal dock
//    offers the second and third chips off `cfg.assists`, so hockey — which
//    sets it false, and whose fold refuses a non-empty array — gets scorer
//    chips only, from the same code.
//
// The shoot-out is a GWS (`shootoutLabel: "GWS"`, and `shootoutWinnerGoal`
// adds the decider to the official score), which reaches the pad as copy on
// `pad.icehockey.strip.shootout` rather than as a code branch.

import type { SportTone } from "../sport-theme";
import { makePeriodSkin, type PeriodSkinSpec, type TFn } from "./period-shared";
import type { PadHostView, SkinDefV3 } from "../types";

/**
 * IIHF's own offence list, in `padSpec` order (`ICEHOCKEY_SUSPENSION_REASONS`,
 * `sports/icehockey/icehockey.ts:17-37`). Restated for the same reason
 * hockey's is, and pinned to the real module by
 * `v3/__tests__/period-pair.test.ts`. Copy for all nineteen already ships via
 * `ENUM_VOCAB.reason`.
 */
export const ICEHOCKEY_REASONS: readonly string[] = [
  "tripping",
  "hooking",
  "holding",
  "holding_the_stick",
  "slashing",
  "high_sticking",
  "cross_checking",
  "roughing",
  "elbowing",
  "charging",
  "boarding",
  "checking_from_behind",
  "interference",
  "delay_of_game",
  "too_many_men",
  "unsportsmanlike_conduct",
  "fighting",
  "illegal_equipment",
  "other",
];

/** Seven classes, two tones — the ends only. An empty array is DECLARED AND
 *  UNCOLOURED, not "unknown": all seven have their own copy. */
export const ICEHOCKEY_CLASSES: Readonly<Record<string, readonly SportTone[]>> = {
  minor: ["caution"],
  bench_minor: [],
  double_minor: [],
  major: [],
  misconduct: [],
  game_misconduct: [],
  match: ["dismissal"],
};

export const icehockeySpec: PeriodSkinSpec = {
  key: "icehockey",
  classes: ICEHOCKEY_CLASSES,
  reasons: ICEHOCKEY_REASONS,
};

export const icehockeySkinV3: (t: TFn) => SkinDefV3<PadHostView> = makePeriodSkin(icehockeySpec);
