// The overlay's readability floor, read off the stylesheet (R2007 step 3; spec 2026-10-15 §4.5, D9).
//
// The computed twin of this scan is `e2e/overlay-gallery.spec.ts` check 2, which reads every rendered text element in
// every gallery cell. This one reads the DECLARATIONS, so a sub-floor rule that no gallery cell happens to reach still
// goes red here. Uses the repo's one CSS reader (`_globals-css.ts`); an assumption is a guard, so a font-size form the
// scan cannot read FAILS by name rather than being skipped.
import { describe, expect, it } from "vitest";
import { declaredValue, parseCss, readGlobalsCss } from "@/components/v2/scorepad/v3/__tests__/_globals-css";

const TEXT_FLOOR_PX = 30; // spec 2026-10-15 §4.5 (D9): no overlay text below 30 px at 1920×1080
const BAR_BOTTOM_MIN_PX = 150; // spec §4.5: the bar's bottom clear of YouTube's controls (~14 %)

const RULES = parseCss(readGlobalsCss());
const OVL = /\.ovl-/;

describe("the 30 px text floor (D9)", () => {
  it("every .ovl- rule that declares a font-size declares px ≥ the floor, in a form the scan can read", () => {
    const below: string[] = [];
    const unparsed: string[] = [];
    let checked = 0;
    for (const rule of RULES) {
      if (!OVL.test(rule.selector)) continue;
      const shorthand = declaredValue(rule, "font");
      if (shorthand !== undefined) unparsed.push(`${rule.selector} { font: ${shorthand} } — unparsed font-size form`);
      const size = declaredValue(rule, "font-size");
      if (size === undefined) continue;
      checked++;
      const px = /^(\d+(?:\.\d+)?)px$/.exec(size);
      if (!px) {
        unparsed.push(`${rule.selector} { font-size: ${size} } — unparsed font-size form`);
        continue;
      }
      if (Number(px[1]) < TEXT_FLOOR_PX) below.push(`${rule.selector} ${size}`);
    }
    console.log(`font-size declarations checked: ${checked}`);
    expect(checked, "anti-vacuity: no .ovl- font-size declaration found").toBeGreaterThan(0);
    expect(unparsed, "font-size forms the scan cannot read").toEqual([]);
    expect(below, `.ovl- rules below ${TEXT_FLOOR_PX}px`).toEqual([]);
  });
});

describe("the bar lift (D9)", () => {
  it("--ovl-bar-bottom on .ovl-canvas is px ≥ 150", () => {
    const values = RULES.filter((r) => r.selector === ".ovl-canvas")
      .map((r) => declaredValue(r, "--ovl-bar-bottom"))
      .filter((v): v is string => v !== undefined);
    expect(values.length, "anti-vacuity: --ovl-bar-bottom is declared on .ovl-canvas").toBeGreaterThan(0);
    for (const v of values) {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
      expect(px, `--ovl-bar-bottom: ${v} is not a px length`).not.toBeNull();
      expect(Number(px![1])).toBeGreaterThanOrEqual(BAR_BOTTOM_MIN_PX);
    }
  });
});

describe("the card layout consumes the registry (G2)", () => {
  it(".ovl-slate-content is placed by the card variables, never centred on the whole canvas", () => {
    const rules = RULES.filter((r) => r.selector === ".ovl-slate-content");
    expect(rules.length, "anti-vacuity: .ovl-slate-content is declared").toBeGreaterThan(0);
    const last = (prop: string): string | undefined => {
      let found: string | undefined;
      for (const r of rules) found = declaredValue(r, prop) ?? found;
      return found;
    };
    expect(last("position")).toBe("absolute");
    expect(last("left")).toBe("var(--ovl-card-x)");
    expect(last("top")).toBe("var(--ovl-card-y)");
    expect(last("width")).toBe("var(--ovl-card-w)");
    expect(last("height")).toBe("var(--ovl-card-h)");
    for (const r of rules) {
      expect(declaredValue(r, "inset"), "inset: 0 centres the card on the whole canvas").toBeUndefined();
      for (const prop of ["padding", "padding-bottom"]) {
        expect(declaredValue(r, prop) ?? "", `${prop} must not reserve the bar stack`).not.toMatch(/--ovl-bar-/);
      }
    }
  });
});

// The floor raised every card's type, and two card rules did not survive the raise (captured 2026-10-16 at 844×475):
// a context pill that is a flex container centres its overflowing text past BOTH edges, so "RESULT · <competition>"
// lost its first word; and a fixed-width tile wrapped a cricket score ("94/8 (10.2)") onto two lines. The rendered
// twin of both is `e2e/overlay-gallery.spec.ts` check 4b.
describe("the card's type fits its boxes at the floor", () => {
  const lastOf = (selector: string, prop: string): string | undefined => {
    const rules = RULES.filter((r) => r.selector === selector);
    expect(rules.length, `anti-vacuity: ${selector} is declared`).toBeGreaterThan(0);
    let found: string | undefined;
    for (const r of rules) found = declaredValue(r, prop) ?? found;
    return found;
  };

  // Both card pills: a flex container never draws `text-overflow: ellipsis` on its own text (the run becomes an anonymous
  // flex item), so the context pill lost its first word and the name pill cut a club's name mid-letter with no "…".
  it.each([".ovl-slate-pill", ".ovl-slate-name-pill"])("%s is a block that ellipsises at its END", (selector) => {
    expect(lastOf(selector, "display")).toBe("block");
    expect(lastOf(selector, "white-space")).toBe("nowrap");
    expect(lastOf(selector, "overflow")).toBe("hidden");
    expect(lastOf(selector, "text-overflow")).toBe("ellipsis");
  });

  it(".ovl-slate-tile grows with its score (a floor, not a fixed width), and the score never wraps", () => {
    expect(lastOf(".ovl-slate-tile", "width"), "a fixed width wraps a long score").toBeUndefined();
    expect(lastOf(".ovl-slate-tile", "min-width")).toMatch(/^\d+px$/);
    expect(lastOf(".ovl-slate-tile-score", "white-space")).toBe("nowrap");
  });

  // The crease band's ball glyphs: a one-character ball ("4", "W") is a circle, but at the floor a two-character extra
  // ("wd", "nb", "lb") fills a 44 px circle edge to edge. The width is a floor, so the circle becomes a pill instead.
  it(".ovl-ball-glyph grows with its text (a floor, not a fixed width)", () => {
    expect(lastOf(".ovl-ball-glyph", "width"), "a fixed width crams a two-letter extra").toBeUndefined();
    expect(lastOf(".ovl-ball-glyph", "min-width")).toMatch(/^\d+px$/);
    expect(lastOf(".ovl-ball-glyph", "min-width")).toBe(lastOf(".ovl-ball-glyph", "height"));
  });
});
