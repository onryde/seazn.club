// W2d Task 10 fix round 1, I2 (owner decision 2026-10-26) — the divisions whose OWN points a flat stage rule (the stage
// points editor's three boxes: one amount per win, per loss, per draw, tie and no result) cannot say, each with what it
// pays apart. From the rulebooks, never from the predicate under test (`draftRefusal`, `sportPointsSplits`):
//   - IIHF (icehockey/iihf): a win in overtime or a shoot-out pays 2 and its loss 1, against regulation's 3/0 (3-2-1-0);
//   - FIVB (volleyball/indoor): a 3-2 result pays the winner 2 and the loser 1, against a 3-0 or 3-1's 3/0;
//   - ICC (cricket, every format): a tie and a no result pay each side 1, which the editor's tie and no result (0) cannot;
//   - ITTF team leagues (tabletennis, every format): a played loss pays 1 and a loss not played (a walkover) 0;
//   - FIH's shoot-out format (hockey/fih-shootout): a drawn match goes to a shoot-out booked as a draw plus a bonus point.
// Every other division the registry ships pays one amount per win and per loss on every outcome its stages reach
// (football and hockey's other formats reach no shoot-out on a table; volleyball's beach and badminton pay 2-0 on every
// set score; board games keep half-points as a display unit only), so the editor says its points whole.
import { DRAW_KINDS } from "@seazn/engine/core";
import type { SplitReason } from "@/lib/rule-errors";

export const RULEBOOK_SPLITS: Readonly<Record<string, readonly SplitReason[]>> = {
  "icehockey/iihf": ["otWin", "otLoss"],
  "volleyball/indoor": ["pointsMap"],
  "cricket/t20": ["tie", "noResult"],
  "cricket/odi": ["tie", "noResult"],
  "cricket/hundred": ["tie", "noResult"],
  "cricket/test": ["tie", "noResult"],
  "tabletennis/bo5": ["unplayed"],
  "tabletennis/bo7": ["unplayed"],
  "tabletennis/hardbat-21": ["unplayed"],
  "hockey/fih-shootout": ["soBonus"],
};

/** The table stage kinds a points rule ranks (the engine's own set; the section is mounted on these only). */
export const TABLE_KINDS: readonly string[] = [...DRAW_KINDS];
