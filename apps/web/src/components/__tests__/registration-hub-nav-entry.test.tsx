// RS004 W2 — the competition overview's "Registration" nav entry. A dumb
// presentational component (matches CompetitionPassEntry's convention: the
// page resolves i18n strings and hands them down as props, never a dict).
// The live counts (open divisions, registered, awaiting) are proven by the
// wiring test in c/[compSlug]/__tests__/registration-nav-entry-wiring.test.tsx
// — this file only proves the component renders what it is given.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistrationHubNavEntry } from "@/components/registration-hub-nav-entry";
import { routes } from "@/lib/routes";

const DETAILS = ["2 divisions open", "11 confirmed", "3 awaiting confirmation"];

/** Rendered TEXT, tags and attributes stripped. Needed because the breakdown
 *  legitimately appears inside `aria-label`, and a raw-markup `not.toContain`
 *  would read that as "still on the button". */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function render(
  props: Partial<Parameters<typeof RegistrationHubNavEntry>[0]> = {},
): string {
  return renderToStaticMarkup(
    <RegistrationHubNavEntry
      href={routes.competitionRegistration("acme", "summer-smash")}
      label="Registration"
      ariaLabel="Registration — 2 divisions open, 11 confirmed, 3 awaiting confirmation"
      count="14"
      details={DETAILS}
      awaiting
      {...props}
    />,
  );
}

describe("RegistrationHubNavEntry", () => {
  it("links to the href it is given", () => {
    expect(render()).toContain(
      `href="${routes.competitionRegistration("acme", "summer-smash")}"`,
    );
  });

  it("puts ONE number on the button, not the whole breakdown", () => {
    const html = render();
    const button = textOf(html.slice(0, html.indexOf("data-registration-hub-tooltip")));
    expect(button).toContain("Registration");
    expect(button).toContain("14");
    // The counts that used to be spelled out in filled pills are not on the
    // button any more — that is the whole point of the 2026-08-25 change.
    expect(button).not.toContain("divisions open");
    expect(button).not.toContain("confirmed");
  });

  it("renders every detail line in the tooltip", () => {
    const html = render();
    expect(html).toContain("data-registration-hub-tooltip");
    for (const line of DETAILS) expect(html).toContain(line);
  });

  it("hides the tooltip from assistive tech, because the link's own name carries it", () => {
    const html = render();
    // Both, and in this order: a tooltip a screen reader could reach would be
    // read twice, and one it cannot reach with nothing in the accessible name
    // would be a breakdown only a mouse can get at.
    expect(html).toMatch(/role="tooltip"[^>]*aria-hidden/);
    expect(html).toContain(
      'aria-label="Registration — 2 divisions open, 11 confirmed, 3 awaiting confirmation"',
    );
  });

  it("reveals the tooltip on hover AND on keyboard focus", () => {
    const html = render();
    expect(html).toContain("group-hover:block");
    expect(html).toContain("group-focus-within:block");
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    expect(render()).toContain("data-registration-hub-entry");
  });

  it("renders the amber dot when something is waiting on the organiser", () => {
    expect(render()).toContain("data-registration-hub-awaiting");
  });

  it("renders no dot (not a zero, not a grey one) when nothing is outstanding", () => {
    const html = render({
      awaiting: false,
      details: DETAILS.slice(0, 2),
      ariaLabel: "Registration — 2 divisions open, 11 confirmed",
    });
    expect(html).not.toContain("data-registration-hub-awaiting");
    expect(html).not.toContain("awaiting confirmation");
  });

  it("renders no tooltip at all when it is given no detail lines", () => {
    expect(render({ details: [] })).not.toContain(
      "data-registration-hub-tooltip",
    );
  });
});
