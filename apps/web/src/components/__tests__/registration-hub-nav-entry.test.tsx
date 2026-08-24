// RS004 W2 — the competition overview's "Registration" nav entry. A dumb
// presentational component (matches CompetitionPassEntry's convention: the
// page resolves i18n strings and hands them down as props, never a dict).
// The live counts (open divisions, total registered) are proven by the
// wiring test in c/[compSlug]/__tests__/registration-nav-entry-wiring.test.tsx
// — this file only proves the component renders what it is given.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistrationHubNavEntry } from "@/components/registration-hub-nav-entry";

function render(): string {
  return renderToStaticMarkup(
    <RegistrationHubNavEntry
      href="/o/acme/c/summer-smash/registration"
      label="Registration"
      ariaLabel="Registration"
      openBadge="2 divisions open"
      registeredBadge="14 registrants"
    />,
  );
}

describe("RegistrationHubNavEntry", () => {
  it("links to the href it is given", () => {
    expect(render()).toContain('href="/o/acme/c/summer-smash/registration"');
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
});
