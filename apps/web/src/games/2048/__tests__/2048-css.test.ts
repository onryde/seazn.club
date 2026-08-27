// 2048.css -- structural board/tile sizing plus the spawn/merge-pop
// animations. Mirrors chess-quest-css.test.ts's approach: grep the
// stylesheet source directly (no build step) so a regression is caught
// here instead of only showing up in a screenshot diff. The one load-
// bearing rule (W1's pattern, restated for this game): the spawn/merge
// keyframes only ever apply inside `@media (prefers-reduced-motion:
// no-preference)`, so a `reduce` user gets an instant, un-animated state
// change instead.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.resolve(__dirname, "../2048.css"), "utf8");

describe("2048.css", () => {
  it("sizes the board to 4x4 tracks of 64px tiles (320px acceptance: 288px board)", () => {
    expect(css).toMatch(/\.board-2048\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*64px\)/);
    expect(css).toMatch(/\.tile-2048\s*{[^}]*width:\s*64px/);
    expect(css).toMatch(/\.tile-2048\s*{[^}]*height:\s*64px/);
  });

  it("guards the spawn and merge-pop keyframes behind prefers-reduced-motion: no-preference", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:\s*no-preference\)\s*{[^]*tile-2048-spawn[^]*tile-2048-merge/,
    );
  });

  it("defines both keyframes referenced by the guarded rules", () => {
    expect(css).toMatch(/@keyframes tile-2048-spawn/);
    expect(css).toMatch(/@keyframes tile-2048-merge/);
  });

  it("does not apply the animations outside the guard", () => {
    const guardStart = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(guardStart).toBeGreaterThan(-1);
    const beforeGuard = css.slice(0, guardStart);
    expect(beforeGuard).not.toMatch(/animation:\s*tile-2048-spawn/);
    expect(beforeGuard).not.toMatch(/animation:\s*tile-2048-merge/);
  });
});
