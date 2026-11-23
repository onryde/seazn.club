// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import standingsPoints from "./__golden__/standings-points.json";
// ---- blog batch 2 (tie-breaks, posts #7 to #12) ----
import levelOnPoints from "./__golden__/level-on-points.json";
import threeWayTie from "./__golden__/three-way-tie.json";
import netRunRate from "./__golden__/net-run-rate.json";
import setRatioOrDifference from "./__golden__/set-ratio-or-difference.json";
// ---- end blog batch 2 ----
import type { ExampleResult } from "./types";

export const BLOG_GOLDENS: Record<string, ExampleResult> = {
  "standings-points": standingsPoints as ExampleResult,
  // ---- blog batch 2 ----
  "level-on-points": levelOnPoints as ExampleResult,
  "three-way-tie": threeWayTie as ExampleResult,
  "net-run-rate": netRunRate as ExampleResult,
  "set-ratio-or-difference": setRatioOrDifference as ExampleResult,
  // ---- end blog batch 2 ----
};
