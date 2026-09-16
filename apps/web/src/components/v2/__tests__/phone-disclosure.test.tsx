// apps/web/src/components/v2/__tests__/phone-disclosure.test.tsx — spec §3.10
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneDisclosure } from "../phone-disclosure";

const html = renderToStaticMarkup(
  <PhoneDisclosure summary="Home Gallery Badminton" aside="Lineup" showLabel="Show lineup" hideLabel="Hide lineup">
    <p data-role="body">the editor</p>
  </PhoneDisclosure>,
);

describe("PhoneDisclosure", () => {
  it("renders a phone-only toggle, closed, named by showLabel", () => {
    expect(html).toMatch(/<button[^>]*data-role="phone-disclosure-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-role="phone-disclosure-toggle"[^>]*aria-label="Show lineup"/);
    // `\bmd:hidden\b` also matches inside `max-md:hidden` — `-` to `m` is a
    // word boundary in JS regex. Anchored on the trailing `\smd:hidden"` so a
    // future `max-md:hidden` mutation reds instead of passing on inversion.
    expect(html).toMatch(/data-role="phone-disclosure-toggle"[^>]*class="[^"]*\smd:hidden"/);
  });
  it("the outer wrapper carries min-w-0 (fix round 2 item 1: a grid item's default min-content width let the truncating summary render at full width and overflow the page at narrow phone viewports with a realistic entrant name)", () => {
    // Same word-boundary trap: anchored on the trailing `\smin-w-0"` so
    // `max-md:min-w-0` cannot satisfy this assertion either.
    expect(html).toMatch(/<div data-role="phone-disclosure" data-open="false" class="[^"]*\smin-w-0"/);
  });
  it("the outer wrapper is a flex column, not a plain h-full block (fix round 3: h-full here stacked a second height:100% two grid levels deep and undershot the row's real content height by exactly the toggle button's own height once a lineup had real content, painting the overflow onto whatever section followed on the page — confirmed live, phone-disclosure.tsx's own doc)", () => {
    expect(html).toMatch(/<div data-role="phone-disclosure" data-open="false" class="flex flex-col min-w-0">/);
  });
  it("closed body is a grid carrying flex-1 and max-md:hidden (fix round 3 keeps the body's own `grid` — its single child still gets stretch — but replaces its `h-full` with `flex-1` so the OUTER wrapper's flex-column contribution to the two-column grid's row is real content height, not another percentage)", () => {
    expect(html).toMatch(/<div class="grid flex-1 max-md:hidden" id="[^"]*"><p data-role="body">the editor<\/p><\/div>/);
  });
  it("shows the summary and aside in the toggle", () => {
    expect(html).toContain("Home Gallery Badminton");
    expect(html).toContain("Lineup");
  });
  it("the toggle's aria-controls points at the body's own id (review fix: PhoneDisclosure can mount several times per page, so the id must be per-instance via useId(), not a static string)", () => {
    const controls = /data-role="phone-disclosure-toggle"[^>]*aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    const bodyId = /<div class="grid flex-1 max-md:hidden" id="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBe(bodyId);
  });
});

describe("PhoneDisclosure desktopCollapsible (fixture console: fold the lineup once the match starts, every sport)", () => {
  it("startOpen=false renders the toggle WITHOUT md:hidden and the body folded at every width", () => {
    const closedHtml = renderToStaticMarkup(
      <PhoneDisclosure
        summary="Home Lions"
        showLabel="Show lineup"
        hideLabel="Hide lineup"
        desktopCollapsible
        startOpen={false}
      >
        <p data-role="body">the editor</p>
      </PhoneDisclosure>,
    );
    // Same word-boundary trap as the phone-only case above: assert the class
    // attribute does NOT end in `md:hidden` rather than merely NOT containing
    // it, so `max-md:hidden` (still present on nothing here, but a future
    // regression) cannot satisfy a loose check.
    expect(closedHtml).toMatch(/data-role="phone-disclosure-toggle"[^>]*class="[^"]*"/);
    expect(closedHtml).not.toMatch(/data-role="phone-disclosure-toggle"[^>]*class="[^"]*\smd:hidden"/);
    expect(closedHtml).toMatch(/<div class="grid flex-1 hidden" id="[^"]+"><p data-role="body">the editor<\/p><\/div>/);
  });

  it("startOpen=true still renders CLOSED on first paint — the open-at-desktop default is a client-only layout effect, never SSR/hydration state (review fix, PR #782)", () => {
    // A shared `useState(startOpen)` here used to open the lineup editor on
    // PHONE-NARROW widths too (there is no `window` in this render at all —
    // `renderToStaticMarkup` never runs effects — so if `open` ever started
    // `true` for `startOpen=true` it would prove exactly the regression this
    // guards: no width signal available yet, so opening by default here can
    // only mean the two widths share one wrongly-unconditional initial
    // state). `apps/web` vitest is `environment: "node"` (no DOM), so the
    // matchMedia-gated desktop-open effect itself is unit-untestable —
    // covered instead by `mobile.spec.ts`'s tablet-768/834 projects (real
    // `md`-and-up viewports) and this file's own desktop screenshot
    // verification (PR #782 review).
    const html = renderToStaticMarkup(
      <PhoneDisclosure
        summary="Home Lions"
        showLabel="Show lineup"
        hideLabel="Hide lineup"
        desktopCollapsible
        startOpen
      >
        <p data-role="body">the editor</p>
      </PhoneDisclosure>,
    );
    expect(html).toMatch(/data-role="phone-disclosure-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/<div class="grid flex-1 hidden" id="[^"]+"><p data-role="body">the editor<\/p><\/div>/);
  });
});
