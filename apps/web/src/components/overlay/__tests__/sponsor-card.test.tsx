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
import { SponsorCardView, SponsorCarousel, carouselMomentId } from "../sponsor-card";

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
  const base: CarouselProps = { cards: [SILVER, GOLD, TITLE], scene: "starting", host: "compositor", yielding: false };

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
