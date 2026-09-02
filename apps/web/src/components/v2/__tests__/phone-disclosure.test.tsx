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
    expect(html).toMatch(/data-role="phone-disclosure-toggle"[^>]*class="[^"]*\bmd:hidden\b/);
  });
  it("the outer wrapper carries min-w-0 (fix round 2 item 1: a grid item's default min-content width let the truncating summary render at full width and overflow the page at narrow phone viewports with a realistic entrant name)", () => {
    expect(html).toMatch(/<div data-role="phone-disclosure" data-open="false" class="[^"]*\bmin-w-0\b/);
  });
  it("closed body is a grid carrying h-full and max-md:hidden (fix round 2 item 2: h-full alone on a plain block does not cascade into a content-sized child; a single grid child gets stretch on both axes, which is what actually reaches the card)", () => {
    expect(html).toMatch(/<div class="grid h-full max-md:hidden"><p data-role="body">the editor<\/p><\/div>/);
  });
  it("shows the summary and aside in the toggle", () => {
    expect(html).toContain("Home Gallery Badminton");
    expect(html).toContain("Lineup");
  });
});
