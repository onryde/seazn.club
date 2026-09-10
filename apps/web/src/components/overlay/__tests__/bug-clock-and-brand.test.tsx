// Fix round 5 — I3 (`_THEMES.md` §4's bug clock is Barlow 33/700 LED, not the
// brand's 24/600 .08em) and I5's wiring half (`overlay.brand` was declared in
// all four locales with no reader, while three components hardcoded `seazn`).
//
// `apps/web` vitest is `environment: "node"`, so this cannot see the cascade or
// the rendered glyphs. It proves the two halves a node test CAN own: which
// CLASS the renderer puts on the clock, and what that class DECLARES in
// `globals.css`. The paint itself is the browser pass's to sign off.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../../../app/globals.css"), "utf8");
const DICT = join(HERE, "../../../dictionaries");

/** Returns the key itself, so a component that hardcodes English shows up as
 *  prose among keys — the same posture `overlay-model.test.ts` takes. */
const keyMsg: OverlayMsg = (key) => key;

const BASE_MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live" },
  sides: [
    { short: "MIL", name: "Milton Keynes Rovers", big: "2", led: false, serving: false },
    { short: "NOR", name: "Northbridge Athletic", big: "1", led: true, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: [],
};

const classesOf = (el: ReturnType<typeof walk>[number]): string =>
  (propsOf(el).className as string | undefined) ?? "";

/** The body of one CSS rule in `globals.css`, by exact selector. Throws rather
 *  than returning "" for a missing selector: an absent rule must red this
 *  test, not silently satisfy every "does not contain" assertion below. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`globals.css declares no \`${selector}\` rule`);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  if (close < 0) throw new Error(`\`${selector}\` rule is unterminated`);
  return CSS.slice(open + 1, close);
}

describe("I3 — the bug's clock is its OWN type token, not the brand's", () => {
  const withClock: OverlayModel = {
    ...BASE_MODEL,
    header: { context: "overlay.header.live", clock: "12:41" },
  };

  it("renders the clock through .ovl-bug-clock, never .ovl-bug-brand", () => {
    const tree = walk(OverlayBug({ model: withClock, tick: [false, false], msg: keyMsg }));
    const clock = tree.find((el) => classesOf(el).includes("ovl-bug-clock"));
    expect(clock, "the clock cell must carry its own class").toBeDefined();
    expect(textOf(clock!)).toBe("12:41");
    expect(classesOf(clock!), "Barlow still — §4's clock is a display face").toBe(
      "ovl-bug-clock ovl-display",
    );
    for (const el of tree) {
      expect(classesOf(el), "the clock must not reuse the brand's token").not.toContain(
        "ovl-bug-brand",
      );
    }
  });

  it("the colour moved onto the class — no inline style survives on the clock cell", () => {
    // The shipped code carried `style={{ color: "var(--sport-led)" }}` because
    // it was borrowing `.ovl-bug-brand`. With its own rule the inline override
    // is the smell that the borrowing is back.
    const tree = walk(OverlayBug({ model: withClock, tick: [false, false], msg: keyMsg }));
    const clock = tree.find((el) => classesOf(el).includes("ovl-bug-clock"))!;
    expect(propsOf(clock).style, "§4's LED colour belongs in the class").toBeUndefined();
  });

  it("the positive/negative pair — no clock means the BRAND cell, still on .ovl-bug-brand", () => {
    const tree = walk(OverlayBug({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
    expect(tree.find((el) => classesOf(el).includes("ovl-bug-clock"))).toBeUndefined();
    const brand = tree.find((el) => classesOf(el) === "ovl-bug-brand ovl-display");
    expect(brand, "the header still ends in the brand when there is no clock").toBeDefined();
  });

  it("globals.css declares .ovl-bug-clock at §4's own values: 33px / 700 / LED, no tracking", () => {
    const body = ruleBody(".ovl-bug-clock");
    expect(body, "_THEMES.md:360 — clock Barlow 33/700").toContain("font-size: 33px");
    expect(body).toContain("font-weight: 700");
    expect(body, "LED, the same colour §3's .ovl-clock-cell uses").toContain(
      "color: var(--sport-led)",
    );
    expect(
      body,
      "the brand's .08em tracking is what made this wrong on tabular digits",
    ).not.toContain("letter-spacing");
  });

  it("the brand's own rule is UNCHANGED — the fix is a new token, not a widening", () => {
    const body = ruleBody(".ovl-bug-brand");
    expect(body, "_THEMES.md:360 — brand Barlow 24/600 .08em").toContain("font-size: 24px");
    expect(body).toContain("font-weight: 600");
    expect(body).toContain("letter-spacing: 0.08em");
  });

  it("the bug's clock and the BAR's clock agree that a clock is LED — §3/§4 disagreed before", () => {
    expect(ruleBody(".ovl-clock-cell")).toContain("color: var(--sport-led)");
    expect(ruleBody(".ovl-bug-clock")).toContain("color: var(--sport-led)");
    // …and they are NOT the same size: §3's bar clock is 60/700, §4's is 33/700.
    expect(ruleBody(".ovl-clock-cell")).toContain("font-size: 60px");
    expect(ruleBody(".ovl-bug-clock")).not.toContain("font-size: 60px");
  });
});

describe("I5 — `overlay.brand` is RESOLVED, not hardcoded, in the bar and the bug", () => {
  // A key-existence test passes in both the orphaned and the wired state (the
  // five `overlay.slate.*` keys shipped that way). What separates them is a
  // resolver that returns something OTHER than the English word: with `keyMsg`
  // a hardcoded `seazn` renders `seazn` and this reds.
  it.each([
    ["OverlayBar", OverlayBar, "ovl-brand ovl-display"],
    ["OverlayBug", OverlayBug, "ovl-bug-brand ovl-display"],
  ] as const)("%s renders msg(\"overlay.brand\"), not the literal", (_name, Component, cls) => {
    const tree = walk(Component({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
    const brand = tree.find((el) => classesOf(el) === cls);
    expect(brand, "the brand cell must mount").toBeDefined();
    expect(textOf(brand!), "resolved through the dictionary channel").toBe("overlay.brand");
    expect(textOf(brand!), "a hardcoded literal is exactly what this catches").not.toBe("seazn");
  });

  it.each(["en", "fr", "es", "nl"])(
    "%s/public.json's own `overlay.brand` is what a real dictionary renders",
    (locale) => {
      const dict = JSON.parse(
        readFileSync(join(DICT, locale, "public.json"), "utf8"),
      ) as Record<string, string>;
      const realMsg: OverlayMsg = (key) => dict[key] ?? key;
      const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false], msg: realMsg }));
      const brand = tree.find((el) => classesOf(el) === "ovl-brand ovl-display");
      expect(textOf(brand!), "the brand mark is the same word in every locale").toBe("seazn");
      // …and the key really is present, so the render above is not `?? key`.
      expect(typeof dict["overlay.brand"]).toBe("string");
    },
  );
});
