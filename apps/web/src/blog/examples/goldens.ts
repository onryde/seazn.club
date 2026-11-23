// What a post renders from: each example's committed golden, imported statically so the build needs no engine run
// and no file read at request time (the standalone build ships no src/). A new example adds its line here;
// blog-examples.test.ts fails on a golden file with no line, and on a line with no registered example.
import chessPoints from "./__golden__/chess-points.json";
import cricketPoints from "./__golden__/cricket-points.json";
import shootoutPoints from "./__golden__/shootout-points.json";
import standingsPoints from "./__golden__/standings-points.json";
import type { ExampleResult } from "./types";

export const BLOG_GOLDENS: Record<string, ExampleResult> = {
  "chess-points": chessPoints as ExampleResult,
  "cricket-points": cricketPoints as ExampleResult,
  "shootout-points": shootoutPoints as ExampleResult,
  "standings-points": standingsPoints as ExampleResult,
};
