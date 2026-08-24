// R3/task B4 — the per-sport VISUAL IDENTITY layer (`_INDEX.md` ruling R3-6,
// 2026-08-24, which REVERSES the 2026-08-15 theme lock). This file's one
// non-negotiable job is the ruling's own escape clause:
//
//   "build the token layer so that cricket's current values ARE the default
//    token set. Cricket then renders byte-identical, its R2/R2b/R2c sign-offs
//    stand, and only football overrides. Any implementation that changes a
//    cricket pixel is wrong."
//
// So the assertions below are not "the palette looks right" — they are
// "cricket's rendered colour is provably the same colour it was before the
// token layer existed". Three independent locks, because each catches a
// different way of breaking it:
//
//   1. DATA        — cricket declares no override, and no sport hex can
//                    reach a skin file at all (source guard).
//   2. RESOLUTION  — `resolveSportPalette("cricket")` is the default set, and
//                    the default set equals PRE_R3_RENDERED_HEX (an
//                    independently-sourced table of what the pre-B4 build
//                    actually painted).
//   3. RENDER      — the real <Scorebug> component, rendered through every
//                    colour branch it owns, emits exactly the token classes
//                    that resolve to PRE_R3_RENDERED_HEX and emits no
//                    `--sport-*` property of its own.
//
// PRE_R3_RENDERED_HEX is deliberately NOT derived from ../sport-theme — that
// would make this whole file agree with itself no matter what the token layer
// said. It is sourced the same way contrast.test.ts's TAILWIND_UTILITY_HEX is:
// from globals.css's own `--mk-*` block and Tailwind's shipped palette. See
// its own comment for the one entry that needed real work (lime-400).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_SPORT_PALETTE,
  SPORT_PALETTES,
  SPORT_TOKENS,
  SPORT_TONES,
  resolveSportPalette,
  sportThemeStyle,
} from "../sport-theme";
import { NIGHT_TILE_CLASSES } from "../tokens";
import { Scorebug } from "../scorebug";
import type { ScorebugSpec } from "../types";
import type { MsgFn } from "../ribbon";

const t: MsgFn = (key) => key;

// ---------------------------------------------------------------------------
// What the PRE-B4 build actually painted, per token, sourced independently of
// ../sport-theme (see this file's header for why that matters).
//
//   board / board-2 / ink  — globals.css:487-489 `--mk-night` / `--mk-night-2`
//     / `--mk-cream`. `bg-night` etc. compile to `var(--mk-night)` verbatim
//     (Tailwind v4 `@theme inline`, globals.css:51-55), so these three are
//     exact by construction.
//
//   led — Tailwind's own `lime-400`, which `text-lime-400`/`bg-lime-400`/
//     `border-lime-400`/`outline-lime-400` compile to as
//     `var(--color-lime-400)`. Under Tailwind v4 (4.3.1 here) that theme
//     entry is `oklch(84.1% 0.238 128.85)` (node_modules/tailwindcss/
//     theme.css:62) — NOT the `#a3e635` v3 shipped and NOT `--mk-lime`.
//     `#9ae600` is that oklch value taken to sRGB; the CSS Color 4 §13.2
//     gamut map (chroma reduction, deltaE-OK <= 0.02) and a naive clip agree
//     on it to the byte, so the mapping method cannot be the wrong answer
//     here. This is what forces the token layer's default LED to be
//     `var(--color-lime-400)` rather than `var(--mk-lime)`: aliasing the
//     product's `--mk-lime` would have shifted cricket's score digits from
//     #9ae600 to #a3e635 — a real, if small, pixel change on a signed-off
//     surface. globals.css:52's "tailwind's lime-400 IS --mk-lime (#a3e635)"
//     is a v3-era comment and is now false; corrected in place by this task.
//
//   caution / dismissal — no pre-B4 value exists (nothing rendered a card
//     colour), so these two are NEW defaults, not preserved ones: the app's
//     existing daylight signal pair, stated as literal hex in globals.css so
//     they cannot drift with a Tailwind palette revision the way `lime-400`
//     just did.
const PRE_R3_RENDERED_HEX = {
  board: "#150b36",
  "board-2": "#1d1145",
  ink: "#f5f0e8",
  led: "#9ae600",
  caution: "#d97706",
  dismissal: "#dc2626",
} as const;

describe("the token vocabulary is CLOSED and small (skins pick from it, never supply raw values)", () => {
  it("is exactly the six tokens this wave's minimum vocabulary names", () => {
    expect([...SPORT_TOKENS]).toEqual(["board", "board-2", "ink", "led", "caution", "dismissal"]);
  });

  it("the card-code tones are a SUBSET of the tokens, not a second vocabulary", () => {
    expect([...SPORT_TONES]).toEqual(["caution", "dismissal"]);
    for (const tone of SPORT_TONES) expect(SPORT_TOKENS).toContain(tone);
  });

  it("every per-sport override declares only tokens from the closed set", () => {
    for (const [sport, palette] of Object.entries(SPORT_PALETTES)) {
      for (const token of Object.keys(palette)) {
        expect(SPORT_TOKENS, `${sport} declares unknown token "${token}"`).toContain(token);
      }
    }
  });

  it("the chassis owns the values — every override is a literal 6-digit hex, resolved here and nowhere else", () => {
    for (const palette of Object.values(SPORT_PALETTES)) {
      for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("no SKIN file carries a colour of its own — the whole point of a token layer", () => {
    // Mutation-proved: pasting `#0b1f16` into skins/football.tsx reds this.
    // Comments stripped first so prose naming a hex can never false-positive.
    for (const skin of ["football.tsx", "cricket.tsx"]) {
      const src = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3/skins", skin), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(/#[0-9a-fA-F]{3,8}\b/.test(src), `${skin} carries a raw colour literal`).toBe(false);
    }
  });
});

describe("CRICKET IS UNCHANGED — lock 1: data", () => {
  it("declares no override at all, so it can only ever inherit the defaults", () => {
    expect(Object.prototype.hasOwnProperty.call(SPORT_PALETTES, "cricket")).toBe(false);
  });

  it("gets NO style attribute on the pad root — nothing can shadow the :root defaults", () => {
    // `undefined`, not `{}`: React renders an empty style object as a real
    // `style=""` attribute, which would change cricket's own root markup.
    expect(sportThemeStyle("cricket")).toBeUndefined();
    expect(sportThemeStyle("tennis")).toBeUndefined();
  });

  it("opts into neither of the new spec fields (StripItem.tone / option tone)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/v2/scorepad/v3/skins/cricket.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(/\btone\s*:/.test(src)).toBe(false);
  });
});

describe("CRICKET IS UNCHANGED — lock 2: resolution", () => {
  it("resolves to the default palette, token for token", () => {
    expect(resolveSportPalette("cricket")).toEqual(DEFAULT_SPORT_PALETTE);
  });

  it("and the default palette IS what the pre-B4 build painted", () => {
    expect(DEFAULT_SPORT_PALETTE).toEqual(PRE_R3_RENDERED_HEX);
  });

  it("an unknown skin key resolves to the defaults too, never to a partial palette", () => {
    const resolved = resolveSportPalette("no-such-sport");
    expect(resolved).toEqual(DEFAULT_SPORT_PALETTE);
    for (const token of SPORT_TOKENS) expect(resolved[token]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// The class -> resolved-hex table for globals.css's `.pad-*` rules with NO
// `--sport-*` override in scope. Independently sourced from those rules'
// fallback chain, exactly as TAILWIND_UTILITY_HEX is sourced from the
// `@theme inline` block — deriving it from DEFAULT_SPORT_PALETTE would make
// the render lock below circular.
const PAD_CLASS_HEX: Record<string, string> = {
  "pad-board": "#150b36",
  "pad-board-2": "#1d1145",
  "pad-ink": "#f5f0e8",
  "pad-ink-70": "#f5f0e8",
  "pad-ink-80": "#f5f0e8",
  "pad-led": "#9ae600",
  "pad-led-dot": "#9ae600",
  "pad-led-edge": "#9ae600",
};

/** Every branch of Scorebug that paints anything: a tappable half (hint text
 *  + serving dot), a plain half, the context band, an accented strip item and
 *  a muted one. Deliberately NOT cricket's own spec — the thing under test is
 *  the CHASSIS renderer, which is what task B4 edits; cricket's spec is data
 *  this task never touches, locked separately above. */
const FULL_BRANCH_SPEC: ScorebugSpec = {
  context: "T20 · Over 0.5",
  phase: "live",
  halves: [
    {
      who: [{ name: "Batting", serving: true, servingLabel: "on strike" }],
      big: "7/0",
      tappable: true,
      hintKey: "pad.hint",
      tapEvent: { type: "x", payload: {} },
    },
    { who: [{ name: "Bowling" }], big: "0" },
  ],
  strip: [
    { id: "rr", label: "RR", value: "14.4" },
    { id: "target", label: "Target", value: "120", accent: true },
  ],
};

describe("CRICKET IS UNCHANGED — lock 3: render", () => {
  const html = renderToStaticMarkup(Scorebug({ spec: FULL_BRANCH_SPEC, t }) as never);

  it("emits no --sport-* property of its own — the board reads them off :root, so cricket inherits", () => {
    expect(html).not.toContain("--sport-");
  });

  it("paints only through classes whose no-override value is the pre-B4 colour", () => {
    // Mutation-proved: swapping NIGHT_TILE_CLASSES.tileBg to "pad-board-2"
    // reds this (the tile ground would resolve to #1d1145, not #150b36).
    const painted = [
      [NIGHT_TILE_CLASSES.tileBg, "board"],
      [NIGHT_TILE_CLASSES.bandBg, "board-2"],
      [NIGHT_TILE_CLASSES.creamText, "ink"],
      [NIGHT_TILE_CLASSES.creamTextMuted, "ink"],
      [NIGHT_TILE_CLASSES.creamTextSubtle, "ink"],
      [NIGHT_TILE_CLASSES.limeText, "led"],
      [NIGHT_TILE_CLASSES.ledDot, "led"],
      [NIGHT_TILE_CLASSES.ledEdge, "led"],
    ] as const;
    for (const [cls, token] of painted) {
      expect(html, `Scorebug never renders ${cls}`).toContain(cls);
      expect(PAD_CLASS_HEX[cls], `no PAD_CLASS_HEX entry for ${cls}`).toBe(PRE_R3_RENDERED_HEX[token]);
    }
  });

  it("carries no bare colour literal that would bypass the token layer entirely", () => {
    for (const bare of ["bg-night", "text-cream", "lime-400", "#150b36", "#a3e635"]) {
      expect(html, `Scorebug still renders the pre-token literal ${bare}`).not.toContain(bare);
    }
  });
});

describe("FOOTBALL is the only sport that overrides, and its values are the ones R3-6 recorded", () => {
  it("declares exactly the six recorded hexes", () => {
    expect(SPORT_PALETTES.football).toEqual({
      board: "#0b1f16",
      "board-2": "#122e21",
      ink: "#f2f7f4",
      led: "#ffb703",
      caution: "#ffd60a",
      dismissal: "#d00000",
    });
  });

  it("every override actually DIFFERS from the default it replaces — an inert override is a silent no-op", () => {
    const football = resolveSportPalette("football");
    for (const token of SPORT_TOKENS) {
      expect(football[token], `football's ${token} is a copy of the default`).not.toBe(DEFAULT_SPORT_PALETTE[token]);
    }
  });

  it("emits every token as a real --sport-* custom property on the pad root", () => {
    const style = sportThemeStyle("football");
    expect(style).toBeDefined();
    const entries = style as unknown as Record<string, string>;
    expect(Object.keys(entries).sort()).toEqual(SPORT_TOKENS.map((tk) => `--sport-${tk}`).sort());
    for (const token of SPORT_TOKENS) {
      expect(entries[`--sport-${token}`]).toBe(resolveSportPalette("football")[token]);
    }
  });

  it("the board is floodlit turf, NOT the family's night violet and NOT pitch green", () => {
    // The calibration `_INDEX.md` argues for, kept as an executable claim so a
    // later "tidy-up" cannot quietly slide football back onto the shared theme
    // (which is the exact outcome R3-6 exists to prevent).
    expect(SPORT_PALETTES.football!.board).not.toBe(DEFAULT_SPORT_PALETTE.board);
    expect(SPORT_PALETTES.football!.led).not.toBe(DEFAULT_SPORT_PALETTE.led);
  });
});

// A seam left for later ships INERT: `sportThemeStyle` could be perfect, its
// own tests green, and football still render in the family's violet because
// nothing ever put the properties on an element. `PadHostV3`'s JSX has no unit
// harness at all (pad-host.test.ts's own note: "PadHostV3's JSX itself has no
// test here") — it needs a live pipeline — so this is a SOURCE guard, the same
// technique contrast.test.ts already uses on scorebug.tsx. Mutation-proved:
// deleting the `style=` prop from the pad root reds the second case.
describe("the token layer is actually WIRED, not merely defined", () => {
  const host = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3/pad-host.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("pad-host imports the resolver rather than reimplementing a palette", () => {
    expect(host).toContain('import { sportThemeStyle } from "./sport-theme"');
  });

  it("applies it to the pad ROOT, off the mounted skin's own key — one place, every descendant", () => {
    // Custom properties inherit, so the root is the only element that needs
    // them: scorebug, tiles, sheets, dock and swap all resolve the sport's
    // palette without any of them knowing which sport is mounted.
    expect(host).toMatch(/data-role="pad-v3"[^>]*style=\{sportThemeStyle\(props\.skin\.key\)\}/);
  });

  it("and nothing else in the chassis emits a --sport-* property of its own", () => {
    for (const file of ["scorebug.tsx", "tile-grid.tsx", "guided-sheet.tsx", "skins/football.tsx"]) {
      const src = readFileSync(join(process.cwd(), "src/components/v2/scorepad/v3", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, `${file} sets a --sport-* property outside the pad root`).not.toContain("--sport-");
    }
  });
});

describe("globals.css is the token AUTHORITY — the JS table only mirrors it", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("declares every token in :root, so a pad rendered outside a themed root still has a value", () => {
    for (const token of SPORT_TOKENS) {
      expect(css, `globals.css declares no --sport-${token}`).toContain(`--sport-${token}:`);
    }
  });

  it("defaults board/board-2/ink to the product's own --mk-* vars, not to copied hexes", () => {
    // An aliased default moves WITH the product theme; a copied hex would
    // silently fork cricket off it the next time --mk-night changes.
    expect(css).toContain("--sport-board: var(--mk-night);");
    expect(css).toContain("--sport-board-2: var(--mk-night-2);");
    expect(css).toContain("--sport-ink: var(--mk-cream);");
  });

  it("defaults the LED to Tailwind's own lime-400 var — the exact thing text-lime-400 resolved to", () => {
    expect(css).toContain("--sport-led: var(--color-lime-400");
  });

  it("defines a rule for every .pad-* class the chassis renders", () => {
    for (const cls of Object.values(NIGHT_TILE_CLASSES)) {
      const base = cls.split(":")[0];
      if (!base.startsWith("pad-")) continue;
      expect(css, `globals.css has no rule for .${base}`).toContain(`.${base}`);
    }
  });
});
