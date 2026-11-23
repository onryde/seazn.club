// The registry: every example a post can place. The goldens (__golden__/<id>.json) are what a page reads; this
// file is what the regenerate and claims tests walk, and is never imported by a page (it pulls in the engine).
import { standingsPoints } from "./standings-points";
// ---- blog batch 2 (tie-breaks, posts #7 to #12) ----
import { levelOnPoints } from "./level-on-points";
import { threeWayTie } from "./three-way-tie";
import { netRunRate } from "./net-run-rate";
import { setRatioOrDifference } from "./set-ratio-or-difference";
import { buchholzSonnebornBerger } from "./buchholz-sonneborn-berger";
import { drawingLots } from "./drawing-lots";
// ---- end blog batch 2 ----
import type { BlogExample } from "./types";

/** Blog batch 2's examples (tie-breaks), in post order. */
const BATCH_2: readonly BlogExample[] = [levelOnPoints, threeWayTie, netRunRate, setRatioOrDifference, buchholzSonnebornBerger, drawingLots];

export const BLOG_EXAMPLES: readonly BlogExample[] = [standingsPoints, ...BATCH_2];

export function blogExample(id: string): BlogExample | null {
  return BLOG_EXAMPLES.find((e) => e.id === id) ?? null;
}
