import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      <MarketingMobileNav links={LINKS} openLabel="Open menu" closeLabel="Close menu" />,
    );
    expect(html).toContain("md:hidden");
    expect(html).toContain('aria-label="Open menu"');
  });

  it("every nav link is present in the initial markup, not only after a client-side open", () => {
    const html = renderToStaticMarkup(
      <MarketingMobileNav links={LINKS} openLabel="Open menu" closeLabel="Close menu" />,
    );
    for (const l of LINKS) {
      expect(html).toContain(`href="${l.href}"`);
      expect(html).toContain(l.label);
    }
  });

  it("the panel starts closed (aria-hidden, not focusable) — it only becomes reachable/visible via the hamburger, it isn't a second always-visible nav", () => {
    const html = renderToStaticMarkup(
      <MarketingMobileNav links={LINKS} openLabel="Open menu" closeLabel="Close menu" />,
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
    const props = { links: LINKS, openLabel: "Open menu", closeLabel: "Close menu" };
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

// Sign-off 2026-11-12 (/play at 320, scrolled): a night-scroll page's bar turns solid (white) once the hero leaves, but the
// menu button kept the cream it was given at render, so the icon nearly vanished on the light bar. The same on the home
// page. The bar's chrome is a CLASS that NavScrollFlip flips on the header (mk-nav-night <-> mk-nav-solid); the button
// must follow that class through the stylesheet, never carry a colour fixed at render. Node env, no cascade here: the
// button's classes and the stylesheet's rules are read as a source contract; the browser check is the sign-off shot.
describe("MarketingMobileNav — the menu icon follows the bar's live chrome", () => {
  const CSS = readFileSync(join(__dirname, "..", "..", "..", "app", "globals.css"), "utf8");
  /** The colour one rule declares for `selector`, as written. */
  const declared = (selector: string, prop: "color" | "background"): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    const m = new RegExp(`(?:^|})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(CSS);
    expect(m, `no rule for ${selector}`).not.toBeNull();
    const v = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(m![1]!)?.[1]?.trim();
    expect(v, `${selector} declares no ${prop}`).toBeDefined();
    return v!;
  };
  const varOf = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(CSS)?.[1] ?? "";
  type RGBA = [number, number, number, number];
  const parse = (c: string): RGBA => {
    const v = /^var\(--([\w-]+)\)$/.exec(c);
    if (v) return parse(varOf(v[1]!));
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
    if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16), 1];
    const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(c);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    throw new Error(`unparsed colour ${c}`);
  };
  const over = ([r, g, b, a]: RGBA, [R, G, B]: RGBA): RGBA => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
  // WCAG 2.2 relative luminance and contrast ratio.
  const lum = ([r, g, b]: RGBA) =>
    [r, g, b].map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i]!, 0);
  const contrast = (a: RGBA, b: RGBA) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it("the button carries the nav's menu class and no text colour of its own (the header's class decides it)", () => {
    const cls = /<button[^>]*class="([^"]*)"/.exec(renderToStaticMarkup(<MarketingMobileNav links={LINKS} openLabel="Open menu" closeLabel="Close menu" />))?.[1];
    expect(cls, "the button renders").toBeDefined();
    expect(cls!.split(/\s+/)).toContain("mk-nav-menu");
    expect(cls, "a colour fixed at render cannot follow the scroll flip").not.toMatch(/(?:^|\s)(?:hover:)?(?:text|bg)-(?:cream|slate|white|purple)/);
  });

  it("the stylesheet colours the icon for both states, each at least 3:1 against its bar (WCAG 1.4.11, non-text)", () => {
    expect(varOf("mk-night"), "the night ground is declared").toMatch(/^#/);
    const night = parse(varOf("mk-night"));
    // The solid bar is translucent white; the worst ground under it is the night page (/play, the home's lower half).
    const solidBar = over(parse(declared(".mk-nav-solid", "background")), night);
    const cases: [string, RGBA][] = [
      [".mk-nav-solid .mk-nav-menu", solidBar],
      // Over the hero the bar is transparent: the night ground itself.
      [".mk-nav-night .mk-nav-menu", night],
    ];
    let checked = 0;
    for (const [selector, ground] of cases) {
      const ink = over(parse(declared(selector, "color")), ground);
      expect(contrast(ink, ground), selector).toBeGreaterThanOrEqual(3);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
