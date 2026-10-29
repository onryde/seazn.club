// W2e Task 30 (D3, D13) — the closing step of a sanction sheet whose level ENDS the match.
//
// Badminton's `disqualification` (the black card) and tennis's `default` end the match. A tap on one of them used to record a
// sanction and nothing else; the match then sat undecided behind a refusal (X-SE-1). The sheet now ends on a read-back — "This
// ends the match: <side> loses" — and one Confirm, so the scorer reads the consequence BEFORE the write. The host
// (`pad-host.tsx`'s `endingPlanOf` / `runEnding`) then sends the sanction and its ending as one bound pair.
//
// Which levels end a match is the ENGINE's declaration (`module.sanctionEnding.endLevels`), read here, never restated: a level
// added to the declaration later asks the same question with no change to a skin.
import type { SanctionEndingDecl } from "@seazn/engine/core";
import type { MessageKey } from "@/lib/messages";
import type { PadHostView, SheetConfirmStep } from "../types";

type Side = "home" | "away";
type TFn = (key: string, vars?: Record<string, string | number>) => string;

const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/** The id of the sanction sheet's level step, in both skins that use this. The confirm step is gated on its answer. */
export const SANCTION_LEVEL_STEP_ID = "level";

/** What the screen calls a side: the name the console heading shows (`view.entrantNames`), else the Home/Away word. */
export function sideNameOf(entrantNames: PadHostView["entrantNames"], side: Side, t: TFn): string {
  const name = entrantNames[side];
  return name !== undefined && name.length > 0 ? name : t(SIDE_LABEL[side]);
}

/**
 * The read-back that closes a sanction sheet, shown only when the level just picked is one the module's declaration says ends
 * the match. The SANCTIONED side is the side whose tile opened the sheet, so it needs no question of its own.
 */
export function endsMatchStep(decl: SanctionEndingDecl, side: Side, entrantNames: PadHostView["entrantNames"], t: TFn): SheetConfirmStep {
  return {
    id: "endsMatch",
    kind: "confirm",
    title: "pad.sanction.confirm.title",
    when: (answers) => {
      const level = answers[SANCTION_LEVEL_STEP_ID];
      return level !== undefined && decl.endLevels.includes(level);
    },
    summary: () => t("pad.sanction.endsMatch", { side: sideNameOf(entrantNames, side, t) }),
  };
}
