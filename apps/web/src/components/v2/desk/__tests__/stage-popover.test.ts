// The stage card's two floating menus (More, and the Pair next ▾ panel) hang from their trigger from `md` up. Which edge they hang
// from is decided by where the trigger sits, so a panel never leaves its CARD (or the viewport): that decision is pure, and it is pinned
// here. The browser half (the card does not grow, the menu is on top, the panel stays inside the card, outside press / Escape close it) is
// e2e/stage-card-actions.spec.ts.
import { afterEach, describe, expect, it } from "vitest";
import { POPOVER_EDGE_PX, POPOVER_WIDTH_PX, alignOf, boundsOf, popoverAlign, popoverClasses, pressedAnItem } from "../stage-popover";

describe("popoverAlign - which edge of the trigger the panel hangs from", () => {
  const W = POPOVER_WIDTH_PX + POPOVER_EDGE_PX;
  // [name, trigger left, trigger right, the run the panel must stay inside, expected]. The viewports are the md range's floor, a laptop and a
  // desktop; the trigger positions are chosen from the edges of the rule itself (room exactly enough, one pixel short), not from what the
  // code returns. The card rows are the owner's laptop: a card whose right border is at 1199, which a panel hung from a trigger at x=829
  // used to overhang by 14px (review m2).
  const VIEWPORT = (vw: number) => boundsOf(null, vw);
  const CARD = (left: number, right: number, vw: number) => boundsOf({ left, right }, vw);
  const ROWS: Array<[string, number, number, { left: number; right: number }, "start" | "end"]> = [
    ["768: More near the left edge has room to the right", 16, 96, VIEWPORT(768), "start"],
    ["768: More wrapped to the right edge has no room to the right, so it hangs from its right edge", 660, 740, VIEWPORT(768), "end"],
    ["1280: More in the middle of the header", 700, 780, VIEWPORT(1280), "start"],
    ["the last pixel that still fits to the right", 768 - W, 768 - W + 80, VIEWPORT(768), "start"],
    ["one pixel past it", 768 - W + 1, 768 - W + 81, VIEWPORT(768), "end"],
    ["neither side has room (a trigger wider than the viewport allows): start, never a negative left edge", 300, 380, VIEWPORT(400), "start"],
    ["1280 card (right border 1199): a trigger at x=829 would overhang it by 14px, so it hangs from its right edge", 829, 909, CARD(81, 1199, 1280), "end"],
    ["1280 card: the last pixel that still fits inside the card", 1199 - POPOVER_WIDTH_PX, 1199 - POPOVER_WIDTH_PX + 80, CARD(81, 1199, 1280), "start"],
    ["1280 card: one pixel past it", 1199 - POPOVER_WIDTH_PX + 1, 1199 - POPOVER_WIDTH_PX + 81, CARD(81, 1199, 1280), "end"],
    ["a card nearly as wide as the page: the viewport's margin still binds", 700, 780, CARD(0, 1280, 1280), "start"],
    ["the card's right edge is left of the viewport's: the card decides", 600, 680, CARD(100, 900, 1280), "end"],
  ];

  it.each(ROWS)("%s", (_name, left, right, bounds, expected) => {
    expect(popoverAlign({ left, right }, bounds)).toBe(expected);
  });

  it("the table has both answers (a rule that always answers one of them is not under test)", () => {
    const answers = new Set(ROWS.map(([, left, right, bounds]) => popoverAlign({ left, right }, bounds)));
    expect(ROWS.length).toBeGreaterThan(0);
    expect(answers).toEqual(new Set(["start", "end"]));
  });

  it("the card narrows the run and so moves the answer: the same trigger answers differently with and without its card", () => {
    const trigger = { left: 829, right: 909 };
    expect(popoverAlign(trigger, VIEWPORT(1280)), "the viewport alone has room").toBe("start");
    expect(popoverAlign(trigger, CARD(81, 1199, 1280)), "the card does not").toBe("end");
  });

  it("every md-range viewport has room on one side for a trigger anywhere in it (the panel never has to overflow)", () => {
    let checked = 0;
    for (const vw of [768, 834, 1024, 1280, 1440]) {
      const bounds = VIEWPORT(vw);
      for (let left = 0; left + 44 <= vw; left += 4) {
        const right = left + 44;
        const side = popoverAlign({ left, right }, bounds);
        const edgeFits = side === "start" ? left + POPOVER_WIDTH_PX <= bounds.right : right - POPOVER_WIDTH_PX >= bounds.left;
        expect(edgeFits, `vw ${vw}, trigger ${left}-${right}: ${side} overflows`).toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: positions swept").toBeGreaterThan(300);
  });

  it("a card whose run holds the panel on one side: every trigger inside it gets a side that stays inside the card", () => {
    let checked = 0;
    for (const [vw, left, right] of [[768, 16, 752], [1024, 16, 1008], [1280, 81, 1199], [1440, 100, 1340]] as const) {
      const bounds = CARD(left, right, vw);
      for (let x = left; x + 44 <= right; x += 4) {
        const side = popoverAlign({ left: x, right: x + 44 }, bounds);
        const inside = side === "start" ? x + POPOVER_WIDTH_PX <= bounds.right : x + 44 - POPOVER_WIDTH_PX >= bounds.left;
        // A card narrower than two panels (the 768 one) has triggers with no side that fits; those answer start (the documented fallback).
        const anyFits = x + POPOVER_WIDTH_PX <= bounds.right || x + 44 - POPOVER_WIDTH_PX >= bounds.left;
        if (anyFits) expect(inside, `vw ${vw}, card ${left}-${right}, trigger ${x}: ${side} leaves the card`).toBe(true);
        else expect(side, `vw ${vw}, trigger ${x}: no side fits, so start`).toBe("start");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: positions swept").toBeGreaterThan(300);
  });
});

describe("boundsOf - the run a panel must stay inside", () => {
  it("is the card's run, narrowed by the viewport's edge margin; the viewport's alone where there is no card", () => {
    expect(boundsOf({ left: 81, right: 1199 }, 1280)).toEqual({ left: 81, right: 1199 });
    expect(boundsOf({ left: 0, right: 1280 }, 1280), "a card wider than the margins allow").toEqual({ left: POPOVER_EDGE_PX, right: 1280 - POPOVER_EDGE_PX });
    expect(boundsOf(null, 1024), "no card").toEqual({ left: POPOVER_EDGE_PX, right: 1024 - POPOVER_EDGE_PX });
  });
});

describe("alignOf - measured from the DOM, against the trigger's own card", () => {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const saved = g.window;
  afterEach(() => {
    if (had) g.window = saved;
    else delete g.window;
  });
  const trigger = (rect: { left: number; right: number }, card: { left: number; right: number } | null) =>
    ({ getBoundingClientRect: () => rect, closest: (sel: string) => (sel === "section[data-stage-id]" && card ? { getBoundingClientRect: () => card } : null) }) as unknown as Element;

  it("hangs from the right edge when the card runs out before the panel does, though the viewport has room", () => {
    g.window = { innerWidth: 1280 };
    expect(alignOf(trigger({ left: 829, right: 909 }, { left: 81, right: 1199 })), "inside its card").toBe("end");
    expect(alignOf(trigger({ left: 829, right: 909 }, null)), "the same trigger with no card around it").toBe("start");
  });

  it("is start where there is nothing to measure (no trigger, no window)", () => {
    g.window = { innerWidth: 1280 };
    expect(alignOf(null)).toBe("start");
    delete g.window;
    expect(alignOf(trigger({ left: 829, right: 909 }, { left: 81, right: 1199 }))).toBe("start");
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
  it("the width class and POPOVER_WIDTH_PX are the same number (the alignment rule is only right while they agree - review m6)", () => {
    for (const align of ["start", "end"] as const) {
      const token = popoverClasses(align).split(/\s+/).find((c) => /^md:w-\d+$/.test(c));
      expect(token, `${align}: a literal md:w-<n> class (Tailwind cannot generate one built at run time)`).toBeDefined();
      // Tailwind's spacing step is 0.25rem = 4px.
      expect(Number(token!.slice("md:w-".length)) * 4, `${align}: ${token} in px`).toBe(POPOVER_WIDTH_PX);
    }
  });
});

describe("pressedAnItem - a link or an ENABLED button counts, padding and a disabled button do not", () => {
  // A fake DOM whose `closest` honours the selector the code hands it (each comma part: tag, optional [href], optional :not(:disabled)),
  // so the selector's own words are under test - a fake that ignored them could not tell `button` from `button:not(:disabled)`.
  interface Node { tag: string; href?: boolean; disabled?: boolean; parent?: Node }
  const el = (n: Node) => ({
    closest(selector: string) {
      for (let cur: Node | undefined = n; cur; cur = cur.parent) {
        for (const part of selector.split(",").map((p) => p.trim())) {
          const m = /^(\w+)(\[href\])?(:not\(:disabled\))?$/.exec(part);
          if (!m) throw new Error(`the fake DOM does not understand "${part}"`);
          if (cur.tag !== m[1]) continue;
          if (m[2] && !cur.href) continue;
          if (m[3] && cur.disabled) continue;
          return cur;
        }
      }
      return null;
    },
  });

  it("answers per element kind, including the element's own descendants", () => {
    const button: Node = { tag: "button" };
    const ROWS: Array<[string, Node, boolean]> = [
      ["an enabled button", button, true],
      ["text inside an enabled button (the press lands on the label)", { tag: "span", parent: button }, true],
      ["a link with an href", { tag: "a", href: true }, true],
      ["an anchor without an href", { tag: "a" }, false],
      ["a DISABLED button", { tag: "button", disabled: true }, false],
      ["text inside a disabled button", { tag: "span", parent: { tag: "button", disabled: true } }, false],
      ["padding", { tag: "div" }, false],
    ];
    for (const [name, node, expected] of ROWS) expect(pressedAnItem(el(node) as unknown as EventTarget), name).toBe(expected);
    expect(ROWS.length, "anti-vacuity").toBeGreaterThan(5);
    expect(new Set(ROWS.map((r) => r[2])), "both answers").toEqual(new Set([true, false]));
  });

  it("no target, or a target that is not an element, is not an item", () => {
    expect(pressedAnItem(null)).toBe(false);
    expect(pressedAnItem({} as unknown as EventTarget)).toBe(false);
  });
});
