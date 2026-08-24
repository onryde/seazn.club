// R3 review round — THE CRICKET PIXEL THAT MOVED, and the guard that can see
// the kind of defect it was.
//
// Ruling R3-6 gives every sport its own palette and, in the same breath, makes
// cricket's byte-identity binding: "build the token layer so that cricket's
// current values ARE the default token set … any implementation that changes a
// cricket pixel is wrong." Task B4 changed one. It added
//
//   .pad-half:focus-visible { outline-color: var(--sport-led); }
//
// unlayered, at specificity (0,2,0), where the platform's own ring
// (`:where(a, button, summary, [role="tab"]):focus-visible`) is unlayered at
// (0,1,0) — `:where()` scores zero. So keyboard-focusing a cricket scorebug
// half drew the ring in the DEFAULT LED, lime, where it had always been the
// platform violet `--ps-accent`. The Tailwind utility the rule replaced
// (`focus-visible:outline-lime-400`) had never won: it lives in
// `@layer utilities`, and every layered rule loses to every unlayered one.
//
// WHY THE EXISTING PROOF COULD NOT SEE IT. `sport-theme.test.ts`'s three locks
// are data (cricket declares no override), resolution (the default palette is
// the pre-B4 hex table) and render (the Scorebug emits only `.pad-*` classes).
// All three were TRUE while the pixel moved, because all three run in a node
// environment against class names and hex tables and the defect lives in the
// CASCADE. No assertion about which class an element carries can answer which
// rule wins on it.
//
// So the guard computes the cascade. `_globals-css.ts` parses globals.css into
// rules that know their layer, conditions, specificity and source order, and
// `cascadeWinner` returns the rule that actually wins a property on a given
// element. Its own header states exactly what it cannot see — chiefly that
// Tailwind's generated utilities are not in this file's text, which is sound
// here only because every one of them is in `@layer utilities` and therefore
// cannot beat any rule this reader does see.
import { describe, expect, it } from "vitest";
import { cascadeWinner, declaredValue, parseCss, readGlobalsCss, specificity } from "./_globals-css";
import type { ElementSpec } from "./_globals-css";
import { NIGHT_TILE_CLASSES } from "../tokens";
import { SPORT_PALETTES } from "../sport-theme";

const rules = parseCss(readGlobalsCss());

/** The tappable scorebug half, exactly as `scorebug.tsx` renders it: a real
 *  `<button>` carrying `NIGHT_TILE_CLASSES.half`. Read off the production
 *  constant so a rename cannot leave this test measuring a class nothing
 *  renders. */
function focusedHalf(): ElementSpec {
  return { tag: "button", classes: [NIGHT_TILE_CLASSES.half], pseudo: ["focus-visible"] };
}

/** The pad root as `PadHostV3` renders it for a sport that overrides the
 *  palette, and for one that does not. The attribute is the ONLY thing that
 *  distinguishes them, which is what keeps every un-overriding sport on the
 *  platform ring by construction rather than by a per-sport CSS rule. */
const THEMED_ROOT: ElementSpec = { tag: "div", classes: [], attrs: { "data-sport-theme": "football" } };
const PLAIN_ROOT: ElementSpec = { tag: "div", classes: [] };

const ringOn = (ancestors: readonly ElementSpec[]): string | undefined => {
  const winner = cascadeWinner(rules, "outline-color", focusedHalf(), ancestors, {
    // The scorebug half's own hover wash sits inside `@media (hover: hover)`;
    // nothing conditional declares an outline colour, and a condition this
    // reader is not told to hold is treated as NOT holding.
    conditions: () => false,
  });
  return winner === undefined ? undefined : declaredValue(winner, "outline-color");
};

describe("the cascade reader itself (a guard nobody has checked is not a guard)", () => {
  it("scores :where() as ZERO — the one rule that decided this defect", () => {
    expect(specificity(':where(a, button, summary, [role="tab"]):focus-visible')).toEqual([0, 1, 0]);
    expect(specificity(".pad-half:focus-visible")).toEqual([0, 2, 0]);
    expect(specificity('[data-sport-theme] .pad-half:focus-visible')).toEqual([0, 3, 0]);
  });

  it("reads the platform ring out of globals.css, unlayered, with its colour from the `outline` shorthand", () => {
    const platform = rules.filter((rule) => rule.selector === ':where(a, button, summary, [role="tab"]):focus-visible');
    expect(platform, "globals.css no longer declares the platform focus ring").toHaveLength(1);
    expect(platform[0]!.layer, "the platform ring must stay UNLAYERED or every layered rule outranks it").toBeNull();
    expect(declaredValue(platform[0]!, "outline-color")).toBe("var(--ps-accent)");
  });

  it("puts an UNLAYERED rule above a layered one regardless of specificity", () => {
    const layered = { layer: "utilities", conditions: [], selector: ".pad-half.x.y:focus-visible", declarations: "outline-color: red;", order: 0 };
    const unlayered = { layer: null, conditions: [], selector: "button", declarations: "outline-color: blue;", order: 1 };
    expect(declaredValue(cascadeWinner([layered, unlayered], "outline-color", focusedHalf())!, "outline-color")).toBe("blue");
  });
});

describe("CRICKET'S FOCUS RING IS THE PLATFORM'S (R3-6: not one pixel)", () => {
  it("resolves to --ps-accent for a pad with no sport palette — cricket, tennis and the eight legacy skins", () => {
    // Mutation-proved: dropping the `[data-sport-theme]` scope from
    // globals.css's `.pad-half:focus-visible` rule reds this with
    // `var(--sport-led)`, which is exactly the defect this file exists for.
    expect(ringOn([PLAIN_ROOT])).toBe("var(--ps-accent)");
  });

  it("and cricket really is a no-palette sport, so the rule above is the one it gets", () => {
    expect(Object.prototype.hasOwnProperty.call(SPORT_PALETTES, "cricket")).toBe(false);
  });

  it("no rule in globals.css touches an unthemed pad half's outline at all", () => {
    // The stronger statement, and the one that survives a future edit: the
    // ONLY outline-color rule that may match a `.pad-half` is one scoped to a
    // themed root. Anything else is a pixel moving on nine signed-off skins.
    const reaching = rules.filter(
      (rule) =>
        declaredValue(rule, "outline-color") !== undefined &&
        rule.selector.includes("pad-half") &&
        !rule.selector.includes("data-sport-theme"),
    );
    expect(reaching.map((rule) => rule.selector), "an unscoped .pad-half outline rule is back").toEqual([]);
  });
});

describe("FOOTBALL keeps its own ring — the identity ruling, without the collateral", () => {
  it("resolves to the sport's own LED inside a themed pad root", () => {
    expect(ringOn([THEMED_ROOT])).toBe("var(--sport-led)");
  });

  it("which can only ever be a sport's OWN value, never the default LED", () => {
    // The invariant that makes this safe for R4-R7 without a CSS edit per
    // sport: the rule fires only under `[data-sport-theme]`, and that
    // attribute is emitted only when a palette override exists — so
    // `--sport-led` inside it is always the overriding sport's own colour.
    expect(Object.keys(SPORT_PALETTES)).toEqual(["football"]);
    expect(SPORT_PALETTES.football!.led).toBe("#ffb703");
  });

  it("the scoped rule outranks the platform ring, or football would silently inherit violet", () => {
    const scoped = rules.filter((rule) => rule.selector.includes("data-sport-theme") && rule.selector.includes("pad-half"));
    expect(scoped, "globals.css declares no themed pad-half focus rule").toHaveLength(1);
    expect(scoped[0]!.layer, "a layered override would lose to the unlayered platform ring").toBeNull();
    expect(specificity(scoped[0]!.selector)[1]).toBeGreaterThan(
      specificity(':where(a, button, summary, [role="tab"]):focus-visible')[1],
    );
  });
});
