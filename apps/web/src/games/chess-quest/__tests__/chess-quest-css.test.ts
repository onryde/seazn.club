// W1 acceptance criterion, verbatim: "`.cq-board` reads every colour from
// custom properties; `data-theme` selects a set. Nothing else in the CSS
// names a colour." This greps the compiled-away stylesheet source directly
// (no build step involved) so a regression that reintroduces a hardcoded
// board colour fails here instead of only showing up in a screenshot diff.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(
  path.resolve(__dirname, "../chess-quest.css"),
  "utf8",
);
const PRINT_MARKER = "/* ---------- printable certificate ---------- */";
const printAt = css.indexOf(PRINT_MARKER);
const boardCss = css.slice(0, printAt);
const printCss = css.slice(printAt);

describe("chess-quest.css — board colours come from custom properties (W1)", () => {
  it("finds the print-certificate marker (sanity check for the slice above)", () => {
    expect(printAt).toBeGreaterThan(0);
  });

  it("defines all nine theme tokens on .cq-board, plus brown and purple overrides", () => {
    for (const token of [
      "--cq-light",
      "--cq-dark",
      "--cq-sel",
      "--cq-last",
      "--cq-move",
      "--cq-check",
      "--cq-hint",
      "--cq-coord-on-light",
      "--cq-coord-on-dark",
    ]) {
      expect(boardCss).toContain(`${token}:`);
    }
    expect(boardCss).toContain('.cq-board[data-theme="brown"]');
    expect(boardCss).toContain('.cq-board[data-theme="purple"]');
  });

  it("square colours reference the theme tokens, not a literal colour", () => {
    expect(boardCss).toMatch(/\.cq-light\s*{\s*background:\s*var\(--cq-light\)\s*;?\s*}/);
    expect(boardCss).toMatch(/\.cq-dark\s*{\s*background:\s*var\(--cq-dark\)\s*;?\s*}/);
  });

  it("highlight overlays reference their tokens, not a literal colour", () => {
    expect(boardCss).toMatch(/\.cq-ov-check\s*{[^}]*var\(--cq-check\)/);
    expect(boardCss).toMatch(/\.cq-ov-last\s*{[^}]*var\(--cq-last\)/);
    expect(boardCss).toMatch(/\.cq-ov-sel\s*{[^}]*var\(--cq-sel\)/);
    expect(boardCss).toMatch(/\.cq-ov-hint\s*{[^}]*var\(--cq-hint\)/);
    expect(boardCss).toMatch(/\.cq-hl-move::after\s*{[^}]*var\(--cq-move\)/);
    expect(boardCss).toMatch(/\.cq-hl-cap::after\s*{[^}]*var\(--cq-move\)/);
  });

  it("coordinate text colour is the opposite-tone token, not a bare flat colour", () => {
    expect(boardCss).toMatch(/var\(--cq-coord-on-light\)/);
    expect(boardCss).toMatch(/var\(--cq-coord-on-dark\)/);
    // The old rule set `color: #7e22ce` directly on the coordinate pseudo-
    // elements. #7e22ce may still appear as a --cq-coord-on-* TOKEN VALUE
    // (the purple theme reuses it), just never as a bare `color:` again.
    expect(boardCss).not.toMatch(/color:\s*#7e22ce/);
  });

  it("drops the hardcoded purple border for a radius + the existing card shadow token", () => {
    expect(boardCss).not.toContain("border: 2px solid");
    expect(boardCss).not.toContain("--color-purple-950");
    expect(boardCss).toContain("border-radius: 6px");
    expect(boardCss).toMatch(/box-shadow:\s*var\(--shadow-sm/);
  });

  it("none of the old hardcoded board colours survive as a bare (non-token) usage", () => {
    // purple-50, purple-200, purple-600, coordinate purple-700 — the exact
    // literals the pre-W1 board hardcoded. Tokens are free to reuse purple as
    // a THEME's chosen value (see the purple theme block), but always behind
    // a --cq-* custom property now, never as a bare property value.
    for (const oldLiteral of ["#faf5ff", "#e9d5ff", "#9333ea"]) {
      const bareUsage = new RegExp(`:\\s*${oldLiteral}\\b(?!.*--cq-)`, "i");
      // Every remaining mention must be on the RHS of a --cq-* custom
      // property declaration (the purple theme's own token values).
      const lines = boardCss.split("\n").filter((l) => l.includes(oldLiteral));
      for (const line of lines) {
        expect(line).toMatch(/--cq-[a-z-]+:\s*/);
      }
      void bareUsage;
    }
  });

  it("the print certificate section is untouched by the token migration", () => {
    expect(printCss).toContain("#2f7d52");
    expect(printCss).toContain("#c9971f");
    expect(printCss).toContain(".cq-cert-sheet");
  });

  it("pop/shake/hint-pulse animations are guarded by prefers-reduced-motion", () => {
    expect(boardCss).toMatch(
      /@media \(prefers-reduced-motion:\s*no-preference\)\s*{[^]*cq-pop[^]*cq-shake[^]*cq-hint-pulse/,
    );
  });
});
