// The stage card's two floating menus (More, and the Pair next ▾ panel) hang from their trigger from `md` up. Which edge they hang
// from is decided by where the trigger sits, so a panel never leaves the viewport: that decision is pure, and it is pinned here.
// The browser half (the card does not grow, the menu is on top, outside press / Escape close it) is e2e/stage-card-actions.spec.ts.
import { describe, expect, it } from "vitest";
import { POPOVER_EDGE_PX, POPOVER_WIDTH_PX, popoverAlign, popoverClasses } from "../stage-popover";

describe("popoverAlign - which edge of the trigger the panel hangs from", () => {
  const W = POPOVER_WIDTH_PX + POPOVER_EDGE_PX;
  // [name, trigger left, trigger right, viewport width, expected]. The widths are the md range's floor, a laptop and a desktop; the
  // trigger positions are chosen from the edges of the rule itself (room exactly enough, one pixel short), not from what the code returns.
  const ROWS: Array<[string, number, number, number, "start" | "end"]> = [
    ["768: More near the left edge has room to the right", 16, 96, 768, "start"],
    ["768: More wrapped to the right edge has no room to the right, so it hangs from its right edge", 660, 740, 768, "end"],
    ["1280: More in the middle of the header", 700, 780, 1280, "start"],
    ["the last pixel that still fits to the right", 768 - W, 768 - W + 80, 768, "start"],
    ["one pixel past it", 768 - W + 1, 768 - W + 81, 768, "end"],
    ["neither side has room (a trigger wider than the viewport allows): start, never a negative left edge", 300, 380, 400, "start"],
  ];

  it.each(ROWS)("%s", (_name, left, right, vw, expected) => {
    expect(popoverAlign({ left, right }, vw)).toBe(expected);
  });

  it("the table has both answers (a rule that always answers one of them is not under test)", () => {
    const answers = new Set(ROWS.map(([, left, right, vw]) => popoverAlign({ left, right }, vw)));
    expect(ROWS.length).toBeGreaterThan(0);
    expect(answers).toEqual(new Set(["start", "end"]));
  });

  it("every md-range viewport has room on one side for a trigger anywhere in it (the panel never has to overflow)", () => {
    let checked = 0;
    for (const vw of [768, 834, 1024, 1280, 1440]) {
      for (let left = 0; left + 44 <= vw; left += 4) {
        const right = left + 44;
        const side = popoverAlign({ left, right }, vw);
        const edgeFits = side === "start" ? left + W <= vw : right - W >= 0;
        expect(edgeFits, `vw ${vw}, trigger ${left}-${right}: ${side} overflows`).toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: positions swept").toBeGreaterThan(300);
  });
});

describe("popoverClasses - the panel is in flow below md, a positioned popover from md", () => {
  it("every positioning class is md-prefixed (a bare one would float the panel inside the phone sheet)", () => {
    for (const align of ["start", "end"] as const) {
      const classes = popoverClasses(align).split(/\s+/).filter(Boolean);
      expect(classes.length).toBeGreaterThan(0);
      const bare = classes.filter((c) => /^(absolute|relative|fixed|sticky|top-|left-|right-|bottom-|z-|w-|mt-)/.test(c));
      expect(bare, `${align}: unprefixed positioning classes`).toEqual([]);
      expect(classes).toContain("md:absolute");
      expect(classes).toContain(align === "end" ? "md:right-0" : "md:left-0");
      expect(classes).not.toContain(align === "end" ? "md:left-0" : "md:right-0");
    }
  });
});
