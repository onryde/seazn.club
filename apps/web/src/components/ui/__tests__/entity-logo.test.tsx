// `EntityLogo` — the shared badge renderer's contract, and in particular the
// contract of the two things the spectator W2 crest task ADDED to it: an
// entity `colour` and a `size={32}`.
//
// `apps/web` vitest is `environment: "node"`: no DOM, no cascade, no paint.
// So this file pins MARKUP — tags, attribute values, class tokens, literal
// output — and nothing in it claims a pixel. Whether white initials are
// actually legible on a club's navy tile is a post-mount visual/e2e question;
// what is settled here is which colour pair the component CHOSE, and that the
// string it hands to `style` is one a browser will paint at all.
//
// ── PART 1 IS THE POINT OF THE WHOLE FILE ─────────────────────────────────
// The colour arm and the 32 size are additive, and "additive" is a claim about
// callers that pass NEITHER: `standings-table`, `standings-table-view`,
// `results-matrix` and `stats-tab` must render the same bytes afterwards as
// before. So the first block is a characterization test — every arm at every
// pre-existing size, asserted as the LITERAL string. It was written against
// the component as it stood before the change, run green there, and only then
// carried across; it is a golden, not a description of the new code.
//
// Literal strings rather than a class-token scan on purpose. The two things
// most likely to go wrong in a refactor of this shape are invisible to a token
// scan: the order of the class list, and the DOUBLE SPACE that
// `${SIZE_CLASS[size]} ${className}` leaves when `className` is "". Both are
// below, exactly as they render.
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { contrastRatio } from "@/lib/contrast";
import { autoColour, EntityLogo, initials, monogramInk, PendingCrest } from "../entity-logo";

const html = (node: ReactElement) => renderToStaticMarkup(node);

/** The class list common to every arm, before the per-arm tokens. The size
 *  pair and the caller's `className` are interpolated where the component
 *  interpolates them — including the empty-`className` double space. */
const base = (sizeTokens: string, className = "") =>
  `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md align-middle ${sizeTokens} ${className}`;

const SIZE_TOKENS = {
  20: "h-5 w-5 text-[9px]",
  24: "h-6 w-6 text-[10px]",
  32: "h-8 w-8 text-[10px]",
  40: "h-10 w-10 text-sm",
} as const;

describe("EntityLogo — the badge and org arms are byte-identical; the last arm is deliberately not", () => {
  // 20, 24 and 40 only: 32 did not exist before this change, so it has nothing
  // to be identical to and is asserted in its own block below.
  for (const size of [20, 24, 40] as const) {
    it(`size ${size}: badge → <img>; orgName → the violet letter mark; neither → a colour from the NAME`, () => {
      const tokens = SIZE_TOKENS[size];

      // React hoists a `<link rel="preload" as="image">` ahead of every `<img>`
      // in the tree. That is part of what this component emits today, so it is
      // part of the golden rather than sliced away — `stats-teams-info-tabs`
      // learned the same thing the other way round, by having a root-tag regex
      // break on it.
      expect(html(<EntityLogo src="https://x/b.png" name="Blue Blazers" size={size} />)).toBe(
        `<link rel="preload" as="image" href="https://x/b.png"/>` +
          `<img src="https://x/b.png" alt="" aria-hidden="true" class="${base(tokens)} bg-white object-contain"/>`,
      );

      expect(
        html(<EntityLogo src={null} orgName="Riverside" name="Blue Blazers" size={size} />),
      ).toBe(
        `<span aria-hidden="true" class="${base(tokens)} bg-gradient-to-br from-purple-500 to-fuchsia-500 font-bold text-white">R</span>`,
      );

      // The last arm is NO LONGER the grey tile — an entity that declares no
      // colour gets one derived from its name. Pinned through `autoColour`
      // rather than against a hex typed in here, so the palette is the source
      // of truth and a change to it moves this with it.
      const auto = monogramInk(autoColour("Blue Blazers"))!;
      expect(html(<EntityLogo src={null} name="Blue Blazers" size={size} />)).toBe(
        `<span aria-hidden="true" class="${base(tokens)} font-semibold"` +
          ` style="background:${auto.bg};color:${auto.ink}">BB</span>`,
      );
    });
  }

  it("a caller's own className lands between the size tokens and the arm's — `standings-table` passes `mr-2`", () => {
    // The one live caller that passes `className`. Its spacing is the thing
    // that differs from the empty case, so both are pinned: with a className
    // there is ONE space, without it there are two.
    const auto = monogramInk(autoColour("Blue Blazers"))!;
    expect(
      html(<EntityLogo src={null} name="Blue Blazers" size={20} className="mr-2" />),
    ).toBe(
      `<span aria-hidden="true" class="${base(SIZE_TOKENS[20], "mr-2")} font-semibold"` +
        ` style="background:${auto.bg};color:${auto.ink}">BB</span>`,
    );
    expect(html(<EntityLogo src={null} name="Blue Blazers" size={20} />)).toContain(
      `${SIZE_TOKENS[20]}  font-semibold`,
    );
  });

  it("size defaults to 20, and an omitted `colour` is the same render as an explicit null", () => {
    // The default is asserted against the SIZE TOKENS rather than against
    // "some class", because a reachability test is satisfied by any value:
    // what matters is which of the four sizes an omitted prop opens at.
    const omitted = html(<EntityLogo src={null} name="Blue Blazers" />);
    expect(omitted).toContain(SIZE_TOKENS[20]);
    expect(omitted).not.toContain(SIZE_TOKENS[24]);
    expect(omitted).toBe(html(<EntityLogo src={null} name="Blue Blazers" size={20} />));
    expect(omitted).toBe(html(<EntityLogo src={null} name="Blue Blazers" colour={null} />));
    // It DOES carry a style now — the derived colour is painted the same way a
    // declared one is. What matters is that omitting `colour` and passing null
    // are still one render, which the line above pins.
    expect(omitted).toContain("style=");
  });
});

describe("EntityLogo — the colour arm", () => {
  it("colour, no badge → a monogram painted in it, with the ink picked by the WCAG ratio", () => {
    // The two sides of the wheel in one test, because a fixed ink is right for
    // one of them and wrong for the other: white on `#123456` is 12.7:1, white
    // on a club's yellow `#ffdd00` is 1.3:1. A single dark fixture cannot tell
    // a derived ink from a hardcoded white one.
    expect(html(<EntityLogo src={null} name="Rochford Ramblers" colour="#123456" size={32} />)).toBe(
      `<span aria-hidden="true" class="${base(SIZE_TOKENS[32])} font-semibold" style="background:#123456;color:#ffffff">RR</span>`,
    );
    expect(html(<EntityLogo src={null} name="Canvey Canaries" colour="#ffdd00" size={32} />)).toBe(
      `<span aria-hidden="true" class="${base(SIZE_TOKENS[32])} font-semibold" style="background:#ffdd00;color:#0f172a">CC</span>`,
    );
  });

  it("the badge still wins: a club with both a badge and a colour paints nothing", () => {
    const h = html(
      <EntityLogo src="https://x/b.png" name="Blue Blazers" colour="#123456" size={32} />,
    );
    expect(h).toContain(`src="https://x/b.png"`);
    expect(h).not.toContain("style=");
    expect(h).not.toContain(">BB<");
  });

  it("the colour outranks the org letter mark, and a REFUSED colour falls through to it", () => {
    // Two arms of one ladder, asserted as a pair. The order is a decision, not
    // an accident: the colour and the initials beside it both name THIS
    // entity, while the org mark is a stand-in for an entity that offers
    // nothing of its own. No caller passes both today — grepped: not one of
    // the six `EntityLogo` call sites passes `orgName` at all — so this pins a
    // stated rule rather than a live path, and pins it so it cannot be
    // reversed silently.
    const painted = html(
      <EntityLogo src={null} orgName="Riverside" name="Blue Blazers" colour="#123456" size={32} />,
    );
    expect(painted).toContain("background:#123456");
    expect(painted).toContain(">BB<");
    expect(painted).not.toContain("from-purple-500");

    // `rebeccapurple` is a CSS colour the gate refuses (see the gate's own
    // block). Refused means the arm does not exist — not that it paints
    // nothing while still claiming the slot.
    const fellThrough = html(
      <EntityLogo
        src={null}
        orgName="Riverside"
        name="Blue Blazers"
        colour="rebeccapurple"
        size={32}
      />,
    );
    expect(fellThrough).not.toContain("style=");
    expect(fellThrough).toContain("from-purple-500");
    expect(fellThrough).toContain(">R<");
  });

  it("a refused colour with no org name is the neutral tile — the same bytes as no colour at all", () => {
    // The positive pair for every `null` row in the gate table below: refusal
    // must be indistinguishable from absence, because the alternative failure
    // (a `style` attribute the browser drops) is an INVISIBLE tile rather than
    // a grey one.
    const neutral = html(<EntityLogo src={null} name="Blue Blazers" size={32} />);
    for (const bad of ["puce", "", "   ", "#12345", "rgb(1,2,3)", "＃123456"]) {
      expect(html(<EntityLogo src={null} name="Blue Blazers" colour={bad} size={32} />), bad).toBe(
        neutral,
      );
    }
    // The positive pair, without which every row above is satisfied by a
    // component that ignores `colour` altogether — which is exactly the state
    // this task found the field in.
    expect(html(<EntityLogo src={null} name="Blue Blazers" colour="#123456" size={32} />)).not.toBe(
      neutral,
    );
  });

  it("the painted tile is aria-hidden, like every other arm", () => {
    // The entity's NAME sits beside the crest on every surface that renders
    // one, so a crest that announced itself would read the same club twice
    // ("RR Rochford Ramblers"). React serialises a bare `aria-hidden` as
    // `aria-hidden="true"`, so the VALUE is the assertion — a bare
    // `aria-hidden` probe passes in both states.
    //
    // Read off the tag that CARRIES the paint, not off the document: every
    // other arm is `aria-hidden` too, so a document-wide probe is satisfied by
    // a component that never paints at all.
    const h = html(<EntityLogo src={null} name="Rochford Ramblers" colour="#123456" size={32} />);
    const at = h.indexOf("style=");
    expect(at, "the painted arm rendered").toBeGreaterThan(-1);
    const tag = h.slice(h.lastIndexOf("<", at), h.indexOf(">", at) + 1);
    expect(tag).toContain(`aria-hidden="true"`);
    expect(tag).toContain("background:#123456");
  });
});

describe("EntityLogo — size 32", () => {
  it("32 is a real size, and it is not 24 wearing a different name", () => {
    // Task 7's `compact` shipped declared-but-dead: the prop existed, the
    // markup had no branch for it, and the caller got an identical card back
    // with nothing red to say so. A new size owes the differential that would
    // have caught it.
    const at32 = html(<EntityLogo src={null} name="Blue Blazers" size={32} />);
    const at24 = html(<EntityLogo src={null} name="Blue Blazers" size={24} />);
    expect(at32).toContain("h-8 w-8");
    expect(at24).toContain("h-6 w-6");
    expect(at32).not.toBe(at24);
    // 32 and 24 share a text size (`text-[10px]`) and differ only in the box,
    // which is worth saying out loud: the box is the whole of the difference.
    expect(at32.replace("h-8 w-8", "h-6 w-6")).toBe(at24);
  });

  it("all four sizes are distinct boxes", () => {
    const boxes = ([20, 24, 32, 40] as const).map(
      (s) => html(<EntityLogo src={null} name="Blue Blazers" size={s} />).match(/h-\d+ w-\d+/)![0],
    );
    expect(new Set(boxes).size).toBe(4);
  });
});

describe("PendingCrest — the crest of a side with nobody in it yet (Knockout fix round 2, D3)", () => {
  // A waiting bracket slot has no entity to take a colour or initials from, and
  // `EntityLogo`'s last arm derives both from whatever NAME it is handed — so
  // "Winner of R3·2" became a coloured "WR" tile and a waiting pair a "PN" one,
  // each reading as a confirmed entrant. Pinned as the LITERAL string, like
  // every arm above: `EntityLogo`'s own box at every size, then a neutral fill,
  // a muted outline and a "?" in muted ink. No `style`, so no hue can reach it;
  // `aria-hidden`, so it has no accessible name of its own.
  for (const size of [20, 24, 32, 40] as const) {
    it(`size ${size}: the same box as every EntityLogo arm, a neutral '?', aria-hidden, marked data-crest="pending"`, () => {
      expect(html(<PendingCrest size={size} />)).toBe(
        `<span aria-hidden="true" data-crest="pending" class="${base(SIZE_TOKENS[size])} border border-zinc-300 bg-canvas font-semibold text-ink-muted">?</span>`,
      );
    });
  }

  it("size defaults to 20, as EntityLogo's does", () => {
    expect(html(<PendingCrest />)).toBe(html(<PendingCrest size={20} />));
  });
});

describe("monogramInk — the gate between a stored colour and a painted tile", () => {
  // MOVED HERE, whole, from `public-site/__tests__/stats-teams-info-tabs.test.tsx`,
  // where it was written for the Teams tab's private `Crest`. The function
  // moved into this component; its table moved with it, so there is one copy
  // rather than two that drift. The Teams tab's own suite keeps every
  // assertion it makes THROUGH the rendered card, which is a different claim.

  it("refuses anything CSS will not paint, and derives the ink from the ratio for everything it accepts", () => {
    // `entrants.colour` is free text (`TeamCard.colour` is
    // `z.string().nullable()`), and a bad value has two distinct ways to hurt.
    // `lib/contrast.ts`'s `expandHex` THROWS on anything outside its charset —
    // measured: `relativeLuminance("puce")` raises `not a hex colour: puce`,
    // which would take the whole spectator page down — and anything CSS cannot
    // parse paints nothing at all, which is the quieter, worse one.
    expect(monogramInk(null)).toBeNull();
    expect(monogramInk(undefined)).toBeNull();
    expect(monogramInk("puce")).toBeNull();
    expect(monogramInk("")).toBeNull();
    expect(monogramInk("#123456")).toEqual({ bg: "#123456", ink: "#ffffff" });
    expect(monogramInk("#ffdd00")).toEqual({ bg: "#ffdd00", ink: "#0f172a" });
    // Three-digit hex is a colour too (`expandHex` accepts `#abc`).
    expect(monogramInk("#fff")).toEqual({ bg: "#fff", ink: "#0f172a" });
  });

  it("a colour with NO hash is normalised before it reaches `style` — measuring it is not the same as painting it", () => {
    // Task 10 review F1. `contrast.ts:18` is `hex.trim().replace(/^#/, "")` —
    // the hash is OPTIONAL there — so "123456" measures as dark navy and picks
    // white ink, while `style="background:123456"` is a declaration the browser
    // DROPS. The tile paints transparent and the monogram is white initials on
    // the card's white ground: invisible, and invisible only for the entrants
    // whose colour arrived without a hash.
    //
    // Reachable rather than theoretical: `colour` is
    // `team_display_v.colors.home_primary` (`competition-hub.ts`'s
    // `primaryColour`, :335-340) and the v1 API takes club `colors` as an
    // unvalidated `z.record(z.string(), z.string())` on both write paths
    // (`server/api-v1/schemas.ts:3188` `CreateClub`, `:3199` `PatchClub`).
    // Those two pins were `:3169`/`:3180` when Task 10 wrote them and had
    // drifted nineteen lines by the time this moved; re-pinned here.
    expect(monogramInk("123456")).toEqual({ bg: "#123456", ink: "#ffffff" });
    expect(monogramInk("ffdd00")).toEqual({ bg: "#ffdd00", ink: "#0f172a" });
    expect(monogramInk("  #123456  ")).toEqual({ bg: "#123456", ink: "#ffffff" });
    // Still refused: the charset and the length are the gate, the hash is not.
    expect(monogramInk("#12345")).toBeNull();
    expect(monogramInk("1234567")).toBeNull();
    expect(monogramInk("#12345g")).toBeNull();
    expect(monogramInk("rebeccapurple")).toBeNull();
  });

  it("the 26-input table: nothing CSS cannot paint gets through, in either direction", () => {
    // The re-review's own table, executed here rather than quoted. Every row
    // that is not a plain 3- or 6-digit hex must be refused — separators,
    // parens, quotes, a trailing semicolon, an injection shape, and the
    // FULLWIDTH hash `＃`, which looks like the real one and is not in the
    // charset.
    for (const raw of [
      "#12345",
      "#1234567",
      "1234567",
      "rgb(1,2,3)",
      "red",
      "rebeccapurple",
      "",
      "   ",
      "#fff;color:red",
      '#fff");',
      "123456;color:red",
      "#123456;",
      "url(x)",
      "var(--x)",
      "#12 3456",
      "＃123456",
      "puce",
      "#12345g",
    ]) {
      expect(monogramInk(raw), JSON.stringify(raw)).toBeNull();
    }
    // …and the accepted half, hash added, case and whitespace tolerated.
    for (const [raw, bg] of [
      ["abc", "#abc"],
      ["aaa", "#aaa"],
      ["ABCDEF", "#ABCDEF"],
      ["fff\n", "#fff"],
      ["#fff\t", "#fff"],
      ["  #ABC  ", "#ABC"],
    ] as const) {
      expect(monogramInk(raw)?.bg, JSON.stringify(raw)).toBe(bg);
    }
  });

  it("TWO invariants over the whole table at once, not a sample of either", () => {
    // (a) whatever the gate lets through is a string CSS paints. A widened gate
    //     reds here rather than shipping a blank tile.
    // (b) whatever the gate lets through is a string `lib/contrast.ts` MEASURES
    //     without throwing. This is the assertion that replaced round 1's
    //     `try`/`catch`: the catch and the gate's charset clause were covering
    //     for each other and neither was killable (AGENTS.md 3), so the belt is
    //     a test. `contrast.ts` belongs to the overlay wave; the day it narrows
    //     its accepted set, this reds instead of putting a 500 on every public
    //     competition page.
    //
    // The loop must not be vacuous, so the count of rows that actually reached
    // the assertions is pinned as well — a gate that started refusing
    // everything would otherwise satisfy an all-`continue` loop.
    let admitted = 0;
    for (const raw of [
      "#123456", "123456", "  #ffdd00 ", "#fff", "fff", "#FFDD00", "FFF",
      "puce", "", "#12345", "1234567", "#12345g", "rgb(1,2,3)", "rebeccapurple",
    ]) {
      const paint = monogramInk(raw);
      if (!paint) continue;
      admitted++;
      expect(paint.bg, raw).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
      expect(() => contrastRatio(paint.bg, "#ffffff"), raw).not.toThrow();
      expect(["#ffffff", "#0f172a"], raw).toContain(paint.ink);
    }
    expect(admitted).toBe(7);
  });

  it("the ink is the BETTER of the two, measured — not a luminance threshold typed in here", () => {
    // Derived from the formula rather than from a table of expected answers, so
    // a change to `lib/contrast.ts` moves this with it instead of leaving it
    // asserting yesterday's numbers. Both directions: one colour where white
    // wins and one where slate does, and each checked against the ratio.
    for (const raw of ["#123456", "#ffdd00", "#767676", "#fff", "#000"]) {
      const paint = monogramInk(raw)!;
      const light = contrastRatio(paint.bg, "#ffffff");
      const dark = contrastRatio(paint.bg, "#0f172a");
      expect(paint.ink, raw).toBe(light >= dark ? "#ffffff" : "#0f172a");
      expect(Math.max(light, dark), raw).toBeGreaterThan(1);
    }
  });
});

describe("initials", () => {
  // Kept where it always was, in `lib/__tests__/ui-system.test.ts`; the two
  // cases here are the ones the crest arms depend on directly, so the painted
  // tile's CONTENT is asserted somewhere this file can see it.
  it("single word takes two letters, multi-word takes first + last", () => {
    expect(initials("Riverside")).toBe("RI");
    expect(initials("Rochford Ramblers")).toBe("RR");
  });
});

describe("autoColour — a colour from the name, so nothing has to be stored", () => {
  it("is stable for the same name, and insensitive to case and surrounding space", () => {
    // The whole promise: the same entity is the same colour on every page, in
    // every competition, forever. If this is not stable the feature is worse
    // than grey — a tile that changes between two pages is noise.
    // SEVERAL pairs, not one. With a sixteen-entry palette a single pair
    // agrees by luck one time in sixteen — and that is not hypothetical: the
    // one-pair version of this test passed with the normalisation DELETED,
    // because `% 16` reads the low bits where FNV-1a diffuses worst and those
    // two names happened to collide anyway. Six pairs is what makes the
    // assertion witness the thing it names.
    for (const [a, b] of [
      ["Valley FC", "  valley fc  "],
      ["Summit FC", "summit fc"],
      ["Riverside FC", "RIVERSIDE FC"],
      ["Lakeside FC", " lakeside fc"],
      ["Meadow CC", "meadow cc"],
      ["Harbour FC", " HARBOUR FC "],
    ] as const) {
      expect(autoColour(a), `${a} vs ${b}`).toBe(autoColour(b));
    }
    expect(autoColour("Valley FC")).toBe(autoColour("Valley FC"));
  });

  it("separates names that differ", () => {
    // Not a guarantee that ANY two names differ — a fixed palette collides by
    // construction and that is accepted. This pins that the hash is actually
    // reading the name rather than returning a constant, which a "stable"
    // assertion alone would pass on.
    const names = ["Valley FC", "Summit FC", "Riverside FC", "Lakeside FC", "Meadow CC"];
    expect(new Set(names.map(autoColour)).size).toBeGreaterThan(1);
  });

  it("only ever returns a colour `monogramInk` accepts", () => {
    // Every palette entry has to survive the CSS-hex gate AND produce an ink,
    // or the last arm in the chain renders a tile with no background — the
    // invisible-initials failure the gate exists to prevent. Checked across
    // enough names to touch every entry rather than on one sample.
    for (let i = 0; i < 200; i++) {
      const paint = monogramInk(autoColour(`Entity number ${i}`));
      expect(paint, `name ${i}`).not.toBeNull();
      expect(paint!.bg).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("never overrides a colour the entity actually declared", () => {
    // The derived colour is LAST in the chain. An organiser who chose navy
    // gets navy, not a hash of their club's name.
    const declared = html(<EntityLogo src={null} name="Valley FC" colour="#123456" />);
    expect(declared).toContain("background:#123456");
    expect(declared).not.toContain(autoColour("Valley FC"));
  });
});
