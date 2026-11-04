// Spectator W2, Task 15 — the org home page: its competitions list is ONE
// client island (`OrgLiveChips`) whose chips start from the server's in-play
// count, and its dates are printed in the ORG's language.
//
// The page is an async server component: it is called with its data doors
// mocked, and the tree it returns is rendered to static markup (the island
// renders its first paint — the server's — under `renderToStaticMarkup`).
// Expected copy is read from the dictionaries and expected dates from `Intl`,
// never typed here. Negative checks are written against the English VALUE
// only where it differs from the locale's own (nl/fr share words with en).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const getPublicOrg = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: (...a: unknown[]) => getPublicOrg(...a),
}));
const publicPosts = vi.fn();
vi.mock("@/server/usecases/org-posts", () => ({
  publicPosts: (...a: unknown[]) => publicPosts(...a),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => {}) }));
vi.mock("@/lib/prose", () => ({ renderProse: vi.fn(async (h: string) => h) }));

import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { orgLiveDict } from "@/lib/hub-dict";
import { OrgLiveChips, type OrgLiveChipsProps } from "@/components/public-site/org-live-chips";
import OrgLandingPage from "../page";

const DICTS = { en, es, fr, nl } as Record<string, Dict>;
const DATE_OPTS: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

/** What the page must print for a calendar day in a locale: UTC, that locale. */
const dayIn = (locale: string, iso: string) =>
  new Date(iso).toLocaleDateString(locale, { ...DATE_OPTS, timeZone: "UTC" });

/** React's text escaping, so a dictionary value can be looked for in markup. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function competition(id: string, status: string, inPlay: number, startsOn: string | null, endsOn: string | null) {
  return {
    id,
    org_id: "o1",
    name: `Comp ${id}`,
    slug: `comp-${id}`,
    description: null,
    starts_on: startsOn,
    ends_on: endsOn,
    branding: {},
    status,
    visibility: "public" as const,
    in_play: inPlay,
  };
}

const THREE = [
  // `published` with a match being played: the W0 defect's exact shape.
  competition("live", "published", 1, "2026-09-01", "2026-09-13"),
  competition("soon", "published", 0, "2026-10-04", null),
  competition("done", "completed", 0, null, null),
];

async function render(
  locale: string,
  competitions = THREE,
  posts: { id: string; slug: string; title: string; kind: string; publishedAt: string }[] = [],
) {
  getPublicOrg.mockResolvedValue({
    org: {
      id: "o1",
      name: "Test Org",
      slug: "test-org",
      branded: false,
      branding: {},
      logo: null,
      about: null,
      default_locale: locale,
    },
    competitions,
  });
  publicPosts.mockResolvedValue({ posts, total: posts.length });
  const tree = (await OrgLandingPage({ params: Promise.resolve({ orgSlug: "test-org" }) })) as ReactElement;
  return { tree, html: renderToStaticMarkup(tree) };
}

/** Every element of `type` in a tree the page RETURNED (children and every
 *  other prop — nothing is rendered, so the island's props are what the page
 *  handed it). */
function elementsOf(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) elementsOf(n, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  for (const value of Object.values(node.props as Record<string, unknown>)) elementsOf(value as ReactNode, type, out);
  return out;
}

describe("org home — the competitions list is ONE live island", () => {
  it("EMPTY first: no competitions → the page's own empty sentence, no chip, and the island is not mounted", async () => {
    const { tree, html } = await render("en", []);
    expect(html).toContain(esc(t(en as Dict, "empty")));
    expect(html).not.toContain("mh-org-chip-");
    expect(elementsOf(tree, OrgLiveChips)).toHaveLength(0);
  });

  it("mounts exactly one island, and draws one chip per competition", async () => {
    const { tree, html } = await render("en");
    expect(elementsOf(tree, OrgLiveChips)).toHaveLength(1);
    expect(html.match(/data-testid="mh-org-chip-/g)).toHaveLength(THREE.length);
    for (const c of THREE) expect(html).toContain(`data-testid="mh-org-chip-${c.id}"`);
    // Positive pair for the empty case: the empty sentence is gone.
    expect(html).not.toContain(esc(t(en as Dict, "empty")));
  });

  it("the server's in-play count reaches the first paint: a PUBLISHED competition with a match in play reads ON NOW", async () => {
    const { tree, html } = await render("en");
    expect(html).toMatch(/data-testid="mh-org-chip-live" data-chip="on-now"/);
    // Same status, nothing in play — the pair that shows the count did it.
    expect(html).toMatch(/data-testid="mh-org-chip-soon" data-chip="upcoming"/);
    expect(html).toMatch(/data-testid="mh-org-chip-done" data-chip="finished"/);
    const [island] = elementsOf(tree, OrgLiveChips);
    const handed = (island!.props as OrgLiveChipsProps).competitions;
    expect(handed.map((c) => [c.id, c.status, c.in_play])).toEqual(THREE.map((c) => [c.id, c.status, c.in_play]));
    expect((island!.props as OrgLiveChipsProps).orgSlug).toBe("test-org");
  });

  it("hands the island the chip slice of the dictionary, never the whole thing", async () => {
    const { tree } = await render("es");
    const [island] = elementsOf(tree, OrgLiveChips);
    const dict = (island!.props as OrgLiveChipsProps).dict;
    expect(dict).toEqual(orgLiveDict(es as Dict));
    expect(Object.keys(dict).length).toBeLessThan(Object.keys(es).length);
  });
});

describe("org home — dates in the org's language, on the organiser's calendar day", () => {
  it("en: day-month (en-GB), never the US order bare `en` gives Intl — cards and the news strip (owner ruling 2026-09-16)", async () => {
    const NEWS_AT = "2026-09-14T09:30:00.000Z";
    // Premise, not assumed: the two English renderings really differ for both
    // dates, so the checks below can tell them apart.
    expect(dayIn("en-GB", "2026-09-01")).not.toBe(dayIn("en-US", "2026-09-01"));
    expect(dayIn("en-GB", NEWS_AT)).not.toBe(dayIn("en-US", NEWS_AT));
    const { html } = await render("en", THREE, [
      { id: "p1", slug: "p1", title: "Final report", kind: "report", publishedAt: NEWS_AT },
    ]);
    expect(html).toContain(`${dayIn("en-GB", "2026-09-01")} – ${dayIn("en-GB", "2026-09-13")}`);
    expect(html).toContain(`>${dayIn("en-GB", "2026-10-04")}<`);
    expect(html).toContain(dayIn("en-GB", NEWS_AT));
    for (const us of [dayIn("en-US", "2026-09-01"), dayIn("en-US", "2026-10-04"), dayIn("en-US", NEWS_AT)]) {
      expect(html).not.toContain(us);
    }
  });

  it("es: a competition's range is Spanish, not en-GB", async () => {
    const { html } = await render("es");
    // Premise, not assumed: the two renderings really differ for this date.
    expect(dayIn("es", "2026-09-01")).not.toBe(dayIn("en-GB", "2026-09-01"));
    expect(html).toContain(`${dayIn("es", "2026-09-01")} – ${dayIn("es", "2026-09-13")}`);
    expect(html).not.toContain(dayIn("en-GB", "2026-09-01"));
    // No end date: the start alone, with no dangling dash.
    expect(html).toContain(`>${dayIn("es", "2026-10-04")}<`);
  });

  it("es: the latest-news strip prints its dates in Spanish too", async () => {
    const { html } = await render("es", THREE, [
      { id: "p1", slug: "p1", title: "Final report", kind: "report", publishedAt: "2026-09-14T09:30:00.000Z" },
    ]);
    expect(dayIn("es", "2026-09-14T09:30:00.000Z")).not.toBe(dayIn("en-GB", "2026-09-14T09:30:00.000Z"));
    expect(html).toContain(dayIn("es", "2026-09-14T09:30:00.000Z"));
    expect(html).not.toContain(dayIn("en-GB", "2026-09-14T09:30:00.000Z"));
  });

  it.each(["fr", "nl"])("%s: dates are that locale's own rendering", async (locale) => {
    const { html } = await render(locale);
    expect(html).toContain(`${dayIn(locale, "2026-09-01")} – ${dayIn(locale, "2026-09-13")}`);
  });
});

describe("org home — the chip labels are the org locale's dictionary values", () => {
  it.each(["en", "es", "fr", "nl"])("%s", async (locale) => {
    const dict = DICTS[locale]!;
    const { tree, html } = await render(locale);
    // The label is the pill's own text; the on-now pill carries an empty pulse
    // dot before it, skipped here.
    const chip = (id: string) =>
      html.match(new RegExp(`data-testid="mh-org-chip-${id}"[^>]*>(?:<span[^>]*></span>)?([^<]*)</span>`))?.[1] ??
      "(no chip)";
    // Owner ruling 2026-09-16: a competition with a match in play COUNTS it —
    // "1 live now" — read from the dictionary's own `org.live.one` value, not
    // the bare "On now" a status alone would give.
    const oneLive = (dict["org.live.one"] as string).replace("{count}", "1");
    expect(oneLive, "premise: the count sentence is not the status label").not.toBe(t(dict, "chip.onNow"));
    expect(chip("live")).toBe(esc(oneLive));
    // The island pluralises in the org's locale, so it is handed that locale.
    const [island] = elementsOf(tree, OrgLiveChips);
    expect((island!.props as OrgLiveChipsProps).locale).toBe(locale);
    expect(chip("soon")).toBe(esc(t(dict, "chip.upcoming")));
    expect(chip("done")).toBe(esc(t(dict, "chip.finished")));
    expect(html).toContain(esc(t(dict, "section.competitions")));
    // English is absent only where this locale's word is not also English's.
    const english = t(en as Dict, "chip.upcoming");
    const mine = t(dict, "chip.upcoming");
    if (mine !== english && !mine.includes(english) && !english.includes(mine)) {
      expect(chip("soon")).not.toContain(esc(english));
    }
  });
});
