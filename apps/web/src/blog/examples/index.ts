// The registry: every example a post can place. The goldens (__golden__/<id>.json) are what a page reads; this
// file is what the regenerate and claims tests walk, and is never imported by a page (it pulls in the engine).
import { chessPoints } from "./chess-points";
import { cricketPoints } from "./cricket-points";
import { shootoutPoints } from "./shootout-points";
import { standingsPoints } from "./standings-points";
import { tableTennisLoss } from "./table-tennis-loss";
import type { BlogExample } from "./types";

export const BLOG_EXAMPLES: readonly BlogExample[] = [standingsPoints, shootoutPoints, cricketPoints, chessPoints, tableTennisLoss];

export function blogExample(id: string): BlogExample | null {
  return BLOG_EXAMPLES.find((e) => e.id === id) ?? null;
}
