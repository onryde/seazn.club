// hockey (builder default fih-outdoor: 4 × 15, no OT, no shootout). The pad is
// period.ts's shape; Step 0 (2026-09-30, 320) saw goal-home hold (chips kind:pc,
// kind:stroke, ownGoal, emptyNet) and write `hockey.goal {by}` at ~2755 ms, and
// four advance taps write `{to, at}` for Q2, Q3, Q4 and FT, which decided.
// W2d T18 (HK-TB-2): the goal tile now opens the goal-type CHOICE (kind:fg,
// kind:pc, kind:stroke, ownGoal) and the row is `hockey.goal {by, kind}` — see
// period.ts's header.
import { makePeriodPad } from "./period.ts";

export const hockeyPad = makePeriodPad("hockey");
