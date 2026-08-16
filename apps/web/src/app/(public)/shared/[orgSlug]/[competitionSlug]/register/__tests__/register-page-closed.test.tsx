// Register page — closed state (RS001 registration demolition, #588).
//
// The old single-entry form + endpoint are deleted; this page now renders
// the design's "registration intentionally down until RS006" state
// unconditionally. Rendered through react-dom/server (no jsdom in this
// workspace — same pattern as org-home-pass-menu.test.tsx): the page function
// is invoked directly with mocked usecases and the markup is scanned.
//
// This is the regression net for the demolition itself: without it, a
// revert (accidental or a bad merge) that brings back <RegisterForm> here
// would ship the old form pointed at a schema that no longer has the
// columns it inserts into — and nothing else in this session's scope would
// catch that at unit level.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/server/usecases/registrations", () => ({
  publicRegistrationInfo: async () => ({
    competition: {
      id: "comp-1",
      name: "Summer Smash",
      slug: "summer-smash",
      starts_on: null,
      ends_on: null,
    },
    org: { name: "Riverside CC", slug: "riverside", logo_url: null },
    divisions: [],
  }),
}));

import RegisterPage from "../page";

const render = async (): Promise<string> =>
  renderToStaticMarkup(
    await RegisterPage({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
    }),
  );

describe("register page (closed state)", () => {
  it("shows the closed/not-open message, not a registration form", async () => {
    const html = await render();
    expect(html).toContain("Registration is not open for this competition.");
    // The regression guard: no old (or new) submission form ships here.
    expect(html).not.toContain("<form");
    expect(html).not.toContain('data-testid="register-form"');
  });

  it("still renders a real page shell (title + competition breadcrumb), not a bare string", async () => {
    const html = await render();
    expect(html).toContain("Summer Smash");
    expect(html).toMatch(/<h1[^>]*>Register<\/h1>/);
  });
});
