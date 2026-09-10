// Review round 1 (CRITICAL + IMPORTANT): the `--sport-ink` hairline on the
// live dot, and the discipline card chip that was missing entirely.
//
// Two claims, and `environment: "node"` (no jsdom) can only prove one of
// them fully:
//
//  1. The CSS SOURCE declares the hairline (both `.ovl-live-dot` locations,
//     via the one shared base rule) and the chip classes with the right
//     dimensions and colour tokens. A source-scan test proves the RULE
//     EXISTS; it cannot prove the border is actually PAINTED — that needs a
//     real browser. OWED TO TASK 8's e2e: `stream-overlay.spec.ts` should
//     assert `getComputedStyle(dot).borderWidth === "1px"` (or a boundingBox
//     probe) on `[data-testid="ovl-live-dot"]`, and the same on
//     `[data-testid="ovl-chip"]` once a fixture with a live card exists.
//  2. `OverlayBar`/`OverlayBug` actually render the chip element (with the
//     right tone class) for a toned detail line, and render NOTHING for an
//     untoned one — this half IS provable under node: neither component uses
//     hooks, so calling them as plain functions and walking the returned
//     element tree (the same `walk`/`propsOf` helpers Task 1's tests use) is
//     a real, non-mocked render of THIS wave's actual production components.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";

/** Fix round 5 — both themes resolve the brand wordmark through `msg`
 *  (`overlay.brand`, I5); returning the key keeps this file about the chips. */
const keyMsg: OverlayMsg = (key) => key;

const GLOBALS_CSS = join(__dirname, "..", "..", "..", "app", "globals.css");
const css = () => readFileSync(GLOBALS_CSS, "utf8");

/** The full text of one `.selector { ... }` rule (first occurrence), or ""
 *  if the selector never appears. Matches contrast.test.ts's own style of
 *  reading globals.css as text rather than parsing it as CSS. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.[\]]/g, "\\$&");
  const m = css().match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1]! : "";
}

describe("the --sport-ink hairline exists in source (CRITICAL fix)", () => {
  it("the base .ovl-live-dot rule carries a 1px solid --sport-ink border", () => {
    const rule = ruleBody(".ovl-live-dot");
    expect(rule, "globals.css declares no .ovl-live-dot rule at all").not.toBe("");
    expect(rule).toMatch(/border:\s*1px\s+solid\s+var\(--sport-ink\)/);
  });

  it("the bug header's dot variant does not re-declare (and so cannot omit) the border — it only overrides size", () => {
    const rule = ruleBody(".ovl-bug-header .ovl-live-dot");
    expect(rule, "globals.css declares no .ovl-bug-header .ovl-live-dot override").not.toBe("");
    // The override rule is size-only; the hairline comes from the base rule
    // above by CSS specificity/cascade (border is never set here, so nothing
    // here can un-set it either).
    expect(rule).not.toMatch(/border/);
    expect(rule).toMatch(/width:\s*13\.5px/);
  });
});

describe("the discipline chip class exists in source, per _THEMES.md §3/§4 (IMPORTANT fix)", () => {
  it(".ovl-chip is 13.5x18, radius 3, with the --sport-ink hairline", () => {
    const rule = ruleBody(".ovl-chip");
    expect(rule, "globals.css declares no .ovl-chip rule").not.toBe("");
    expect(rule).toMatch(/width:\s*13\.5px/);
    expect(rule).toMatch(/height:\s*18px/);
    expect(rule).toMatch(/border-radius:\s*3px/);
    expect(rule).toMatch(/border:\s*1px\s+solid\s+var\(--sport-ink\)/);
  });

  it.each([
    ["advisory", "--sport-advisory"],
    ["caution", "--sport-caution"],
    ["dismissal", "--sport-dismissal"],
  ])("%s reads %s", (tone, token) => {
    const rule = ruleBody(`.ovl-chip-${tone}`);
    expect(rule, `globals.css declares no .ovl-chip-${tone} rule`).not.toBe("");
    expect(rule).toMatch(new RegExp(`background:\\s*var\\(${token}\\)`));
  });
});

// ---------------------------------------------------------------------------
// Component wiring — provable under node: neither renderer uses a hook.
// ---------------------------------------------------------------------------
const BASE_MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "Live", period: "2nd half" },
  sides: [
    { short: "MIL", name: "Milton Keynes Rovers", big: "2", led: false, serving: false },
    { short: "NOR", name: "Northbridge Athletic", big: "1", led: true, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: [],
};

function chipsIn(tree: ReturnType<typeof walk>) {
  return tree.filter((el) => propsOf(el)["data-testid"] === "ovl-chip");
}

describe.each([
  ["OverlayBar", OverlayBar],
  ["OverlayBug", OverlayBug],
] as const)("%s renders the chip for a toned line and nothing for an untoned one", (_name, Component) => {
  it("a toned detail line renders exactly one ovl-chip, coloured for its tone", () => {
    const model: OverlayModel = {
      ...BASE_MODEL,
      detail: [{ text: "overlay.detail.card(side=NOR,card=Yellow card)", tone: "caution" }],
    };
    const tree = walk(Component({ model, tick: [false, false], msg: keyMsg }));
    const chips = chipsIn(tree);
    expect(chips.length, "the toned line must produce exactly one chip").toBe(1);
    expect(propsOf(chips[0]!).className).toContain("ovl-chip-caution");
  });

  it("an untoned detail line (the serve sentence) renders NO chip — the positive/negative pair", () => {
    const model: OverlayModel = {
      ...BASE_MODEL,
      detail: [{ text: "overlay.detail.serving(side=MIL)" }],
    };
    const tree = walk(Component({ model, tick: [false, false], msg: keyMsg }));
    expect(chipsIn(tree).length, "an untoned line must render no chip at all").toBe(0);
  });

  it("three different tones render three differently-coloured chips — not a constant class", () => {
    const model: OverlayModel = {
      ...BASE_MODEL,
      detail: [
        { text: "a", tone: "advisory" },
        { text: "b", tone: "caution" },
        { text: "c", tone: "dismissal" },
      ],
    };
    const tree = walk(Component({ model, tick: [false, false], msg: keyMsg }));
    const classes = chipsIn(tree).map((el) => propsOf(el).className);
    expect(classes).toEqual(["ovl-chip ovl-chip-advisory", "ovl-chip ovl-chip-caution", "ovl-chip ovl-chip-dismissal"]);
  });
});
