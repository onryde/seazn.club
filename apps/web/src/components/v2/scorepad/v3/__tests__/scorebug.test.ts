// Task 5 fix round 2 (review, Important): whoNames must render a caller-
// supplied WhoLine.servingLabel verbatim, and must NEVER resolve a
// sport-namespaced i18n key itself — that was the defect (reusing
// scorepad.skin.tennis.header.serving inside the shared chassis, a
// primitive every sport's ScorebugSpec renders through; racquet sports
// keep their OWN separate scorepad.skin.racquet.header.serving key
// precisely because one sport's key must not serve another).
//
// Tests whoNames as a plain function — no DOM/render involved, matching
// this repo's apps/web vitest environment:"node" (no jsdom); scorebug.tsx
// itself stays untested by a DOM harness per the original task-5-brief.
import { describe, it, expect } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { whoNames, Scorebug } from "../scorebug";
import { NIGHT_TILE_CLASSES } from "../tokens";
import type { ScorebugSpec, StripItem } from "../types";
import type { MsgFn } from "../ribbon";

describe("whoNames", () => {
  it("folds a servingLabel into the name when serving is true and a label is supplied", () => {
    expect(whoNames([{ name: "Alice", serving: true, servingLabel: "Serving" }])).toBe(
      "Alice, Serving",
    );
  });

  it("renders the bare name when serving is true but NO servingLabel is supplied — no fabricated English", () => {
    // Explicit, stated behaviour (controller's requirement): the chassis
    // never invents copy. Until the skin that built this WhoLine supplies
    // servingLabel, the "serving" fact simply does not reach this string —
    // the visible dot (scorebug.tsx's HalfContent) still marks it visually,
    // but no English (or any-language) fallback word is synthesised here.
    expect(whoNames([{ name: "Alice", serving: true }])).toBe("Alice");
  });

  it("renders the bare name when not serving, even if servingLabel is (oddly) present", () => {
    expect(whoNames([{ name: "Alice", servingLabel: "Serving" }])).toBe("Alice");
  });

  it("joins multiple who-lines with a comma, independent per entry", () => {
    expect(
      whoNames([
        { name: "Alice", serving: true, servingLabel: "Serving" },
        { name: "Bob" },
      ]),
    ).toBe("Alice, Serving, Bob");
  });
});

// ---------------------------------------------------------------------------
// B4 (owner ruling R3-6): the strip's LED-panel branch — football's signature,
// the fourth official's added-time board. The SKIN only sets `tone: "led"`
// (skins/__tests__/football.test.ts pins that); this is what the chassis
// actually renders for it, and the one thing football's own suite cannot see.
//
// `Scorebug` holds no state, so it is rendered through the shared island
// harness the same way context-swap.test.ts renders ContextStrip — this file's
// original "no DOM harness" note was true of R1's task-5 scope only, and the
// branch below is unreachable any other way.
// ---------------------------------------------------------------------------

const t: MsgFn = (key) => key;

function specWithStrip(strip: readonly StripItem[]): ScorebugSpec {
  return {
    context: "ctx",
    phase: "live",
    halves: [
      { who: [{ name: "Home" }], big: "1" },
      { who: [{ name: "Away" }], big: "0" },
    ],
    strip: [...strip],
  };
}

const stripSpans = (spec: ScorebugSpec) =>
  walk(renderIsland(Scorebug, { spec, t }).tree() as never).filter(
    (el) => propsOf(el)["data-strip-item-id"] !== undefined,
  );

describe("the strip's LED board (StripItem.tone)", () => {
  it("renders a toned item as the LED panel, with a stable tone hook and its label split from its value", () => {
    const [panel] = stripSpans(specWithStrip([{ id: "added", label: "Added", value: "+3", tone: "led" }]));
    const props = propsOf(panel!);
    expect(props.className).toContain(NIGHT_TILE_CLASSES.ledPanel);
    expect(props["data-strip-tone"]).toBe("led");
    // Label and value are separate elements, not the concatenated string the
    // plain branch builds: the board's hierarchy IS the treatment.
    const label = walk(panel!).find((el) => propsOf(el).className === NIGHT_TILE_CLASSES.ledPanelLabel);
    expect(propsOf(label!).children).toBe("Added");
  });

  it("keeps an UNTONED item byte-for-byte on the pre-B4 branch — this is the cricket-is-unchanged guarantee, rendered", () => {
    const [accent, muted] = stripSpans(
      specWithStrip([
        { id: "target", label: "Target", value: "120", accent: true },
        { id: "rr", label: "RR", value: "14.4" },
      ]),
    );
    for (const el of [accent!, muted!]) {
      expect(propsOf(el).className).not.toContain(NIGHT_TILE_CLASSES.ledPanel);
      expect(propsOf(el)["data-strip-tone"]).toBeUndefined();
      expect(propsOf(el).style).toMatchObject({ fontVariantNumeric: "tabular-nums" });
    }
    expect(propsOf(accent!).className).toContain(NIGHT_TILE_CLASSES.creamText);
    expect(propsOf(muted!).className).toContain(NIGHT_TILE_CLASSES.creamTextMuted);
  });

  it("a toned item with NO label lights only its value — an omitted field must not print an empty caption", () => {
    const [panel] = stripSpans(specWithStrip([{ id: "added", value: "+3", tone: "led" }]));
    expect(walk(panel!).some((el) => propsOf(el).className === NIGHT_TILE_CLASSES.ledPanelLabel)).toBe(false);
    expect(propsOf(panel!).className).toContain(NIGHT_TILE_CLASSES.ledPanel);
  });
});
