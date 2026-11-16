// /live, rendered: in-play matches on top, upcoming public competitions below, and "start your own" when nothing is on.
// It replaces /discover, so nothing on it may link there.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import type { DiscoveryEntry, DiscoveryLiveFixture } from "@/server/public-site/discovery";
import { h1Of, renderPage, sectionOrder, textOf } from "../../product/__tests__/_render";

const live = vi.fn<() => Promise<DiscoveryLiveFixture[]>>();
const directory = vi.fn<(f: { status?: string }, limit?: number) => Promise<DiscoveryEntry[]>>();
vi.mock("@/server/public-site/discovery", () => ({ getDiscoveryLiveAll: () => live(), getDiscoveryDirectory: (f: { status?: string }, n?: number) => directory(f, n) }));
vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh: () => {} }) }));

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const { default: Page } = await import("../page");
const plain = (s: string) => s.replace(/\*/g, "");

const fx = (n: number): DiscoveryLiveFixture => ({ id: `f${n}`, sport_key: "cricket", headline: `14${n}/3 (12.4)`, strength: null, competition_name: `Harbour Cup ${n}`, org_slug: "harbour", comp_slug: `cup-${n}`, division_slug: "a" });
const comp = (n: number): DiscoveryEntry => ({
  id: `c${n}`, name: `Spring Open ${n}`, slug: `spring-open-${n}`, starts_on: "2027-03-01", ends_on: null, status: "published", city: "Leigh", country: "GB",
  tagline: null, hero_image_path: null, featured: false, org_name: "Leigh Club", org_slug: "leigh", sports: ["tennis"], entrant_count: 16, in_play_count: 0, next_fixture_at: null,
});

beforeEach(() => {
  live.mockReset();
  directory.mockReset();
});

describe("/live", () => {
  it("with matches in play and competitions coming up: the wall, then the list, then the closing call", async () => {
    live.mockResolvedValue([fx(1), fx(2)]);
    directory.mockResolvedValue([comp(1), comp(2), comp(3)]);
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "wall", "upcoming", "closing"]);
    expect(html.split("<h1")).toHaveLength(2);
    expect(h1Of(html)).toBe(plain(en["live.h1"]));
    expect(html).toContain("/live/harbour/cup-2/a/fixtures/f2");
    expect(html).toContain("141/3 (12.4)");
    for (const n of [1, 2, 3]) expect(html).toContain(`/live/leigh/spring-open-${n}`);
    // It asks the directory for upcoming competitions only: in-play ones are already on the wall.
    expect(directory).toHaveBeenCalledTimes(1);
    expect(directory.mock.calls[0]![0]).toEqual({ status: "upcoming" });
    // With something live, the wall does not also pitch "start your own" inside itself.
    expect(html).not.toContain('data-testid="live-start"');
  });

  it("with nothing in play: says so, shows the start-your-own banner, and still lists what is coming up", async () => {
    live.mockResolvedValue([]);
    directory.mockResolvedValue([comp(1)]);
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "wall", "upcoming", "closing"]);
    const wall = html.slice(html.indexOf('data-section="wall"'), html.indexOf('data-section="upcoming"'));
    expect(textOf(wall)).toContain(en["live.wall.emptyTitle"]);
    expect(wall).toContain('data-testid="live-start"');
    expect(textOf(wall)).toContain(en["live.start.title"]);
    expect(wall).toContain('href="/en/start"');
    expect(html).toContain("/live/leigh/spring-open-1");
  });

  it("with nothing at all: no empty list section, just the banner and the closing call", async () => {
    live.mockResolvedValue([]);
    directory.mockResolvedValue([]);
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "wall", "closing"]);
    expect(html).toContain('data-testid="live-start"');
  });

  it("a failing data source is an empty page, never an error page", async () => {
    live.mockRejectedValue(new Error("db down"));
    directory.mockRejectedValue(new Error("db down"));
    const html = await renderPage(Page, { lang: "en" });
    expect(sectionOrder(html)).toEqual(["hero", "wall", "closing"]);
  });

  it.each(LOCALES.map((l) => [l]))("%s: both states read in the locale, with no raw key, and never link to /discover", async (lang) => {
    for (const fixtures of [[fx(1)], []]) {
      live.mockResolvedValue(fixtures);
      directory.mockResolvedValue([comp(1)]);
      const html = await renderPage(Page, { lang });
      const text = textOf(html);
      expect(h1Of(html)).toBe(plain(DICTS[lang]!["live.h1"]!));
      expect(text).toContain(DICTS[lang]!["live.upcoming.title"]!);
      expect(text).not.toMatch(/\b(live|discover|discovery|product)\.[a-zA-Z]+[a-zA-Z0-9.]*\b/);
      expect(text).not.toMatch(/\{[a-z]+\}/);
      expect(text).not.toContain("*");
      expect(html).not.toContain("/discover");
    }
  });

  it("an unknown locale is a 404", async () => {
    await expect(renderPage(Page, { lang: "de" })).rejects.toThrow("NOT_FOUND");
  });
});
