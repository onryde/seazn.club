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

import GamesPage from "../page";

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
    expect(html).toMatch(/href="\/"[^>]*>\s*Powered by/);
    expect(html).toContain("Seazn Club");
  });
});
