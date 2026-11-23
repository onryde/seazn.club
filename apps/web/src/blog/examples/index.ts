// The registry: every example a post can place. The goldens (__golden__/<id>.json) are what a page reads; this
// file is what the regenerate and claims tests walk, and is never imported by a page (it pulls in the engine).
import { standingsPoints } from "./standings-points";
// ---- batch 5 (Task 11) ----
import { ladderChallenge } from "./ladder-challenge";
import { knockoutWithdrawal } from "./knockout-withdrawal";
import { forfeitScores } from "./forfeit-scores";
import { doubleWalkover } from "./double-walkover";
// ---- end batch 5 ----
import type { BlogExample } from "./types";

export const BLOG_EXAMPLES: readonly BlogExample[] = [
  standingsPoints,
  // ---- batch 5 (Task 11) ----
  ladderChallenge,
  knockoutWithdrawal,
  forfeitScores,
  doubleWalkover,
  // ---- end batch 5 ----
];

export function blogExample(id: string): BlogExample | null {
  return BLOG_EXAMPLES.find((e) => e.id === id) ?? null;
}
