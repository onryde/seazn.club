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
import { nameLadder, type OverlayModel, type OverlayMsg } from "@/lib/overlay-model";

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
    { short: "MIL", name: "Milton Keynes Rovers", ladder: nameLadder({ id: "x", name: "Milton Keynes Rovers" }, "MIL"), big: "2", led: false, serving: false },
    { short: "NOR", name: "Northbridge Athletic", ladder: nameLadder({ id: "x", name: "Northbridge Athletic" }, "NOR"), big: "1", led: true, serving: false },
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

  it("the positive/negative pair — no clock means NO trailing cell at all (the brand left the header, 2026-11-17)", () => {
    const tree = walk(OverlayBug({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
    expect(tree.find((el) => classesOf(el).includes("ovl-bug-clock"))).toBeUndefined();
    expect(tree.some((el) => classesOf(el).includes("ovl-bug-brand"))).toBe(false);
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

  it("the brand's rules are GONE from the stylesheet — a rule with no element is dead CSS", () => {
    expect(() => ruleBody(".ovl-bug-brand")).toThrow();
    expect(() => ruleBody(".ovl-brand")).toThrow();
    // …and the helper is not simply throwing for everything: a rule that exists still reads.
    expect(ruleBody(".ovl-bug-clock")).toContain("font-size");
  });

  it("the bug's clock and the BAR's clock agree that a clock is LED — §3/§4 disagreed before", () => {
    expect(ruleBody(".ovl-clock-cell")).toContain("color: var(--sport-led)");
    expect(ruleBody(".ovl-bug-clock")).toContain("color: var(--sport-led)");
    // …and they are NOT the same size: §3's bar clock is 60/700, §4's is 33/700.
    expect(ruleBody(".ovl-clock-cell")).toContain("font-size: 60px");
    expect(ruleBody(".ovl-bug-clock")).not.toContain("font-size: 60px");
  });
});

describe("owner ruling 2026-11-17 — the scorebug carries NO brand word: the corner badge is the one mark", () => {
  // The bar and the bug used to end in `msg("overlay.brand")`. The corner badge (`overlay-brand-badge.tsx`, mounted by
  // the stage on every template) took the brand, so a second mark inside the scorebug would show it twice.
  // `brand-badge.test.tsx` proves the badge mounts; this proves the old cells did not come back.
  const models: readonly (readonly [string, OverlayModel])[] = [
    ["no clock", BASE_MODEL],
    ["with a clock", { ...BASE_MODEL, header: { context: "overlay.header.live", clock: "12:41" } }],
  ];
  it.each([
    ["OverlayBar", OverlayBar],
    ["OverlayBug", OverlayBug],
  ] as const)("%s resolves no brand key and mounts no brand cell, with or without a clock", (_name, Component) => {
    let checked = 0;
    for (const [label, model] of models) {
      const asked: string[] = [];
      const spyMsg: OverlayMsg = (key) => {
        asked.push(key);
        return key;
      };
      const tree = walk(Component({ model, tick: [false, false], msg: spyMsg }));
      expect(asked, label).not.toContain("overlay.brand");
      expect(tree.some((el) => /\bovl-(bug-)?brand\b/.test(classesOf(el))), label).toBe(false);
      expect(tree.some((el) => textOf(el) === "seazn"), label).toBe(false);
      checked++;
    }
    expect(checked).toBe(models.length);
  });

  it.each(["en", "fr", "es", "nl"])("%s: `overlay.brand` is gone from the dictionary — nothing reads it", (locale) => {
    const dict = JSON.parse(readFileSync(join(DICT, locale, "public.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(dict).length).toBeGreaterThan(0);
    expect(dict["overlay.brand"]).toBeUndefined();
  });
});

describe("owner report 2026-11-17 — the bar's trailing score cell never wraps", () => {
  // A tennis bar with a 43-character entrant name put "1 :" over "1": the bar's row is a flex row, every cell shrinks
  // by default, and the LED cell's text broke at its spaces once the names squeezed it. The trailing cells (the LED
  // count, and the clock that takes the same slot) keep their own width; the NAMES are what give way.
  it.each([".ovl-cells-led", ".ovl-clock-cell"])("%s holds its width and stays on one line", (selector) => {
    const body = ruleBody(selector);
    expect(body).toContain("flex: none");
    expect(body).toContain("white-space: nowrap");
  });
});
