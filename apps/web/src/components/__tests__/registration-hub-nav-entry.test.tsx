// RS004 W2 — the competition overview's "Registration" nav entry. A dumb
// presentational component (matches CompetitionPassEntry's convention: the
// page resolves i18n strings and hands them down as props, never a dict).
// The live counts (open divisions, total registered) are proven by the
// wiring test in c/[compSlug]/__tests__/registration-nav-entry-wiring.test.tsx
// — this file only proves the component renders what it is given.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistrationHubNavEntry } from "@/components/registration-hub-nav-entry";
import { routes } from "@/lib/routes";

function render(awaitingBadge?: string): string {
  return renderToStaticMarkup(
    <RegistrationHubNavEntry
      href={routes.competitionRegistration("acme", "summer-smash")}
      label="Registration"
      ariaLabel="Registration"
      openBadge="2 divisions open"
      registeredBadge="14 registrants"
      awaitingBadge={awaitingBadge}
    />,
  );
}

describe("RegistrationHubNavEntry", () => {
  it("links to the href it is given", () => {
    expect(render()).toContain(
      `href="${routes.competitionRegistration("acme", "summer-smash")}"`,
    );
  });

  it("renders the label and both live-count badges it is given", () => {
    const html = render();
    expect(html).toContain("Registration");
    expect(html).toContain("2 divisions open");
    expect(html).toContain("14 registrants");
  });

  it("carries an accessible name", () => {
    expect(render()).toContain('aria-label="Registration"');
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    expect(render()).toContain("data-registration-hub-entry");
  });

  it("renders a third badge when awaitingBadge is given (RS004 W2b review finding 1's distinct pending/waitlisted signal)", () => {
    const html = render("3 awaiting confirmation");
    expect(html).toContain("3 awaiting confirmation");
    expect(html).toContain("data-registration-hub-awaiting");
  });

  it("renders no third badge (not even at zero) when awaitingBadge is omitted", () => {
    expect(render(undefined)).not.toContain("data-registration-hub-awaiting");
  });
});
