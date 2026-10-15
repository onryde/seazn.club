import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingMobileNav } from "@/components/marketing/mobile-nav";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

// design/fix-ui README.md cross-cutting #3: the marketing header dropped its
// nav links (Formats/Scheduling/Pricing/Use cases) entirely at 390px width —
// `hidden md:inline-flex` with no replacement — so the only way to reach
// those pages on mobile was scrolling to the footer. This adds a hamburger
// whose panel links are always present in the DOM (class-toggled, not
// mounted only after a click), so they're reachable without depending on a
// second round of client JS.
const LINKS = [
  { href: "/formats", label: "Formats" },
  { href: "/scheduling", label: "Scheduling" },
  { href: "/pricing", label: "Pricing" },
  { href: "/use-cases/clubs", label: "Use cases" },
];

describe("MarketingMobileNav", () => {
  it("renders a hamburger button, hidden above md via a Tailwind class, not entirely absent", () => {
    const html = renderToStaticMarkup(
      <MarketingMobileNav links={LINKS} openLabel="Open menu" closeLabel="Close menu" night={false} />,
    );
    expect(html).toContain("md:hidden");
    expect(html).toContain('aria-label="Open menu"');
  });

  it("every nav link is present in the initial markup, not only after a client-side open", () => {
    const html = renderToStaticMarkup(
      <MarketingMobileNav links={LINKS} openLabel="Open menu" closeLabel="Close menu" night={false} />,
    );
    for (const l of LINKS) {
      expect(html).toContain(`href="${l.href}"`);
      expect(html).toContain(l.label);
    }
  });

  it("the panel starts closed (aria-hidden, not focusable) — it only becomes reachable/visible via the hamburger, it isn't a second always-visible nav", () => {
    const html = renderToStaticMarkup(
      <MarketingMobileNav links={LINKS} openLabel="Open menu" closeLabel="Close menu" night={false} />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
  });
});

// ESLint L3: "close on route change" moved from an effect keyed on `links` to a
// render-phase adjustment on the same identity signal. Driven through the
// harness, because the claim is about a SEQUENCE: open, then a navigation
// (fresh `links` from the server parent) closes it, while a re-render with the
// SAME links (any unrelated parent render) must leave it open.
describe("MarketingMobileNav — closes on navigation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("open → re-render with the same links stays open → fresh links (a navigation) closes it", () => {
    // The open panel's outside-click/Escape effect listens on `document`.
    vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
    const props = { links: LINKS, openLabel: "Open menu", closeLabel: "Close menu", night: false };
    const island = renderIsland(MarketingMobileNav, props);
    const toggle = () => island.tree().find((el) => el.type === "button")!;
    expect(propsOf(toggle())["aria-expanded"]).toBe(false);

    (propsOf(toggle()).onClick as () => void)();
    expect(propsOf(toggle())["aria-expanded"]).toBe(true);

    island.rerender({ ...props });
    expect(propsOf(toggle())["aria-expanded"], "same links, no navigation — must stay open").toBe(true);

    island.rerender({ ...props, links: [...LINKS] });
    expect(propsOf(toggle())["aria-expanded"]).toBe(false);
  });
});
