// Register page — closed state (RS001 registration demolition).
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

// Fix wave finding #1: `divisions` (usecases/registrations/) is filtered on
// rs.enabled ONLY — a division can be enabled but window-closed or
// payments-unavailable, so `divisions.length === 0` alone let an
// all-closed competition fall through to the LIVE stepper (stranded on
// ENTRIES behind a generic "add an entry" error, never told registration
// had closed). Both the zero-division case AND the "present but all
// closed" case must render this SAME closed stub — parameterized over both
// (vi.resetModules + a fresh vi.doMock per case, since the divisions array
// differs) rather than duplicating the whole file.
const ALL_CLOSED_DIVISION = {
  division_id: "div-1",
  name: "Open Singles",
  slug: "open-singles",
  sport_key: "generic",
  entrant_kind: "individual",
  fee_cents: 1000,
  currency: "gbp",
  payment_method: "offline",
  opens_at: null,
  closes_at: "2026-01-01T00:00:00.000Z",
  capacity: null,
  remaining: null,
  taken: 0,
  open: false,
  closed_reason: "window",
  category: null,
  age_min: null,
  age_max: null,
  allow_free_agents: false,
  requires_dob: false,
  requires_gender: false,
  youth: false,
  waitlisted: 0,
  form_fields: [],
};

describe.each([
  { label: "zero divisions", divisions: [] as unknown[] },
  { label: "one or more divisions, ALL window-closed", divisions: [ALL_CLOSED_DIVISION] },
])("register page (closed state) — $label", ({ divisions }) => {
  const render = async (): Promise<string> => {
    vi.resetModules();
    vi.doMock("@/server/usecases/registrations", () => ({
      publicRegistrationInfo: async () => ({
        competition: {
          id: "comp-1",
          name: "Summer Smash",
          slug: "summer-smash",
          starts_on: null,
          ends_on: null,
        },
        org: { name: "Riverside CC", slug: "riverside", logo_url: null },
        divisions,
      }),
    }));
    const { default: RegisterPage } = await import("../page");
    return renderToStaticMarkup(
      await RegisterPage({
        params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
        searchParams: Promise.resolve({}),
      }),
    );
  };

  it("shows the closed/not-open message, not a registration form", async () => {
    const html = await render();
    expect(html).toContain("Registration is not open for this competition.");
    // The regression guard: no old (or new) submission form ships here.
    expect(html).not.toContain("<form");
    expect(html).not.toContain('data-testid="register-form"');
    // Nothing is open to join either: the "Have a join code?" field belongs to the open page only (polish wave P6).
    expect(html).not.toContain('data-testid="register-join-code"');
  });

  it("still renders a real page shell (title + competition breadcrumb), not a bare string", async () => {
    const html = await render();
    expect(html).toContain("Summer Smash");
    expect(html).toMatch(/<h1[^>]*>Register<\/h1>/);
  });
});

// Walk-fix F5 (walkthrough R17): a competition whose only division takes card payments, with Connect unable to charge, said only
// "Registration is not open for this competition." - nothing about why, or that it will open. Now the page says the reason in the
// dictionary's words; a competition closed for any OTHER reason keeps the plain line (the describe above).
describe("register page (closed state) — every division closed, one for card payments (walk-fix F5)", () => {
  const CARD_CLOSED = { ...ALL_CLOSED_DIVISION, division_id: "div-2", payment_method: "stripe", closes_at: null, closed_reason: "payments_unavailable" };
  const render = async (divisions: unknown[]): Promise<string> => {
    vi.resetModules();
    vi.doMock("@/server/usecases/registrations", () => ({
      publicRegistrationInfo: async () => ({
        competition: { id: "comp-1", name: "Summer Smash", slug: "summer-smash", starts_on: null, ends_on: null },
        org: { name: "Riverside CC", slug: "riverside", logo_url: null },
        divisions,
      }),
    }));
    const { default: RegisterPage } = await import("../page");
    return renderToStaticMarkup(
      await RegisterPage({
        params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
        searchParams: Promise.resolve({}),
      }),
    );
  };
  const EN = async () => (await import("@/dictionaries/en/ui.json")).default as Record<string, string>;
  const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

  it("says card payments are not set up and registration opens once they are, instead of the bare not-open line", async () => {
    const en = await EN();
    let checked = 0;
    for (const divisions of [[CARD_CLOSED], [CARD_CLOSED, ALL_CLOSED_DIVISION]]) {
      const html = unescape(await render(divisions));
      expect(html, `${divisions.length} division(s)`).toContain(en["register.cardPaymentsUnavailable"]);
      expect(html).not.toContain(en["register.notOpen"]);
      expect(html).not.toContain("<form");
      checked++;
    }
    expect(checked).toBe(2);
  });

  // Walk-fix A review m3: `payments_unavailable` is ONE reason for two causes - Connect cannot charge, or the plan's paid-registration
  // entitlement is gone (cardPaymentsBroken, spec #9 / P2-10). "Finishes payment setup" was false for the second, so the sentence on
  // both public surfaces names neither cause's remedy. English only: the words checked are English (the other locales' parity is
  // i18n:check's job, and each was rewritten in the same commit).
  it("the card-payments sentence names neither cause's remedy: no 'set up' / 'setup' on the register page or the public hub", async () => {
    const en = await EN();
    const pub = (await import("@/dictionaries/en/public.json")).default as Record<string, string>;
    let checked = 0;
    for (const [where, sentence] of [["register page", en["register.cardPaymentsUnavailable"]], ["public hub", pub["info.registration.cardPaymentsUnavailable"]]] as const) {
      expect(sentence, `${where}: premise`).toBeTruthy();
      expect(sentence, where).not.toMatch(/set ?up/i);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("negative pair: window-closed alone keeps the plain not-open line and no card-payments sentence", async () => {
    const en = await EN();
    const html = unescape(await render([ALL_CLOSED_DIVISION]));
    expect(html).toContain(en["register.notOpen"]);
    expect(html).not.toContain(en["register.cardPaymentsUnavailable"]);
  });
});
