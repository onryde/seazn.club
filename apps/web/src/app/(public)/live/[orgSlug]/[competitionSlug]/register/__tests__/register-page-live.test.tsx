// RS006 — register page with open divisions renders the live stepper
// (WHO first), not the closed/"not open" stub. Same renderToStaticMarkup
// pattern as register-page-closed.test.tsx (no jsdom in this workspace):
// the page function is invoked directly and the markup is scanned. Client
// islands (register-stepper.tsx and children) render their FIRST-PASS
// output fine under plain react-dom/server — no jsdom-only API is touched
// during render (sessionStorage access lives inside useEffect, which does
// not run here, matching the SSR/CSR determinism register-stepper.tsx's
// header comment relies on).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
// Polish wave P6: the page mounts the "Have a join code?" field (inside the stepper's first step since wave H, because this comp has an
// open team division), which reads the App Router for its one navigation. No router is mounted under a bare renderToStaticMarkup, so
// it is replaced by an inert one (the field's own behaviour is join-code-entry.test.tsx).
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/server/usecases/registrations", () => ({
  publicRegistrationInfo: async () => ({
    competition: {
      id: "comp-1",
      name: "Summer Smash",
      slug: "summer-smash",
      starts_on: "2026-09-15",
      ends_on: null,
    },
    org: { name: "Riverside CC", slug: "riverside", logo_url: null },
    divisions: [
      {
        division_id: "div-1",
        name: "Open Singles",
        slug: "open-singles",
        sport_key: "generic",
        entrant_kind: "individual",
        fee_cents: 1000,
        currency: "gbp",
        payment_method: "offline",
        opens_at: null,
        closes_at: null,
        capacity: 16,
        remaining: 4,
        taken: 12,
        open: true,
        closed_reason: null,
        category: null,
        age_min: null,
        age_max: null,
        allow_free_agents: false,
        requires_dob: false,
        requires_gender: false,
        youth: false,
        waitlisted: 0,
        form_fields: [],
      },
      {
        division_id: "div-2",
        name: "Mixed Doubles",
        slug: "mixed-doubles",
        sport_key: "generic",
        entrant_kind: "team",
        fee_cents: 2000,
        currency: "gbp",
        payment_method: "stripe",
        opens_at: null,
        closes_at: null,
        capacity: null,
        remaining: null,
        taken: 5,
        open: true,
        closed_reason: null,
        category: "mixed",
        age_min: null,
        age_max: null,
        allow_free_agents: true,
        requires_dob: false,
        requires_gender: true,
        youth: false,
        waitlisted: 0,
        form_fields: [],
      },
    ],
  }),
}));

import RegisterPage from "../page";

const render = async (join?: string): Promise<string> =>
  renderToStaticMarkup(
    await RegisterPage({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
      searchParams: Promise.resolve(join ? { join } : {}),
    }),
  );

describe("register page (live — open divisions)", () => {
  it("renders the stepper shell, not the closed message", async () => {
    const html = await render();
    expect(html).not.toContain("Registration is not open for this competition.");
    // The old registration submission form stays gone (RS001). The one <form> on the open page is the "Have a join code?" field
    // (polish wave P6), so the guard counts forms instead of banning the tag: a second one would be a submission form coming back.
    expect(html).not.toContain('data-testid="register-form"');
    expect(html.match(/<form/g) ?? []).toHaveLength(1);
    expect(html).toContain('data-testid="register-join-code"');
  });

  it("offers the join-code field above the stepper, so a teammate with a code sees it before the first step", async () => {
    const html = await render();
    const field = html.indexOf('data-testid="register-join-code"');
    const stepper = html.indexOf('id="reg-who-name"');
    expect(field).toBeGreaterThan(-1);
    expect(stepper).toBeGreaterThan(-1);
    expect(field).toBeLessThan(stepper);
    expect(html).toContain("Have a join code?");
  });

  it("shows the WHO step first — name/email fields, no division cards yet", async () => {
    const html = await render();
    expect(html).toContain('id="reg-who-name"');
    expect(html).toContain('id="reg-who-email"');
    expect(html).not.toContain("Open Singles");
    expect(html).not.toContain("Mixed Doubles");
  });

  it("does not crash with a ?join= param present, and carries it as a data attribute (RS007 seam)", async () => {
    const html = await render("ABC123");
    expect(html).toContain('data-join-code="ABC123"');
  });

  it("the step rail shows both Who and Entries (two open divisions — no collapse; uppercase is CSS text-transform, not literal content)", async () => {
    const html = await render();
    expect(html).toMatch(/>Who</);
    expect(html).toMatch(/>Entries</);
  });
});
