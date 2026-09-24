import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// MarketingShell nests two async server components (nav's getCurrentUser,
// footer's getDictionary) that would thenable-leak into react-dom/server —
// same passthrough-mock pattern as discover/__tests__/page.test.tsx, but
// this stub also surfaces the props GamesPage passes it as data attributes
// so this test can assert on them without a full render.
vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({
    children,
    hideBackButton,
  }: {
    children: React.ReactNode;
    hideBackButton?: boolean;
  }) => <div data-hide-back-button={String(!!hideBackButton)}>{children}</div>,
}));

// One coming-soon game appended to the REAL registry, so the listing's
// non-link branch is exercised (today every registered game is live, which
// would leave that branch rendering nothing and every assertion on it vacuous).
// Everything else — the live games, their order, their copy — is the real data.
// vi.hoisted: the vi.mock factory below is hoisted above every const.
const { COMING_SOON } = vi.hoisted(() => ({
  COMING_SOON: {
    slug: "coming-soon-probe",
    title: "Probe Puzzle",
    tagline: "A game that is not out yet.",
    description: "Not out yet.",
    thumbnail: "🧩",
    status: "coming-soon" as const,
  },
}));
vi.mock("@/games/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/games/registry")>();
  const GAMES = [...real.GAMES, COMING_SOON];
  return {
    ...real,
    GAMES,
    getGame: (slug: string) => GAMES.find((g) => g.slug === slug),
    liveGames: () => GAMES.filter((g) => g.status === "live"),
  };
});

import GamesPage, { metadata } from "../page";
import { GAMES, liveGames } from "@/games/registry";

// 2026-08-27 feedback: the shared BackButton (browser-history-back) landed
// back in chess-quest when reached via its own "← Games" link — /games is a
// top-level page and doesn't need "back" at all, so it opts out. And the
// per-game "Powered by Seazn Club" attribution that /games/[slug] already
// shows was missing from the listing itself; added here to match.
describe("GamesPage — back-button opt-out + Powered by attribution", () => {
  it("opts out of the shared BackButton", () => {
    const html = renderToStaticMarkup(<GamesPage />);
    expect(html).toContain('data-hide-back-button="true"');
  });

  it("shows a Powered by Seazn Club link back to home", () => {
    const html = renderToStaticMarkup(<GamesPage />);
    expect(html).toMatch(/href="https?:\/\/[^"]+\/"[^>]*>\s*Powered by/);
    expect(html).toContain("Seazn Club");
  });

  // Review 2026-08-27: on the games.* subdomain, proxy.ts's gamesHostRewrite
  // sends a relative href="/" straight back to /games — a dead loop, never
  // reaching the marketing home. The link must be absolute (siteOrigin()),
  // never a bare "/", so it actually escapes the subdomain.
  it("the Powered by link is absolute, never a bare relative \"/\" (games.* subdomain dead-loop)", () => {
    const html = renderToStaticMarkup(<GamesPage />);
    expect(html).not.toMatch(/href="\/"[^>]*>\s*Powered by/);
  });
});

// Review 2026-08-27: Metadata objects merge per-segment, and a SHALLOW merge
// at that -- since this page defines its own openGraph key, the root
// layout's openGraph (type/siteName only, no title/description) is REPLACED
// here, not merged with it. Without its own openGraph.title/description,
// sharing this page (e.g. a link back from Daily Word's share text) showed
// no page-specific preview card at all.
describe("GamesPage metadata — Open Graph", () => {
  it("sets openGraph title/description matching the page's own title/description", () => {
    expect(metadata.openGraph?.title).toBe(metadata.title);
    expect(metadata.openGraph?.description).toBe(metadata.description);
  });

  it("sets an openGraph url", () => {
    expect(metadata.openGraph?.url).toBe("/games");
  });

  // The page's openGraph object must NOT own an `images` key — not even an
  // empty one. Next applies a segment's file-based opengraph-image only when
  // that level's openGraph lacks `images` (resolve-metadata.js,
  // mergeStaticMetadata: `!source.openGraph.hasOwnProperty('images')`), so an
  // `images: []` here would silently drop games/opengraph-image.tsx from the
  // <head> while every other test stayed green.
  it("leaves openGraph.images unset, so games/opengraph-image.tsx supplies og:image", () => {
    expect(Object.hasOwn(metadata.openGraph ?? {}, "images")).toBe(false);
  });

  it("the description promises no ads, like the hero", () => {
    expect(metadata.description).toMatch(/no ads/i);
  });
});

/** The markup of the card whose opening tag carries `href="/games/<slug>"`. */
function cardFor(html: string, slug: string): string {
  const open = html.indexOf(`href="/games/${slug}"`);
  expect(open, `no card links to /games/${slug}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<a", open);
  return html.slice(start, html.indexOf("</a>", open) + 4);
}

// Option A (owner-approved mockups, games-canvas gen.py a_card): each live
// game is ONE link — art panel on top, then title, tagline and a pill CTA.
describe("GamesPage — Option A cards", () => {
  it("premise: there are live games to check, and one coming-soon game", () => {
    expect(liveGames().length).toBeGreaterThan(0);
    expect(GAMES.filter((g) => g.status === "coming-soon")).toHaveLength(1);
  });

  it("the hero subline promises no install, no sign-up and no ads", () => {
    const html = renderToStaticMarkup(<GamesPage />);
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Free games in your browser — pick one and play. No install, no sign-up, no ads.",
    );
  });

  it('the subline never breaks inside "sign-up" (the hyphen is a line-break opportunity)', () => {
    const html = renderToStaticMarkup(<GamesPage />);
    expect(html).toMatch(/<span class="whitespace-nowrap">no sign-up,<\/span>/);
  });

  // The pill reads "Play →", but the arrow is decoration: aria-hidden, so the
  // card link is not announced as "… Play right arrow". Its text content is
  // still "Play →" — what e2e/games.spec.ts's card.getByText("Play →") matches.
  const CTA = 'Play <span aria-hidden="true">→</span></span>';

  for (const game of liveGames()) {
    it(`${game.slug}: one link holding its own art, title, tagline and the "Play →" pill`, () => {
      const card = cardFor(renderToStaticMarkup(<GamesPage />), game.slug);
      expect(card).toContain(`data-game-art="${game.slug}"`);
      expect(card).not.toContain("data-game-art-fallback=");
      expect(card).toContain(`>${game.title}</h2>`);
      expect(card).toContain(`>${game.tagline}</p>`);
      expect(card).toContain(`>${CTA}`);
      // Its text, tags stripped, is exactly "Play →" (what getByText sees).
      const pill = card.slice(card.lastIndexOf("<span", card.indexOf(`>${CTA}`)), card.indexOf(`>${CTA}`) + CTA.length + 1);
      expect(pill.replace(/<[^>]+>/g, "")).toBe("Play →");
      // inline-flex drops the space between "Play" and the arrow (two flex
      // items; measured in Chromium): the gap draws it instead.
      expect(pill).toMatch(/^<span class="[^"]*\binline-flex\b[^"]*\sgap-1\s/);
      // Nothing else in the card hides from assistive tech but the art and the arrow.
      expect(card.match(/aria-hidden="true"/g)).toHaveLength(3);
      // …and exactly one card per game: no second link to the same game.
      const html = renderToStaticMarkup(<GamesPage />);
      expect(html.split(`href="/games/${game.slug}"`)).toHaveLength(2);
    });
  }

  it("no other game's art leaks into a card (the art follows the card's own slug)", () => {
    const html = renderToStaticMarkup(<GamesPage />);
    for (const game of liveGames()) {
      const card = cardFor(html, game.slug);
      const slugs = [...card.matchAll(/data-game-art="([^"]+)"/g)].map((m) => m[1]);
      expect(slugs.length).toBeGreaterThan(0);
      expect(new Set(slugs)).toEqual(new Set([game.slug]));
    }
  });

  it("the art sits above the title, and the CTA below the tagline", () => {
    const html = renderToStaticMarkup(<GamesPage />);
    for (const game of liveGames()) {
      const card = cardFor(html, game.slug);
      const art = card.indexOf("data-game-art=");
      const title = card.indexOf(`>${game.title}</h2>`);
      const tagline = card.indexOf(`>${game.tagline}</p>`);
      const cta = card.indexOf(`>${CTA}`);
      expect(art).toBeGreaterThan(-1);
      expect(art).toBeLessThan(title);
      expect(title).toBeLessThan(tagline);
      expect(tagline).toBeLessThan(cta);
    }
  });

  it("a coming-soon game is a dashed, non-link card with a badge and its thumbnail on the fallback art", () => {
    const html = renderToStaticMarkup(<GamesPage />);
    expect(html).not.toContain(`href="/games/${COMING_SOON.slug}"`);
    const at = html.indexOf(`data-game-art="${COMING_SOON.slug}"`);
    expect(at).toBeGreaterThan(-1);
    const start = html.lastIndexOf('<div class="', html.lastIndexOf("border-dashed", at));
    const card = html.slice(start, html.indexOf("Coming soon", at) + "Coming soon".length);
    expect(card).toContain("border-dashed");
    expect(card).not.toContain("<a ");
    expect(card).toContain('data-game-art-fallback="true"');
    expect(card).toContain(COMING_SOON.thumbnail);
    expect(card).toContain(`>${COMING_SOON.title}</h2>`);
    expect(card).not.toContain(">Play ");
  });
});
