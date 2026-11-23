// The registry: every example a post can place. The goldens (__golden__/<id>.json) are what a page reads; this
// file is what the regenerate and claims tests walk, and is never imported by a page (it pulls in the engine).
import { standingsPoints } from "./standings-points";
// ---- batch 3 (Swiss and seeding) ----
import { knockoutSeeds } from "./knockout-seeds";
import { swissBye, swissByeRounds } from "./swiss-bye";
import { swissLateAndWithdraw } from "./swiss-late-and-withdraw";
import { swissPairing } from "./swiss-pairing";
// ---- end batch 3 ----
import type { BlogExample } from "./types";

export const BLOG_EXAMPLES: readonly BlogExample[] = [
  standingsPoints,
  // ---- batch 3 (Swiss and seeding) ----
  swissPairing,
  swissBye,
  swissByeRounds,
  swissLateAndWithdraw,
  knockoutSeeds,
  // ---- end batch 3 ----
];

export function blogExample(id: string): BlogExample | null {
  return BLOG_EXAMPLES.find((e) => e.id === id) ?? null;
}
