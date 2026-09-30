// icehockey (builder default iihf: 3 × 20, OT 5′, shootout 5). The pad is
// period.ts's shape; Step 0 (2026-09-30, 320) saw goal-home hold (chips kind:pp,
// kind:sh, kind:ps, ownGoal, emptyNet) and write `icehockey.goal {by}` at
// ~2735 ms, and three advance taps write `{to, at}` for P2, P3 and FT. A 1-0 at
// P3's end decided at FT, with no OT — which the generated stream relies on.
import { makePeriodPad } from "./period.ts";

export const icehockeyPad = makePeriodPad("icehockey");
