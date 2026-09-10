// `_THEMES.md` §4's footer composition (product rulings 2026-09-10, on the
// defect Task 8's hockey seed PHOTOGRAPHED — the first time three card chips
// had ever rendered anywhere).
//
// THREE rules, and this file is the node-provable half of each:
//
//  0. The footer is a start-aligned list with `gap: 18`, not `space-between`.
//  1. A corner bug is not a log — AT MOST THE TWO MOST RECENT detail entries,
//     on ONE `white-space: nowrap` line. §3's bar keeps the full list (1776 px
//     and a dedicated 51 px band); the bug has 480 px and 45.
//  2. An entry is one unit — chip, label and separator in a REAL BOX.
//     `className="contents"` sat on the per-entry span in BOTH renderers, and
//     `display: contents` puts all three straight into the flex container, so
//     they wrap independently: the `·` separators landed on the clipped line
//     as stray dots, detached from the labels they belong to.
//
// WHAT THIS FILE CANNOT SEE, and says so rather than implying otherwise:
// `apps/web` vitest is `environment: "node"`. There is no layout here, so no
// test below measures the 9 px vertical clip that started this, or proves that
// the tile did not simply GROW to fit (§4: an OBS operator frames the bug
// against their camera, so a graphic that changes height on air moves into the
// shot). That belongs to `e2e/stream-overlay.spec.ts`'s
// "the tile shows a footer it cannot hold, and does not clip it", which
// measures `scrollHeight - clientHeight` on `.ovl-bug` in a real browser and
// which this change exists to turn green. What IS provable here: the RENDERERS
// emit two entries and not three, in a box and not a `contents` shim, and the
// CSS SOURCE declares the list and the nowrap that keep them on one line.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";
import type { ReactElement } from "react";

const keyMsg: OverlayMsg = (key) => key;

const GLOBALS_CSS = join(__dirname, "..", "..", "..", "app", "globals.css");
const css = () => readFileSync(GLOBALS_CSS, "utf8");

/** The full text of one `.selector { ... }` rule (first occurrence), or "" if
 *  the selector never appears — `discipline-chip-and-hairline.test.tsx`'s own
 *  helper, and `contrast.test.ts`'s style of reading globals.css as text. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.[\]]/g, "\\$&");
  const m = css().match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1]! : "";
}

const BASE_MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live", period: "H2" },
  sides: [
    { short: "MIL", name: "Milton Keynes Rovers", big: "2", led: false, serving: false },
    { short: "AWA", name: "Awaydon Athletic", big: "1", led: true, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: [],
};

/** The photographed state: hockey, three cards on the ledger, behind the
 *  strength line. `detailOf` pushes serve/strength first and the discipline
 *  list in engine order, so the MOST RECENT card is last. */
const FOUR_LINES: OverlayModel["detail"] = [
  { text: "11v8" },
  { text: "MIL Green card", tone: "advisory" },
  { text: "AWA Yellow card", tone: "caution" },
  { text: "AWA Red card", tone: "dismissal" },
];

const entriesIn = (tree: ReactElement[]) =>
  tree.filter((el) => (propsOf(el).className as string | undefined) === "ovl-detail-entry");

const render = (Component: typeof OverlayBar | typeof OverlayBug, model: OverlayModel) =>
  walk(Component({ model, tick: [false, false], msg: keyMsg }));

const footerOf = (tree: ReactElement[]) =>
  tree.find((el) => propsOf(el)["data-testid"] === "ovl-detail");

// ---------------------------------------------------------------------------
// Rule 1 — at most the two MOST RECENT entries, in the bug only.
// ---------------------------------------------------------------------------
describe("§4 rule 1 — the bug's footer holds at most the two most recent entries", () => {
  it("four lines in, the LAST TWO out — a cap of three, or the first two, both red here", () => {
    const tree = render(OverlayBug, { ...BASE_MODEL, detail: FOUR_LINES });
    const entries = entriesIn(tree);
    expect(entries.length, "the bug renders at most two detail entries").toBe(2);
    // The TEXTS, not just the count: taking `slice(0, 2)` would also produce
    // two entries and would be the wrong two.
    expect(textOf(entries[0]!)).toContain("AWA Yellow card");
    expect(textOf(entries[1]!)).toContain("AWA Red card");
  });

  it("the dropped lines are GONE from the footer, not merely unboxed", () => {
    const tree = render(OverlayBug, { ...BASE_MODEL, detail: FOUR_LINES });
    const footer = footerOf(tree);
    expect(footer, "the footer must render at all").toBeDefined();
    const text = textOf(footer!);
    expect(text, "the strength line is the third-oldest and must not survive").not.toContain("11v8");
    expect(text, "the oldest card must not survive either").not.toContain("MIL Green card");
    expect(text).toContain("AWA Red card");
  });

  it("the chips are capped with their lines — two chips, the two most recent tones", () => {
    const tree = render(OverlayBug, { ...BASE_MODEL, detail: FOUR_LINES });
    const chips = tree.filter((el) => propsOf(el)["data-testid"] === "ovl-chip");
    expect(chips.map((el) => propsOf(el).className)).toEqual([
      "ovl-chip ovl-chip-caution",
      "ovl-chip ovl-chip-dismissal",
    ]);
  });

  it("the positive pair — two lines in, BOTH survive: the cap only bites past two", () => {
    const tree = render(OverlayBug, { ...BASE_MODEL, detail: FOUR_LINES.slice(2) });
    const entries = entriesIn(tree);
    expect(entries.length).toBe(2);
    expect(textOf(entries[0]!)).toContain("AWA Yellow card");
    expect(textOf(entries[1]!)).toContain("AWA Red card");
  });

  it("§3's BAR keeps the full list — the cap is the bug's, not the model's", () => {
    // The differential that makes the rule above a rule about THIS theme. A cap
    // pushed into `overlayModel` (or copied into `overlay-bar.tsx`) reds here.
    const tree = render(OverlayBar, { ...BASE_MODEL, detail: FOUR_LINES });
    expect(entriesIn(tree).length, "the bar has 1776px and a dedicated band").toBe(4);
    expect(textOf(footerOf(tree)!)).toContain("11v8");
  });

  it("a chase line LEADS the row and does not spend one of the two slots", () => {
    const tree = render(OverlayBug, { ...BASE_MODEL, detail: FOUR_LINES, chase: "Need 45 off 45" });
    const footer = footerOf(tree);
    const emphasis = tree.find((el) => (propsOf(el).className as string | undefined) === "ovl-detail-emphasis");
    expect(emphasis, "the chase line renders").toBeDefined();
    expect(textOf(emphasis!)).toBe("Need 45 off 45");
    expect(entriesIn(tree).length, "still two entries beside it").toBe(2);
    // "Where a chase or result line is present it leads the row" (§4 rule 0).
    expect(textOf(footer!).indexOf("Need 45 off 45")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — an entry is one unit, in BOTH renderers.
// ---------------------------------------------------------------------------
describe.each([
  // The lines each renderer is expected to SHOW, given `FOUR_LINES` — the bug
  // capped to the two most recent, the bar keeping all four (one of which,
  // the strength line, carries no tone and so owes no chip).
  ["OverlayBug", OverlayBug, FOUR_LINES.slice(-2)],
  ["OverlayBar", OverlayBar, FOUR_LINES],
] as const)("§4 rule 2 — %s wraps each entry in a real box", (_name, Component, shown) => {
  it("no element in the tree is a `contents` shim", () => {
    const tree = render(Component, { ...BASE_MODEL, detail: FOUR_LINES });
    const shims = tree.filter((el) => (propsOf(el).className as string | undefined) === "contents");
    expect(shims.length, "`display: contents` is what let chip, label and separator wrap apart").toBe(0);
  });

  it("each entry's chip and label live INSIDE that entry's own subtree", () => {
    const tree = render(Component, { ...BASE_MODEL, detail: FOUR_LINES });
    const entries = entriesIn(tree);
    expect(entries.length).toBe(shown.length);
    entries.forEach((entry, i) => {
      const line = shown[i]!;
      const inside = walk(entry);
      expect(
        inside.filter((el) => propsOf(el)["data-testid"] === "ovl-chip").length,
        "a toned entry carries its own chip, not the container's; an untoned one carries none",
      ).toBe(line.tone ? 1 : 0);
      expect(textOf(entry), "and its own label").toContain(line.text);
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 0 + the nowrap — the CSS SOURCE. A source scan proves the RULE EXISTS;
// only the browser proves it is painted, which is the e2e named at the top.
// ---------------------------------------------------------------------------
describe("§4 rule 0 — the footer is a start-aligned gap-18 list, on one line", () => {
  it(".ovl-bug-footer drops space-between for gap: 18px", () => {
    const rule = ruleBody(".ovl-bug-footer");
    expect(rule, "globals.css declares no .ovl-bug-footer rule").not.toBe("");
    expect(rule, "two entries at the outer edges of a 480px tile read as two unrelated things").not.toMatch(
      /space-between/,
    );
    expect(rule).toMatch(/gap:\s*18px/);
    expect(rule).toMatch(/justify-content:\s*flex-start/);
  });

  it(".ovl-bug-footer never wraps", () => {
    const rule = ruleBody(".ovl-bug-footer");
    expect(rule, "a flex container's TEXT items wrap internally without this").toMatch(/white-space:\s*nowrap/);
  });

  it("...and does NOT absorb its own overflow — the tile clips, and the e2e watches the tile", () => {
    // Measured in Chromium against the real markup and this real stylesheet:
    // with `overflow: hidden` on the footer, defeating the nowrap above leaves
    // `.ovl-bug` at scrollHeight 273 = clientHeight 273 — the regression is
    // INVISIBLE to `stream-overlay.spec.ts`'s "the tile shows a footer it
    // cannot hold, and does not clip it", which is the only test this defect
    // has. Without it the same defeat reads 299 vs 273. So the footer must NOT
    // become a scroll container, and the tile must stay the one that clips.
    expect(ruleBody(".ovl-bug-footer"), "absorbing here blinds the tile's own probe").not.toMatch(/overflow:/);
    expect(ruleBody(".ovl-bug"), "the tile is where §4 puts the clip").toMatch(/overflow:\s*hidden/);
  });

  it(".ovl-detail-entry is a real box that never breaks across lines", () => {
    const rule = ruleBody(".ovl-detail-entry");
    expect(rule, "globals.css declares no .ovl-detail-entry rule").not.toBe("");
    expect(rule).toMatch(/display:\s*(inline-)?flex/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });
});

// ---------------------------------------------------------------------------
// The context guard §3 already had and §4 was owed.
// ---------------------------------------------------------------------------
describe("§4 — .ovl-bug-context is guarded like the bar's .ovl-context", () => {
  it("carries min-width: 0, white-space: nowrap and overflow: hidden", () => {
    const rule = ruleBody(".ovl-bug-context");
    expect(rule, "globals.css declares no .ovl-bug-context rule").not.toBe("");
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  it("the twin it is copied from still has all three — the guard is the pair", () => {
    const rule = ruleBody(".ovl-context");
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });
});
