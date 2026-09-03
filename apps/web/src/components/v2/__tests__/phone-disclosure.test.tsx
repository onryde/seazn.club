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
  it("closed body is a grid carrying h-full and max-md:hidden (fix round 2 item 2: h-full alone on a plain block does not cascade into a content-sized child; a single grid child gets stretch on both axes, which is what actually reaches the card)", () => {
    expect(html).toMatch(/<div class="grid h-full max-md:hidden" id="[^"]*"><p data-role="body">the editor<\/p><\/div>/);
  });
  it("shows the summary and aside in the toggle", () => {
    expect(html).toContain("Home Gallery Badminton");
    expect(html).toContain("Lineup");
  });
  it("the toggle's aria-controls points at the body's own id (review fix: PhoneDisclosure can mount several times per page, so the id must be per-instance via useId(), not a static string)", () => {
    const controls = /data-role="phone-disclosure-toggle"[^>]*aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    const bodyId = /<div class="grid h-full max-md:hidden" id="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBe(bodyId);
  });
});
