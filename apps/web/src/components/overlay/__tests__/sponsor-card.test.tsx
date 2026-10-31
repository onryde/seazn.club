// R4 sponsors on stream, S7 — the sponsor card's face and the scene carousel's timer (spec 2026-10-27 §3.4, §3.5;
// owner ruling R7: the card prints `seazn.club/s/<code>` from the card's short code, and nothing link-like without one).
//
// Where the expected values come from: the short-code alphabet and pattern (`lib/sponsor-short-code.ts`, the one
// authority the V483 CHECK mirrors), the showing length `SCENE_CAROUSEL_MS` (spec §3.4), the line forms (spec §3.6),
// and Review Focus 5 for the truncation chain (`min-width: 0` on every flex ancestor of the name).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { declaredValue, parseCss, readGlobalsCss } from "@/components/v2/scorepad/v3/__tests__/_globals-css";
import { SCENE_CAROUSEL_MS, type SponsorCard } from "@/lib/sponsor-plan";
import { SPONSOR_SHORT_CODE_ALPHABET, SPONSOR_SHORT_CODE_MAX_LENGTH } from "@/lib/sponsor-short-code";
import { OVERLAY_TEMPLATES } from "../template-registry";
import { SponsorCardView, SponsorCarousel, carouselMemoryStore, carouselMomentId } from "../sponsor-card";
import { GALLERY_SPONSOR_CARDS, GALLERY_SPONSOR_WITNESS_ID } from "../gallery-matrix";
import { openFace, textWidth } from "@/components/public-site/__tests__/font-advance";
import { CreateSponsor } from "@/server/api-v1/schemas";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME_43 = "Northbridge Athletic Football & Social Club";
const card = (over: Partial<SponsorCard> = {}): SponsorCard => ({
  id: "card-a",
  sponsorId: "sponsor-a",
  name: NAME_43,
  logoUrl: null,
  tier: "title",
  onStream: true,
  ...over,
});

describe("SponsorCardView — the face", () => {
  it("premise: the sample name is the brief's 43 characters", () => {
    expect(NAME_43).toHaveLength(43);
  });

  it("the name, whole in the markup (the stylesheet ellipsises it, never the string)", () => {
    const html = renderToStaticMarkup(<SponsorCardView card={card()} style="lower_third" phase="hold" />);
    expect(html).toContain(`>${NAME_43.replace("&", "&amp;")}<`);
    expect(html).toContain('data-testid="ovl-sponsor-card"');
    expect(html).toContain('data-style="lower_third"');
    expect(html).toContain('data-phase="hold"');
  });

  it("R7: a valid short code prints seazn.club/s/<code>", () => {
    const code = SPONSOR_SHORT_CODE_ALPHABET.slice(0, 4);
    const html = renderToStaticMarkup(<SponsorCardView card={card({ shortCode: code })} style="banner" phase="hold" />);
    expect(html).toContain(`>seazn.club/s/${code}<`);
    expect(html).toContain('data-testid="ovl-sponsor-link"');
  });

  it("R7: no short code — nothing link-like at all (no /s/, no link element)", () => {
    const html = renderToStaticMarkup(<SponsorCardView card={card()} style="lower_third" phase="hold" />);
    expect(html).not.toContain("/s/");
    expect(html).not.toContain("ovl-sponsor-link");
  });

  it("R7: a code outside the pattern is not printed (a viewer would type a dead link)", () => {
    const bad = [
      "nb7k", // lowercase
      "NB0K", // 0 is not in the alphabet (misread for O)
      "AB", // too short
      "A".repeat(SPONSOR_SHORT_CODE_MAX_LENGTH + 1), // too long
      "11111111-2222-3333-4444-555555555555", // a sponsor uuid
      "",
    ];
    for (const shortCode of bad) {
      const html = renderToStaticMarkup(<SponsorCardView card={card({ shortCode })} style="lower_third" phase="hold" />);
      expect(html, JSON.stringify(shortCode)).not.toContain("/s/");
    }
  });

  it("a logo: an <img> with an empty alt (the name beside it says it); no logo: the name's first letter, never a broken image", () => {
    const withLogo = renderToStaticMarkup(
      <SponsorCardView card={card({ logoUrl: "https://cdn.example.com/logo.png" })} style="lower_third" phase="hold" />,
    );
    expect(withLogo).toMatch(/<img[^>]*src="https:\/\/cdn\.example\.com\/logo\.png"/);
    expect(withLogo).toMatch(/<img[^>]*alt=""/);
    expect(withLogo).not.toContain("ovl-sponsor-mono");
    const without = renderToStaticMarkup(<SponsorCardView card={card()} style="lower_third" phase="hold" />);
    expect(without).not.toContain("<img");
    expect(without).toContain('class="ovl-sponsor-mono" aria-hidden="true">N<');
    const accented = renderToStaticMarkup(<SponsorCardView card={card({ name: "  ébène" })} style="banner" phase="hold" />);
    expect(accented, "the first letter of the trimmed name, upper-cased").toContain(">É<");
  });

  it("every phase reaches the DOM (the fold classes key on it)", () => {
    for (const phase of ["in", "hold", "out"] as const) {
      expect(renderToStaticMarkup(<SponsorCardView card={card()} style="banner" phase={phase} />)).toContain(`data-phase="${phase}"`);
    }
  });
});

describe("the stylesheet: truncation chain and the 43-character name (Review Focus 5)", () => {
  const RULES = parseCss(readGlobalsCss());
  const value = (selector: string, prop: string) => {
    const found = RULES.filter((r) => r.selector === selector).map((r) => declaredValue(r, prop)).filter((v) => v !== undefined);
    return found.at(-1);
  };
  /** A declaration the budget tests NEED: refused by name when the reader cannot see it, never read as 0. */
  const need = (selector: string, prop: string): string => {
    const v = value(selector, prop);
    if (v === undefined) throw new Error(`${selector} declares no ${prop} the reader can see`);
    return v;
  };

  // Fix round 2: the reader (`_globals-css.ts`) splits a block on `;`, so a comment glued to a declaration hides it —
  // round 1's stack budget read the card's padding as 0 that way. No sponsor rule's block may hold one.
  it("no .ovl-sponsor* rule block holds a comment (the reader would lose the declaration it is glued to)", () => {
    const sponsor = RULES.filter((r) => r.selector.includes(".ovl-sponsor"));
    expect(sponsor.filter((r) => r.declarations.includes("/*")).map((r) => r.selector)).toEqual([]);
    console.log(`sponsor rule blocks checked: ${sponsor.length}`);
    expect(sponsor.length, "anti-vacuity").toBeGreaterThan(5);
  });

  it("min-width: 0 on the card, its text column and the name — every flex ancestor of the name", () => {
    let checked = 0;
    for (const selector of [".ovl-sponsor-slot", ".ovl-sponsor-card", ".ovl-sponsor-text", ".ovl-sponsor-name", ".ovl-sponsor-link"]) {
      expect(value(selector, "min-width"), selector).toBe("0");
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("the lower third's name ellipsises on one line; the banner's clamps at two", () => {
    expect(value(".ovl-sponsor-name", "white-space")).toBe("nowrap");
    expect(value(".ovl-sponsor-name", "overflow")).toBe("hidden");
    expect(value(".ovl-sponsor-name", "text-overflow")).toBe("ellipsis");
    expect(value('.ovl-sponsor-card[data-style="banner"] .ovl-sponsor-name', "-webkit-line-clamp")).toBe("2");
  });

  it("the slot clips its card (the fold slides out from under its own edge, as the slab's does)", () => {
    expect(value(".ovl-sponsor-slot", "overflow")).toBe("hidden");
    expect(value(".ovl-sponsor-slot", "left")).toBe("var(--ovl-sponsor-x)");
    expect(value(".ovl-sponsor-slot", "width")).toBe("var(--ovl-sponsor-w)");
  });

  // Fix round 1 (m7): the readability floor (spec 2026-10-15 §4.5, D9 — 30 px at 1080), read off EVERY sponsor rule
  // that declares a font-size, and required of each class that carries text, so no text inherits a smaller size.
  it("every .ovl-sponsor-* rule that declares a font-size declares at least 30 px; each text class declares one", () => {
    const FLOOR_PX = 30;
    const sized = RULES.filter((r) => r.selector.includes(".ovl-sponsor") && declaredValue(r, "font-size") !== undefined);
    for (const r of sized) {
      const size = declaredValue(r, "font-size")!;
      expect(size, `${r.selector}: a px size`).toMatch(/^\d+(\.\d+)?px$/);
      expect(parseFloat(size), r.selector).toBeGreaterThanOrEqual(FLOOR_PX);
    }
    for (const text of [".ovl-sponsor-name", ".ovl-sponsor-link", ".ovl-sponsor-mono"]) {
      expect(value(text, "font-size"), `${text} declares its own size`).toBeDefined();
    }
    console.log(`sponsor font-size rules checked: ${sized.length}`);
    expect(sized.length, "anti-vacuity").toBeGreaterThanOrEqual(3);
    // No `font:` shorthand could set a size this reader does not see.
    expect(RULES.filter((r) => r.selector.includes(".ovl-sponsor") && declaredValue(r, "font") !== undefined)).toEqual([]);
  });

  // Fix round 1 (CI check 9): Barlow Condensed's content area is ascent 1000 + descent 200 per 1000 units per em
  // (hhea and OS/2 typo metrics, read from the font file 2026-10-31) = 1.2em. A shorter line-height lets the glyphs out
  // of the line box, the name's `overflow: hidden` clips its descenders, and its scroll box outgrows its client box.
  const BARLOW_CONTENT_EM = (1000 + 200) / 1000;
  it("the name's and the link's line-height holds Barlow's whole content area (1.2em), so no descender is clipped", () => {
    for (const sel of [".ovl-sponsor-name", ".ovl-sponsor-link"]) {
      expect(Number(value(sel, "line-height")), sel).toBeGreaterThanOrEqual(BARLOW_CONTENT_EM);
    }
  });

  it("the lower third's stack fits the SHORTEST declared lower-third slot; the banner's two-line stack the shortest banner", () => {
    const px = (sel: string, prop: string) => parseFloat(need(sel, prop));
    const pad = (sel: string) => {
      const parts = need(sel, "padding").split(/\s+/).map(parseFloat);
      return { top: parts[0]!, bottom: parts[2] ?? parts[0]! };
    };
    const lineOf = (sel: string, nameSel = sel) => px(nameSel, "font-size") * Number(need(sel, "line-height"));
    const slots = Object.values(OVERLAY_TEMPLATES);
    const lowest = Math.min(...slots.map((t) => t.sponsorSlots.lower_third.height));
    const lowestBanner = Math.min(...slots.map((t) => t.sponsorSlots.banner.height));

    const lp = pad(".ovl-sponsor-card");
    const lower = lp.top + lineOf(".ovl-sponsor-name") + px(".ovl-sponsor-text", "gap") + lineOf(".ovl-sponsor-link") + lp.bottom;
    const B = '.ovl-sponsor-card[data-style="banner"]';
    const bp = pad(B);
    const banner =
      bp.top +
      px(`${B} .ovl-sponsor-logo`, "height") +
      px(B, "gap") +
      2 * lineOf(".ovl-sponsor-name") +
      px(`${B} .ovl-sponsor-text`, "gap") +
      lineOf(".ovl-sponsor-link") +
      bp.bottom;
    console.log(`lower third stack ${lower}px in ${lowest}px; banner stack ${banner}px in ${lowestBanner}px (templates: ${slots.length})`);
    expect(slots.length, "anti-vacuity").toBeGreaterThan(0);
    expect(lower).toBeLessThanOrEqual(lowest);
    expect(px(".ovl-sponsor-logo", "height"), "the plate fits too").toBeLessThanOrEqual(lowest - lp.top - lp.bottom);
    expect(banner).toBeLessThanOrEqual(lowestBanner);
  });

  // Fix round 2 (CI check 9's anti-vacuity): whether a name is cut is a property of the FONT and the declared slots, so it
  // is derived here from both — never from the page. The face is the committed Barlow Condensed file at the weight
  // `.ovl-sponsor-name` declares (the build's own face; font-advance.ts). That reader applies no kerning, and kerning
  // only narrows (fontkit, 2026-10-31: 2 px off the 43-character name, 7 px off the witness), so its widths are
  // over-estimates: safe as they stand for "fits"; for "cannot fit" they must clear the column by a margin
  // (CUT_MARGIN, 25%) that dwarfs any kerning.
  it("from the font: the 43-character name fits WHOLE on every slot; the witness (the longest name allowed) fits none", () => {
    const CUT_MARGIN = 1.25;
    const four = (sel: string) => {
      const v = need(sel, "padding").split(/\s+/).map(parseFloat);
      const [top, right = top, bottom = top, left = right] = v;
      return { top: top!, right: right!, bottom: bottom!, left: left! };
    };
    const px = (sel: string, prop: string) => parseFloat(need(sel, prop));
    const NAME = ".ovl-sponsor-name";
    const B = '.ovl-sponsor-card[data-style="banner"]';
    const weight = Number(need(NAME, "font-weight"));
    const FONTS = join(dirname(fileURLToPath(import.meta.url)), "../../../../assets/fonts");
    const face = openFace(join(FONTS, "BarlowCondensed-Bold.ttf"), "Barlow Condensed Bold");
    expect(face.weightClass, "the face the name declares").toBe(weight);
    expect(value(NAME, "font-family"), "premise: the name is set in Barlow").toMatch(/--font-barlow/);
    const size = px(NAME, "font-size");
    const tracking = parseFloat(need(NAME, "letter-spacing")); // em
    expect(need(NAME, "letter-spacing")).toMatch(/em$/);
    const width = (text: string) => textWidth(face, text, size, tracking);
    const space = width(" ");
    /** Lines a greedy word wrap needs at `column` — an over-estimate's own count, so "≤ n" here is "fits in n". */
    const linesAt = (text: string, column: number) => {
      let lines = 1;
      let line = "";
      for (const word of text.split(" ")) {
        const next = line === "" ? word : `${line} ${word}`;
        if (line !== "" && width(next) > column) {
          lines++;
          line = word;
        } else line = next;
      }
      return lines;
    };

    const title = GALLERY_SPONSOR_CARDS[0]!;
    const witness = GALLERY_SPONSOR_CARDS.find((c) => c.id === GALLERY_SPONSOR_WITNESS_ID)!;
    expect([...title.name], "the brief's realistic name").toHaveLength(43);
    // The witness is the longest name an organiser can enter: CreateSponsor takes it, and nothing one character longer.
    expect(CreateSponsor.shape.name.safeParse(witness.name).success).toBe(true);
    expect(CreateSponsor.shape.name.safeParse(`${witness.name}x`).success, "the witness is AT the cap").toBe(false);

    const card = four(".ovl-sponsor-card");
    const banner = four(B);
    const plate = px(".ovl-sponsor-logo", "width");
    expect(px(".ovl-sponsor-mono", "width"), "the monogram is the plate's width too").toBe(plate);
    let checked = 0;
    for (const t of Object.values(OVERLAY_TEMPLATES)) {
      // The lower third: one line, beside the plate. The banner: the panel's width, two lines before the clamp.
      const lowerColumn = t.sponsorSlots.lower_third.width - card.left - card.right - plate - px(".ovl-sponsor-card", "gap");
      const bannerColumn = t.sponsorSlots.banner.width - banner.left - banner.right;
      const clamp = Number(need(`${B} ${NAME}`, "-webkit-line-clamp"));
      expect(width(title.name), `${t.id}: the title fits the lower third whole`).toBeLessThan(lowerColumn);
      expect(linesAt(title.name, bannerColumn), `${t.id}: the title fits the banner in ${clamp} lines`).toBeLessThanOrEqual(clamp);
      expect(width(witness.name), `${t.id}: the witness overflows the lower third`).toBeGreaterThan(CUT_MARGIN * lowerColumn);
      // `clamp` lines hold at most clamp × column of text, plus the spaces their breaks swallow.
      expect(width(witness.name) - (clamp - 1) * space, `${t.id}: the witness needs more than ${clamp} banner lines`).toBeGreaterThan(
        CUT_MARGIN * clamp * bannerColumn,
      );
      console.log(
        `${t.id}: title ${width(title.name).toFixed(1)}px, witness ${width(witness.name).toFixed(1)}px; ` +
          `lower-third column ${lowerColumn}px, banner column ${bannerColumn}px × ${clamp} lines`,
      );
      checked++;
    }
    expect(checked, "anti-vacuity: templates").toBeGreaterThan(0);
  });
});

// ── the carousel's timer ─────────────────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-31T10:00:00.000Z");
let lines: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  lines = [];
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void lines.push(String(a[0])));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const TITLE = card({ id: "card-t", sponsorId: "s-t", name: "Title Co", tier: "title" });
const GOLD = card({ id: "card-g", sponsorId: "s-g", name: "Gold Co", tier: "gold" });
const SILVER = card({ id: "card-s", sponsorId: "s-s", name: "Silver Co", tier: "silver" });
type CarouselProps = Parameters<typeof SponsorCarousel>[0];
const shown = (island: { tree: () => ReactElement[] }) => {
  const view = island.tree().find((el) => el.type === SponsorCardView);
  return view ? (propsOf(view).card as SponsorCard).id : null;
};
const parse = (line: string) => {
  const at = line.indexOf(" ");
  return { prefix: line.slice(0, at), body: JSON.parse(line.slice(at + 1)) as Record<string, unknown> };
};

describe("SponsorCarousel — 10 s each, in carousel order, lines at the compositor only", () => {
  // A fresh memory box per test: the stage's ref, which outlives every carousel mount.
  let base: CarouselProps;
  beforeEach(() => {
    base = { cards: [SILVER, GOLD, TITLE], scene: "starting", host: "compositor", yielding: false, memory: carouselMemoryStore() };
  });

  it("the first card (title) shows at mount, then gold at 10 s, then silver, wrapping — one start and one end each", async () => {
    const island = renderIsland<CarouselProps>(SponsorCarousel, base);
    await vi.advanceTimersByTimeAsync(0);
    const seen: string[] = [shown(island)!];
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(SCENE_CAROUSEL_MS);
      seen.push(shown(island)!);
    }
    expect(seen).toEqual(["card-t", "card-g", "card-s", "card-t"]);
    const parsed = lines.map(parse);
    expect(parsed.map((l) => l.prefix)).toEqual([
      "seazn:sponsor:start",
      "seazn:sponsor:end",
      "seazn:sponsor:start",
      "seazn:sponsor:end",
      "seazn:sponsor:start",
      "seazn:sponsor:end",
      "seazn:sponsor:start",
    ]);
    expect(parsed[0]!.body).toEqual({
      momentId: carouselMomentId("starting", NOW),
      cardId: "card-t",
      style: "banner",
      source: "scene",
      breakKind: null,
      at: new Date(NOW).toISOString(),
    });
    expect(parsed[1]!.body).toEqual({ momentId: carouselMomentId("starting", NOW), at: new Date(NOW + SCENE_CAROUSEL_MS).toISOString(), cutShort: false });
  });

  it("a re-render with the same cards (a fresh array every poll) is not a new showing", async () => {
    const island = renderIsland<CarouselProps>(SponsorCarousel, base);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      island.rerender({ ...base, cards: [...base.cards] });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(lines).toHaveLength(1);
    expect(shown(island)).toBe("card-t");
  });

  it("yielding hides the card and ends its showing cut short; the next card follows once the moment leaves", async () => {
    const island = renderIsland<CarouselProps>(SponsorCarousel, base);
    await vi.advanceTimersByTimeAsync(3_000);
    island.rerender({ ...base, yielding: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(island), "nothing while a moment is on air").toBeNull();
    expect(lines.map(parse).map((l) => [l.prefix, l.body.cutShort])).toEqual([
      ["seazn:sponsor:start", undefined],
      ["seazn:sponsor:end", true],
    ]);
    await vi.advanceTimersByTimeAsync(4_000);
    island.rerender({ ...base, yielding: false });
    await vi.advanceTimersByTimeAsync(SCENE_CAROUSEL_MS);
    expect(shown(island)).toBe("card-g");
    expect(lines.filter((l) => l.startsWith("seazn:sponsor:start"))).toHaveLength(2);
  });

  it("no host (a preview, an OBS page): it still rotates, and logs nothing", async () => {
    const island = renderIsland<CarouselProps>(SponsorCarousel, { ...base, host: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(island)).toBe("card-t");
    await vi.advanceTimersByTimeAsync(SCENE_CAROUSEL_MS);
    expect(shown(island)).toBe("card-g");
    expect(lines).toEqual([]);
  });

  it("the empty case: no cards — nothing drawn, nothing logged, no timer armed", async () => {
    const island = renderIsland<CarouselProps>(SponsorCarousel, { ...base, cards: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(island.tree().filter((el) => el.type === SponsorCardView)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * SCENE_CAROUSEL_MS);
    expect(lines).toEqual([]);
  });

  it("the scene ends mid-showing (unmount): one end, cut short", async () => {
    const island = renderIsland<CarouselProps>(SponsorCarousel, base);
    await vi.advanceTimersByTimeAsync(4_000);
    island.unmount();
    expect(lines.map(parse).map((l) => [l.prefix, l.body.cutShort])).toEqual([
      ["seazn:sponsor:start", undefined],
      ["seazn:sponsor:end", true],
    ]);
  });

  it("unmount with no host, or with nothing showing, logs nothing", async () => {
    const quiet = renderIsland<CarouselProps>(SponsorCarousel, { ...base, host: null });
    await vi.advanceTimersByTimeAsync(4_000);
    quiet.unmount();
    const empty = renderIsland<CarouselProps>(SponsorCarousel, { ...base, cards: [] });
    await vi.advanceTimersByTimeAsync(0);
    empty.unmount();
    expect(lines).toEqual([]);
  });
});

describe("fix round 1, I1 — the rotation survives a remount (the stage keeps its memory)", () => {
  it("unmount at 12 s, remount at 15 s (same memory): no start before 20 s, then the NEXT card (silver, not the title); every id distinct", async () => {
    const memory = carouselMemoryStore();
    const props: CarouselProps = { cards: [SILVER, GOLD, TITLE], scene: "reconnecting", host: "compositor", yielding: false, memory };
    const first = renderIsland<CarouselProps>(SponsorCarousel, props);
    await vi.advanceTimersByTimeAsync(12_000); // title 0–10 s, gold from 10 s
    expect(shown(first)).toBe("card-g");
    first.unmount();
    await vi.advanceTimersByTimeAsync(3_000);
    const second = renderIsland<CarouselProps>(SponsorCarousel, props);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(second), "15 s: still inside gold's bucket — nothing starts").toBeNull();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(shown(second), "19.999 s").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(shown(second), "20 s: the rotation goes on").toBe("card-s");
    const starts = lines.map(parse).filter((l) => l.prefix === "seazn:sponsor:start");
    expect(starts.map((l) => l.body.cardId)).toEqual(["card-t", "card-g", "card-s"]);
    expect(new Set(starts.map((l) => l.body.momentId)).size, "three showings, three ids").toBe(3);
    const ends = lines.map(parse).filter((l) => l.prefix === "seazn:sponsor:end");
    expect(ends.map((l) => [l.body.momentId, l.body.cutShort])).toEqual([
      [starts[0]!.body.momentId, false],
      [starts[1]!.body.momentId, true], // the unmount cut gold
    ]);
  });

  it("the empty case: a first mount with the initial memory starts the title at once", async () => {
    const island = renderIsland<CarouselProps>(SponsorCarousel, {
      cards: [GOLD, TITLE],
      scene: "starting",
      host: null,
      yielding: false,
      memory: carouselMemoryStore(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(island)).toBe("card-t");
  });
});

describe("fix round 1, m2 — a line sponsorLine refuses is dropped at the emit site, warned once, never thrown", () => {
  it("two cards whose start bodies are over 512 bytes: no line for either, ONE warning, the overlay keeps rotating, the next card logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const LONG_T = card({ id: `t${"x".repeat(600)}`, sponsorId: "s-lt", name: "Long Title", tier: "title" });
    const LONG_G = card({ id: `g${"x".repeat(600)}`, sponsorId: "s-lg", name: "Long Gold", tier: "gold" });
    const island = renderIsland<CarouselProps>(SponsorCarousel, {
      cards: [LONG_T, LONG_G, SILVER],
      scene: "starting",
      host: "compositor",
      yielding: false,
      memory: carouselMemoryStore(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(island), "the card still shows").toBe(LONG_T.id);
    await vi.advanceTimersByTimeAsync(SCENE_CAROUSEL_MS);
    expect(shown(island)).toBe(LONG_G.id);
    await vi.advanceTimersByTimeAsync(SCENE_CAROUSEL_MS);
    expect(shown(island)).toBe("card-s");
    expect(warn, "one warning for the mount").toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("sponsor proof-of-play line was dropped");
    // No start was logged for either long card, so no end either: the only line is silver's start.
    expect(lines.map(parse).map((l) => [l.prefix, l.body.cardId])).toEqual([["seazn:sponsor:start", "card-s"]]);
    island.unmount();
    expect(lines.map(parse).map((l) => l.prefix)).toEqual(["seazn:sponsor:start", "seazn:sponsor:end"]);
  });
});
