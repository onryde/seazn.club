// The registry: every example a post can place. The goldens (__golden__/<id>.json) are what a page reads; this
// file is what the regenerate and claims tests walk, and is never imported by a page (it pulls in the engine).
import { standingsPoints } from "./standings-points";
import type { BlogExample } from "./types";
// --- blog batch 4 (knockouts) ---
import { thirdPlaceMatch } from "./third-place-match";
import { knockoutMatchEndsLevel } from "./knockout-match-ends-level";
import { pagePlayoffAndStepladder } from "./page-playoff-and-stepladder";
import { doubleEliminationExplained } from "./double-elimination-explained";
import { whatIsAPlate } from "./what-is-a-plate";
const BATCH_4: readonly BlogExample[] = [thirdPlaceMatch, knockoutMatchEndsLevel, pagePlayoffAndStepladder, doubleEliminationExplained, whatIsAPlate];
// --- end blog batch 4 ---

export const BLOG_EXAMPLES: readonly BlogExample[] = [standingsPoints, ...BATCH_4];

export function blogExample(id: string): BlogExample | null {
  return BLOG_EXAMPLES.find((e) => e.id === id) ?? null;
}
