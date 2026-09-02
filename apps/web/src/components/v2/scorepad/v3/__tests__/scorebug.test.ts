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
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { whoNames, Scorebug } from "../scorebug";
import { NIGHT_TILE_CLASSES } from "../tokens";
import type { ScorebugHalf, ScorebugSpec, StripItem } from "../types";
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

  // R5 — this expectation USED TO BE "Alice, Serving, Bob", and that string was
  // the defect rather than the contract: with a comma at both levels, a
  // listener gets three flat items and cannot tell that "Serving" belongs to
  // Alice rather than to Bob. The label is folded in with a comma; the LINES
  // are separated with a semicolon, so the two levels stay distinguishable.
  it("separates who-lines with a semicolon, so a folded-in servingLabel stays attached to its own name", () => {
    expect(
      whoNames([
        { name: "Alice", serving: true, servingLabel: "Serving" },
        { name: "Bob" },
      ]),
    ).toBe("Alice, Serving; Bob");
  });

  // The blast-radius claim, pinned rather than asserted in a comment: every
  // half that carries ONE name (cricket's two halves, football's two, and
  // every singles fixture in every sport) joins a single-element array, so no
  // separator of any kind can appear.
  it("leaves a single who-line untouched, whichever separator the multi-line case uses", () => {
    expect(whoNames([{ name: "Alice" }])).toBe("Alice");
    expect(whoNames([{ name: "Alice", serving: true, servingLabel: "Serving" }])).toBe("Alice, Serving");
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

describe("a half that must ASK before it scores (ScorebugHalf.tapSheet)", () => {
  const half = (over: Record<string, unknown>) => ({
    who: [{ name: "Home" }],
    big: "0",
    tappable: true,
    hintKey: "pad.hint",
    tapEvent: { type: "volleyball.rally", payload: { wonBy: "H" } },
    ...over,
  });
  const spec = (over: Record<string, unknown>): ScorebugSpec => ({
    context: "",
    phase: "live",
    halves: [half(over), half({})] as ScorebugSpec["halves"],
    strip: [],
  });
  const firstButton = (s: ScorebugSpec, onTap?: unknown, onOpenSheet?: unknown) =>
    walk(renderIsland(Scorebug, { spec: s, t, onTap, onOpenSheet } as never).tree() as never).find(
      (el) => propsOf(el).onClick !== undefined,
    )!;

  it("opens the sheet INSTEAD of posting, so the question cannot be skipped by tapping", () => {
    const posted: unknown[] = [];
    const opened: string[] = [];
    const btn = firstButton(
      spec({ tapSheet: "serveOpener:home" }),
      (e: unknown) => posted.push(e),
      (k: string) => opened.push(k),
    );
    (propsOf(btn).onClick as () => void)();
    expect(opened[0], "the half must route to its sheet").toBe("serveOpener:home");
    expect(posted, "and must NOT also score — that would ask and answer at once").toHaveLength(0);
  });

  it("posts as before when no sheet is named — every half shipped before this is unchanged", () => {
    const posted: { type?: string }[] = [];
    const opened: string[] = [];
    const btn = firstButton(
      spec({}),
      (e: { type?: string }) => posted.push(e),
      (k: string) => opened.push(k),
    );
    (propsOf(btn).onClick as () => void)();
    expect(posted[0]?.type).toBe("volleyball.rally");
    expect(opened).toHaveLength(0);
  });
});

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

// ---------------------------------------------------------------------------
// R3/F (F3) — THE WHO-LINE MUST BE ABLE TO SHRINK AND BREAK.
//
// Measured, not reasoned about. A throwaway harness (renderToStaticMarkup +
// the real compiled globals.css + Playwright on a `file://` page, the recipe
// this wave already uses) put a 31-character unbroken name in one half at a
// 320px viewport and read the rects back:
//
//   before   football  who-line   left -70  right 237   (viewport 0..320)
//            cricket   who-line   left -75  right 242
//            cricket   serving dot            entirely off-screen at -75..-69
//   after    every element inside the scorebug within 0..320 at every width
//
// The page itself never scrolled horizontally in either state — `Scorebug`'s
// root is `overflow-hidden`, so the defect CLIPS the name at both ends instead
// (the who-line is `justify-center`). That is exactly why the seven-width
// no-horizontal-scroll matrix cannot see this, and why the assertion below is
// on the two properties that let a real browser wrap rather than on a rendered
// pixel: a grid item and a flex item both default to `min-width: auto`, which
// is a floor at the widest word, and an unbroken word has no break opportunity
// without `overflow-wrap`.
//
// CHASSIS-WIDE and CRICKET-VISIBLE: every skin's ScorebugSpec renders through
// this one component.
// ---------------------------------------------------------------------------

const LONG_NAME = "Chukwuemekaadebayoromololuwafemi";

function specWithWho(long: string): ScorebugSpec {
  return {
    context: "ctx",
    phase: "live",
    halves: [
      // A tappable half (cricket's batting half) and a plain one (football's),
      // because they are two DIFFERENT elements in the renderer — a <button>
      // and a <div> — and only one of them was ever looked at before.
      { who: [{ name: long, serving: true, servingLabel: "on strike" }, { name: "A. Khan" }], big: "84-3", tappable: true, hintKey: "pad.cricket.scorebug.batting" },
      { who: [{ name: long }], big: "2-31" },
    ],
    strip: [],
  };
}

/**
 * The class list of the innermost element that ENCLOSES `needle` in `html`.
 *
 * A real parse (a tag stack), not a `lastIndexOf("<span class=")` — the
 * serving dot is a sibling `<span aria-hidden …>` sitting immediately before
 * the name, so a naive backward search finds the wrong element and reports the
 * dot's classes as the name's. `HalfContent` renders through nested function
 * components, which the shared island harness does not expand, so the markup
 * is the only place these two facts are observable at all.
 */
function enclosingClasses(html: string, needle: string): string[] {
  // `>` + needle, never a bare `indexOf` — the tappable half's own aria-label
  // repeats every who-line name, so a bare search lands INSIDE an attribute
  // and reports the <button> as the enclosing element.
  //
  // R3/F review round 2: this returned the FIRST match only, which is the
  // tappable (<button>) half. The plain (<div>) half renders the same name and
  // was never independently checked — today both halves reach the same
  // `HalfContent` span, so there is no live gap, but that shared path is
  // exactly what a later wave might fork. Every occurrence is returned and the
  // caller asserts on all of them.
  const out: string[] = [];
  for (let from = 0; ; ) {
    const found = html.indexOf(">" + needle, from);
    if (found === -1) break;
    const at = found + 1;
    from = at;
    const stack: string[] = [];
    const tag = /<(\/?)([a-z0-9]+)([^>]*?)(\/?)>/g;
    let match: RegExpExecArray | null;
    while ((match = tag.exec(html)) !== null) {
      if (match.index >= at) break;
      if (match[1] === "/") stack.pop();
      else if (match[4] !== "/") stack.push(/class="([^"]*)"/.exec(match[3] ?? "")?.[1] ?? "");
    }
    out.push(stack[stack.length - 1] ?? "");
  }
  expect(out.length, `"${needle}" is not in the rendered markup as a text node`).toBeGreaterThan(0);
  return out;
}

describe("the scorebug who-line with a long unbroken name (R3/F)", () => {
  const html = () => renderToStaticMarkup(Scorebug({ spec: specWithWho(LONG_NAME), t }) as never);

  it("lets each HALF shrink below its content — a grid item's default min-width is the widest word", () => {
    // Selected by `py-3 text-center`, which only the two half cells carry —
    // NOT by the flex utilities this fix itself edits, or the selector would
    // move with the code it is meant to pin.
    const halves = [...html().matchAll(/<(?:button|div)[^>]*\sclass="([^"]*py-3 text-center[^"]*)"/g)];
    // One tappable (<button>) and one plain (<div>).
    expect(halves.length).toBe(2);
    for (const half of halves) {
      expect(half[1], "a half that cannot shrink pushes its column wider than the grid").toContain("min-w-0");
    }
  });

  it("gives the NAME itself a break opportunity — in BOTH halves", () => {
    const all = enclosingClasses(html(), LONG_NAME);
    // The tappable <button> half and the plain <div> half each render the name.
    // Asserting only the first checked one element and read as covering two.
    expect(all.length, "both halves render the long name as a text node").toBe(2);
    for (const cls of all) {
      // `wrap-anywhere` (overflow-wrap: ANYWHERE), never `break-words`
      // (overflow-wrap: break-word). Only `anywhere` reduces the box's
      // MIN-CONTENT contribution — `break-words` left the browser rects
      // byte-identical when this was first "fixed" with it, and only the
      // 320px measurement caught that.
      expect(cls, "an unbroken word never wraps without an overflow-wrap opportunity").toContain("wrap-anywhere");
    }
  });

  it("keeps the name span INLINE, or the two-line clamp above it is inert", () => {
    // R7-28, and the reason that fix shipped dead the first time: an
    // `inline-flex` span is an ATOMIC inline-level box to the `-webkit-box`
    // that `line-clamp-2` establishes, so the clamp counted the whole span as
    // one line and never fired — a 320 capture still showed three lines of
    // name over a one-digit score while every gate stayed green. Plain inline
    // text is what the clamp can count.
    //
    // `min-w-0` is deliberately NOT asserted here any more: it was load-
    // bearing only while this span was a flex ITEM (automatic minimum size).
    // An inline box has no such floor, and the who-block container below
    // still carries it.
    for (const cls of enclosingClasses(html(), LONG_NAME)) {
      expect(cls, "inline-flex makes the clamp atomic, and therefore inert").not.toContain("inline-flex");
    }
  });

  it("caps the who-block at six lines, and lets it shrink", () => {
    // The SCORE is what this surface exists to show. Before the ORIGINAL cap
    // a long entrant name wrapped to three lines above a single digit and
    // outweighed it — that shipped as `line-clamp-2`. Landed at 6 (was 3)
    // once the actual root cause of mobile.spec.ts's doubles-fixture
    // clipping turned out to be that TEST's own over-decorated player
    // names, not this box — see scorebug.tsx's own comment above this
    // element for the full account. Six stays as real margin for whatever
    // length of name a doubles pair legitimately has, not a razor's edge.
    // Selected by the clamp itself, which is the behaviour under test.
    const blocks = [...html().matchAll(/<div[^>]*\sclass="([^"]*line-clamp-6[^"]*)"/g)];
    expect(blocks.length, "both halves cap their who-block").toBe(2);
    for (const block of blocks) {
      expect(block[1], "the who-block must still shrink below its longest word").toContain("min-w-0");
    }
  });
});

// ---------------------------------------------------------------------------
// R3.5/Task D (cases B6, B7) — `ScorebugHalf.sub`, an OPTIONAL second figure
// beside `big` for a decider running alongside the regulation score
// (football's shoot-out tally now; R6's `(GWS 2-1)` for icehockey/hockey
// next, which `period/kernel.ts` already composes with nowhere to put it).
// Rendered through the SAME `HalfContent` every skin's ScorebugSpec shares,
// so these two cases pin the CHASSIS half of the contract — the SPORT half
// (football fills it only during SHOOTOUT) is skins/__tests__/football.test.ts's.
// ---------------------------------------------------------------------------

function renderHalfToString(half: Partial<ScorebugHalf> & Pick<ScorebugHalf, "who" | "big">): string {
  const spec: ScorebugSpec = {
    context: "ctx",
    phase: "live",
    halves: [{ ...half }, { who: [{ name: "Other" }], big: "0" }],
    strip: [],
  };
  return renderToStaticMarkup(Scorebug({ spec, t }) as never);
}

describe("ScorebugHalf.sub — the decider's second figure (R3.5/D)", () => {
  it("B6: a half with no `sub` renders exactly what it rendered before this field existed", () => {
    const html = renderHalfToString({ who: [{ name: "Home" }], big: "1" });
    expect(html).not.toContain("data-half-sub");
  });

  it("B7: a half with `sub` renders it once, beside the big figure", () => {
    const html = renderHalfToString({ who: [{ name: "Home" }], big: "1", sub: "(2)" });
    expect((html.match(/data-half-sub/g) ?? []).length).toBe(1);
    expect(html).toContain("(2)");
  });

  it("renders `sub` on the SUBORDINATE cream token, never the lime the score digits use — equal weight is the confusion this field removes", () => {
    const html = renderHalfToString({ who: [{ name: "Home" }], big: "1", sub: "(2)" });
    const tag = html.slice(html.indexOf("data-half-sub"), html.indexOf(">", html.indexOf("data-half-sub")));
    expect(tag).toContain(NIGHT_TILE_CLASSES.creamText);
    expect(tag).not.toContain(NIGHT_TILE_CLASSES.limeText);
    expect(tag).toContain("tabular-nums");
  });

  it("does not disturb the OTHER half, which has no `sub` of its own", () => {
    const html = renderHalfToString({ who: [{ name: "Home" }], big: "1", sub: "(2)" });
    expect((html.match(/data-half-sub/g) ?? []).length).toBe(1);
  });
});
