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

import GamesPage, { metadata } from "../page";

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
});
